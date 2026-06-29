//! `anki` virtual table module: planner-driven semantic `MATCH` + `similarity()`.
//!
//! v1 storage is in-memory and search is brute-force cosine over stored
//! embeddings (HNSW is a later optimization; see [`crate::hnsw`]). The module is
//! registered from `wasm/anki_extension.c` via [`anki_register_vtab`].
//!
//! Semantics (see `docs/DESIGN.md`):
//! - `TEXT VECTOR` columns store plain text; their embedding is managed here.
//! - `WHERE col MATCH ?` embeds the query and returns rows with cosine
//!   similarity >= [`crate::DEFAULT_SIMILARITY_THRESHOLD`], best-first.
//! - `similarity(col)` returns the current row's cosine similarity for the
//!   active `MATCH`, or `NULL` when there is no `MATCH`.
#![allow(non_camel_case_types, non_snake_case, private_interfaces)]

use crate::embedder::Embedder;
use crate::hnsw::Hnsw;
use crate::match_query::{parse_match, Mode};
use crate::metrics;
use crate::{DEFAULT_SIMILARITY_THRESHOLD, HNSW_CANDIDATE_CAP};
use core::cmp::Ordering;
use std::collections::BTreeMap;
use std::ffi::{CStr, CString};
use std::mem::transmute;
use std::os::raw::{c_char, c_int, c_void};
use std::{ptr, slice};

/// Name of the virtual table module: `CREATE VIRTUAL TABLE ... USING anki(...)`.
pub const MODULE_NAME: &str = "anki";

// --- minimal SQLite C ABI ----------------------------------------------------

enum sqlite3 {}
enum sqlite3_context {}
enum sqlite3_value {}
enum sqlite3_stmt {}

type sqlite3_int64 = i64;
type SqliteDestructor = Option<unsafe extern "C" fn(*mut c_void)>;
type ScalarFn = unsafe extern "C" fn(*mut sqlite3_context, c_int, *mut *mut sqlite3_value);

const SQLITE_OK: c_int = 0;
const SQLITE_ERROR: c_int = 1;
const SQLITE_UTF8: c_int = 1;

const SQLITE_INTEGER: c_int = 1;
const SQLITE_FLOAT: c_int = 2;
const SQLITE_TEXT: c_int = 3;
const SQLITE_BLOB: c_int = 4;
const SQLITE_NULL: c_int = 5;

const SQLITE_ROW: c_int = 100;
const SQLITE_DONE: c_int = 101;

// Constraint operators we push down (relational filters) plus MATCH.
const SQLITE_INDEX_CONSTRAINT_EQ: u8 = 2;
const SQLITE_INDEX_CONSTRAINT_GT: u8 = 4;
const SQLITE_INDEX_CONSTRAINT_LE: u8 = 8;
const SQLITE_INDEX_CONSTRAINT_LT: u8 = 16;
const SQLITE_INDEX_CONSTRAINT_GE: u8 = 32;
const SQLITE_INDEX_CONSTRAINT_MATCH: u8 = 64;
const SQLITE_INDEX_CONSTRAINT_NE: u8 = 68;

/// True for the comparison ops we evaluate as a pre-filter.
fn is_filter_op(op: u8) -> bool {
    matches!(
        op,
        SQLITE_INDEX_CONSTRAINT_EQ
            | SQLITE_INDEX_CONSTRAINT_GT
            | SQLITE_INDEX_CONSTRAINT_LE
            | SQLITE_INDEX_CONSTRAINT_LT
            | SQLITE_INDEX_CONSTRAINT_GE
            | SQLITE_INDEX_CONSTRAINT_NE
    )
}

#[repr(C)]
struct sqlite3_vtab {
    pModule: *const sqlite3_module,
    nRef: c_int,
    zErrMsg: *mut c_char,
}

#[repr(C)]
struct sqlite3_vtab_cursor {
    pVtab: *mut sqlite3_vtab,
}

#[repr(C)]
struct sqlite3_index_constraint {
    iColumn: c_int,
    op: u8,
    usable: u8,
    iTermOffset: c_int,
}

#[repr(C)]
struct sqlite3_index_orderby {
    iColumn: c_int,
    desc: u8,
}

#[repr(C)]
struct sqlite3_index_constraint_usage {
    argvIndex: c_int,
    omit: u8,
}

#[repr(C)]
struct sqlite3_index_info {
    nConstraint: c_int,
    aConstraint: *mut sqlite3_index_constraint,
    nOrderBy: c_int,
    aOrderBy: *mut sqlite3_index_orderby,
    aConstraintUsage: *mut sqlite3_index_constraint_usage,
    idxNum: c_int,
    idxStr: *mut c_char,
    needToFreeIdxStr: c_int,
    orderByConsumed: c_int,
    estimatedCost: f64,
    estimatedRows: sqlite3_int64,
    idxFlags: c_int,
    colUsed: u64,
}

type XCreate = unsafe extern "C" fn(
    *mut sqlite3,
    *mut c_void,
    c_int,
    *const *const c_char,
    *mut *mut sqlite3_vtab,
    *mut *mut c_char,
) -> c_int;
type XVtab = unsafe extern "C" fn(*mut sqlite3_vtab) -> c_int;
type XBestIndex = unsafe extern "C" fn(*mut sqlite3_vtab, *mut sqlite3_index_info) -> c_int;
type XOpen = unsafe extern "C" fn(*mut sqlite3_vtab, *mut *mut sqlite3_vtab_cursor) -> c_int;
type XCursor = unsafe extern "C" fn(*mut sqlite3_vtab_cursor) -> c_int;
type XFilter = unsafe extern "C" fn(
    *mut sqlite3_vtab_cursor,
    c_int,
    *const c_char,
    c_int,
    *mut *mut sqlite3_value,
) -> c_int;
type XColumn =
    unsafe extern "C" fn(*mut sqlite3_vtab_cursor, *mut sqlite3_context, c_int) -> c_int;
type XRowid = unsafe extern "C" fn(*mut sqlite3_vtab_cursor, *mut sqlite3_int64) -> c_int;
type XUpdate = unsafe extern "C" fn(
    *mut sqlite3_vtab,
    c_int,
    *mut *mut sqlite3_value,
    *mut sqlite3_int64,
) -> c_int;
type XFindFunction = unsafe extern "C" fn(
    *mut sqlite3_vtab,
    c_int,
    *const c_char,
    *mut Option<ScalarFn>,
    *mut *mut c_void,
) -> c_int;

#[repr(C)]
struct sqlite3_module {
    iVersion: c_int,
    xCreate: Option<XCreate>,
    xConnect: Option<XCreate>,
    xBestIndex: Option<XBestIndex>,
    xDisconnect: Option<XVtab>,
    xDestroy: Option<XVtab>,
    xOpen: Option<XOpen>,
    xClose: Option<XCursor>,
    xFilter: Option<XFilter>,
    xNext: Option<XCursor>,
    xEof: Option<XCursor>,
    xColumn: Option<XColumn>,
    xRowid: Option<XRowid>,
    xUpdate: Option<XUpdate>,
    xBegin: Option<XVtab>,
    xSync: Option<XVtab>,
    xCommit: Option<XVtab>,
    xRollback: Option<XVtab>,
    xFindFunction: Option<XFindFunction>,
    xRename: Option<unsafe extern "C" fn(*mut sqlite3_vtab, *const c_char) -> c_int>,
    xSavepoint: Option<unsafe extern "C" fn(*mut sqlite3_vtab, c_int) -> c_int>,
    xRelease: Option<unsafe extern "C" fn(*mut sqlite3_vtab, c_int) -> c_int>,
    xRollbackTo: Option<unsafe extern "C" fn(*mut sqlite3_vtab, c_int) -> c_int>,
    xShadowName: Option<unsafe extern "C" fn(*const c_char) -> c_int>,
    xIntegrity: Option<
        unsafe extern "C" fn(
            *mut sqlite3_vtab,
            *const c_char,
            *const c_char,
            c_int,
            *mut *mut c_char,
        ) -> c_int,
    >,
}

// Function pointers are `Sync`; the module is immutable shared state.
unsafe impl Sync for sqlite3_module {}

extern "C" {
    fn sqlite3_declare_vtab(db: *mut sqlite3, zSQL: *const c_char) -> c_int;
    fn sqlite3_create_module_v2(
        db: *mut sqlite3,
        zName: *const c_char,
        p: *const sqlite3_module,
        pClientData: *mut c_void,
        xDestroy: Option<unsafe extern "C" fn(*mut c_void)>,
    ) -> c_int;
    fn sqlite3_create_function_v2(
        db: *mut sqlite3,
        zName: *const c_char,
        nArg: c_int,
        eTextRep: c_int,
        pApp: *mut c_void,
        xFunc: Option<ScalarFn>,
        xStep: Option<ScalarFn>,
        xFinal: Option<unsafe extern "C" fn(*mut sqlite3_context)>,
        xDestroy: Option<unsafe extern "C" fn(*mut c_void)>,
    ) -> c_int;
    // The collation SQLite will use for constraint `i` (e.g. "BINARY"/"NOCASE").
    fn sqlite3_vtab_collation(info: *mut sqlite3_index_info, i: c_int) -> *const c_char;

    fn sqlite3_value_type(v: *mut sqlite3_value) -> c_int;
    fn sqlite3_value_int64(v: *mut sqlite3_value) -> sqlite3_int64;
    fn sqlite3_value_double(v: *mut sqlite3_value) -> f64;
    fn sqlite3_value_text(v: *mut sqlite3_value) -> *const u8;
    fn sqlite3_value_bytes(v: *mut sqlite3_value) -> c_int;

    fn sqlite3_result_null(ctx: *mut sqlite3_context);
    fn sqlite3_result_int64(ctx: *mut sqlite3_context, v: sqlite3_int64);
    fn sqlite3_result_double(ctx: *mut sqlite3_context, v: f64);
    fn sqlite3_result_text(
        ctx: *mut sqlite3_context,
        z: *const c_char,
        n: c_int,
        d: SqliteDestructor,
    );

    // Persistence: SQL against the shadow data table on the same connection.
    fn sqlite3_exec(
        db: *mut sqlite3,
        sql: *const c_char,
        cb: Option<unsafe extern "C" fn(*mut c_void, c_int, *mut *mut c_char, *mut *mut c_char) -> c_int>,
        arg: *mut c_void,
        errmsg: *mut *mut c_char,
    ) -> c_int;
    fn sqlite3_prepare_v2(
        db: *mut sqlite3,
        sql: *const c_char,
        n_byte: c_int,
        pp_stmt: *mut *mut sqlite3_stmt,
        pz_tail: *mut *const c_char,
    ) -> c_int;
    fn sqlite3_step(stmt: *mut sqlite3_stmt) -> c_int;
    fn sqlite3_finalize(stmt: *mut sqlite3_stmt) -> c_int;

    fn sqlite3_bind_null(stmt: *mut sqlite3_stmt, i: c_int) -> c_int;
    fn sqlite3_bind_int64(stmt: *mut sqlite3_stmt, i: c_int, v: sqlite3_int64) -> c_int;
    fn sqlite3_bind_double(stmt: *mut sqlite3_stmt, i: c_int, v: f64) -> c_int;
    fn sqlite3_bind_text(
        stmt: *mut sqlite3_stmt,
        i: c_int,
        z: *const c_char,
        n: c_int,
        d: SqliteDestructor,
    ) -> c_int;
    fn sqlite3_bind_blob(
        stmt: *mut sqlite3_stmt,
        i: c_int,
        p: *const c_void,
        n: c_int,
        d: SqliteDestructor,
    ) -> c_int;

    fn sqlite3_column_type(stmt: *mut sqlite3_stmt, i: c_int) -> c_int;
    fn sqlite3_column_int64(stmt: *mut sqlite3_stmt, i: c_int) -> sqlite3_int64;
    fn sqlite3_column_double(stmt: *mut sqlite3_stmt, i: c_int) -> f64;
    fn sqlite3_column_text(stmt: *mut sqlite3_stmt, i: c_int) -> *const u8;
    fn sqlite3_column_blob(stmt: *mut sqlite3_stmt, i: c_int) -> *const c_void;
    fn sqlite3_column_bytes(stmt: *mut sqlite3_stmt, i: c_int) -> c_int;

    fn sqlite3_malloc(n: c_int) -> *mut c_void;
}

// --- table state -------------------------------------------------------------

#[derive(Clone)]
enum Cell {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
}

struct ColumnDef {
    name: String,
    decl_type: String,
    is_vector: bool,
}

struct Row {
    cells: Vec<Cell>,
    /// Per-column embedding; `None` for non-vector columns or NULL/empty text.
    embeddings: Vec<Option<Vec<f32>>>,
}

struct TableState {
    columns: Vec<ColumnDef>,
    ncol: usize,
    /// Indices of `TEXT VECTOR` columns (subset of `0..ncol`).
    vector_cols: Vec<usize>,
    rows: BTreeMap<i64, Row>,
    next_rowid: i64,
    /// Connection used to read/write the persistent shadow table.
    db: *mut sqlite3,
    /// Quoted, db-qualified shadow table name, e.g. `"main"."customers_data"`.
    data_table: String,
    /// Set on `xRollback`: the cache may diverge from the rolled-back shadow
    /// table, so reload it lazily at the next `xFilter`.
    dirty: bool,
    /// One HNSW index per column (`Some` only for `TEXT VECTOR` columns).
    indexes: Vec<Option<Hnsw>>,
    /// Set on any write/reload: indexes are stale and rebuilt at the next `MATCH`.
    index_dirty: bool,
}

#[repr(C)]
struct AnkiVtab {
    base: sqlite3_vtab,
    state: *mut TableState,
}

struct MatchRow {
    rowid: i64,
    /// One cosine score per matched column, aligned to `AnkiCursor::match_cols`.
    /// Empty when the scan has no `MATCH`.
    sims: Vec<f32>,
}

#[repr(C)]
struct AnkiCursor {
    base: sqlite3_vtab_cursor,
    vtab: *mut AnkiVtab,
    results: Vec<MatchRow>,
    pos: usize,
    /// Columns with an active `MATCH` (in plan order); empty when none.
    /// `similarity(col)` maps its argument back to one of these.
    match_cols: Vec<usize>,
}

// Single-threaded WASM: the in-flight cursor for `similarity()` resolution.
static mut CURRENT_CURSOR: *mut AnkiCursor = ptr::null_mut();

// --- helpers -----------------------------------------------------------------

fn embed_text(text: &str) -> Option<Vec<f32>> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    match Embedder::global() {
        // embed() times itself and records metrics (it knows the token counts).
        Ok(e) => e.lock().embed(t).ok(),
        Err(_) => None,
    }
}

/// Cosine similarity. Stored and query embeddings are L2-normalized by the
/// embedder, so this is the dot product.
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let mut s = 0.0f32;
    for i in 0..n {
        s += a[i] * b[i];
    }
    s
}

// --- hybrid filter pushdown (relational WHERE + MATCH) -----------------------

/// Text collations we can reproduce exactly in the pre-filter. Any other
/// (custom/user-defined) collation is not pushed down — SQLite evaluates it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Coll {
    Binary,
    Nocase,
    Rtrim,
}

impl Coll {
    fn from_code(c: u8) -> Coll {
        match c {
            1 => Coll::Nocase,
            2 => Coll::Rtrim,
            _ => Coll::Binary,
        }
    }
    fn code(self) -> u8 {
        match self {
            Coll::Binary => 0,
            Coll::Nocase => 1,
            Coll::Rtrim => 2,
        }
    }
}

/// Orders two TEXT values under a reproducible collation, matching SQLite:
/// BINARY = raw bytes; NOCASE = ASCII A–Z folded then bytes; RTRIM = trailing
/// spaces ignored then bytes.
fn collated_cmp(a: &str, b: &str, coll: Coll) -> Ordering {
    match coll {
        Coll::Binary => a.as_bytes().cmp(b.as_bytes()),
        Coll::Nocase => a
            .bytes()
            .map(|c| c.to_ascii_lowercase())
            .cmp(b.bytes().map(|c| c.to_ascii_lowercase())),
        Coll::Rtrim => a.trim_end_matches(' ').as_bytes().cmp(b.trim_end_matches(' ').as_bytes()),
    }
}

/// Exact i64-vs-f64 comparison without the precision loss of `as f64` (which
/// rounds magnitudes above 2^53). Mirrors SQLite's int/float compare; `None`
/// only for NaN.
fn cmp_int_real(x: i64, y: f64) -> Option<Ordering> {
    if y.is_nan() {
        return None;
    }
    if y >= 9223372036854775808.0 {
        return Some(Ordering::Less); // y > i64::MAX
    }
    if y < -9223372036854775808.0 {
        return Some(Ordering::Greater); // y < i64::MIN
    }
    let yf = y.floor(); // finite, within i64 range
    Some(match x.cmp(&(yf as i64)) {
        Ordering::Equal if y > yf => Ordering::Less, // x == floor(y), but y has a fraction
        ord => ord,
    })
}

/// Orders two cells where comparable: numbers numerically (int↔real exact),
/// text under `coll`. Returns `None` for NULL or cross-type pairs ("unknown").
fn cell_partial_cmp(a: &Cell, b: &Cell, coll: Coll) -> Option<Ordering> {
    match (a, b) {
        (Cell::Int(x), Cell::Int(y)) => x.partial_cmp(y),
        (Cell::Real(x), Cell::Real(y)) => x.partial_cmp(y),
        (Cell::Int(x), Cell::Real(y)) => cmp_int_real(*x, *y),
        (Cell::Real(x), Cell::Int(y)) => cmp_int_real(*y, *x).map(Ordering::reverse),
        (Cell::Text(x), Cell::Text(y)) => Some(collated_cmp(x, y, coll)),
        _ => None,
    }
}

/// Whether `cell <op> rhs` holds. Conservative: when the comparison is unknown
/// (NULL / cross-type), returns `true` so the row is KEPT — SQLite re-checks the
/// constraint (we leave `omit = 0`), so a pre-filter only has to narrow, never
/// to be exact. This guarantees completeness.
fn cell_passes(cell: &Cell, op: u8, rhs: &Cell, coll: Coll) -> bool {
    match cell_partial_cmp(cell, rhs, coll) {
        Some(ord) => match op {
            SQLITE_INDEX_CONSTRAINT_EQ => ord == Ordering::Equal,
            SQLITE_INDEX_CONSTRAINT_NE => ord != Ordering::Equal,
            SQLITE_INDEX_CONSTRAINT_LT => ord == Ordering::Less,
            SQLITE_INDEX_CONSTRAINT_LE => ord != Ordering::Greater,
            SQLITE_INDEX_CONSTRAINT_GT => ord == Ordering::Greater,
            SQLITE_INDEX_CONSTRAINT_GE => ord != Ordering::Less,
            _ => true,
        },
        None => true,
    }
}

/// A pushed-down filter: column index, operator, and the `xFilter` argv slot
/// holding the right-hand value.
struct Filter {
    col: usize,
    op: u8,
    slot: usize,
    coll: Coll,
}

/// The plan `xBestIndex` encodes into `idxStr` and `xFilter` parses back:
/// the optional `MATCH` (vector column + argv slot) and the pushed filters.
struct Plan {
    /// All `MATCH`es, as (vector column, argv slot), in plan order.
    matches: Vec<(usize, usize)>,
    filters: Vec<Filter>,
}

/// Sets `idxStr` to a `sqlite3_malloc`-owned copy (SQLite frees it).
unsafe fn set_idx_str(info: &mut sqlite3_index_info, s: &str) {
    let bytes = s.as_bytes();
    let p = sqlite3_malloc((bytes.len() + 1) as c_int) as *mut c_char;
    if p.is_null() {
        return;
    }
    ptr::copy_nonoverlapping(bytes.as_ptr(), p as *mut u8, bytes.len());
    *p.add(bytes.len()) = 0;
    info.idxStr = p;
    info.needToFreeIdxStr = 1;
}

/// Parses the `idxStr` produced by `x_best_index`. Tokens are `;`-joined and in
/// argv order: `m<col>` (MATCH on vector column) or `f<col>,<op>,<coll>` (filter,
/// where `<coll>` is the Coll code for text comparisons).
unsafe fn parse_idx_str(idx_str: *const c_char) -> Plan {
    let mut plan = Plan {
        matches: Vec::new(),
        filters: Vec::new(),
    };
    if idx_str.is_null() {
        return plan;
    }
    let s = match CStr::from_ptr(idx_str).to_str() {
        Ok(s) => s,
        Err(_) => return plan,
    };
    for (slot, tok) in s.split(';').enumerate() {
        if tok.is_empty() {
            continue;
        }
        let (kind, rest) = tok.split_at(1);
        match kind {
            "m" => {
                if let Ok(col) = rest.parse::<usize>() {
                    plan.matches.push((col, slot));
                }
            }
            "f" => {
                let mut it = rest.split(',');
                if let (Some(cs), Some(os)) = (it.next(), it.next()) {
                    if let (Ok(col), Ok(op)) = (cs.parse::<usize>(), os.parse::<u8>()) {
                        let coll = it
                            .next()
                            .and_then(|s| s.parse::<u8>().ok())
                            .map_or(Coll::Binary, Coll::from_code);
                        plan.filters.push(Filter { col, op, slot, coll });
                    }
                }
            }
            _ => {}
        }
    }
    plan
}

fn parse_column(def: &str) -> Option<ColumnDef> {
    let tokens: Vec<&str> = def.split_whitespace().collect();
    if tokens.is_empty() {
        return None;
    }
    let name = tokens[0].trim_matches(|c| c == '"' || c == '`' || c == '[' || c == ']');
    if name.is_empty() {
        return None;
    }
    let is_vector = tokens[1..].iter().any(|t| t.eq_ignore_ascii_case("vector"));
    let decl_type = tokens[1..]
        .iter()
        .filter(|t| !t.eq_ignore_ascii_case("vector"))
        .cloned()
        .collect::<Vec<_>>()
        .join(" ");
    Some(ColumnDef {
        name: name.to_string(),
        decl_type,
        is_vector,
    })
}

fn build_declare(cols: &[ColumnDef]) -> String {
    let body = cols
        .iter()
        .map(|c| {
            if c.decl_type.is_empty() {
                format!("\"{}\"", c.name)
            } else {
                format!("\"{}\" {}", c.name, c.decl_type)
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!("CREATE TABLE x({body})")
}

unsafe fn zeroed_vtab() -> sqlite3_vtab {
    sqlite3_vtab {
        pModule: ptr::null(),
        nRef: 0,
        zErrMsg: ptr::null_mut(),
    }
}

/// Sets `*pz_err` to a `sqlite3_malloc`-owned copy of `msg` (SQLite frees it).
unsafe fn set_err(pz_err: *mut *mut c_char, msg: &str) {
    if pz_err.is_null() {
        return;
    }
    let bytes = msg.as_bytes();
    let p = sqlite3_malloc((bytes.len() + 1) as c_int) as *mut u8;
    if p.is_null() {
        return;
    }
    ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
    *p.add(bytes.len()) = 0;
    *pz_err = p as *mut c_char;
}

/// Quoted, db-qualified `anki_meta` table name (database-wide model metadata).
fn meta_table_ident(db_name: &str) -> String {
    format!("{}.{}", quote_ident(db_name), quote_ident("anki_meta"))
}

/// Records the active model's `(id, dim)` in `anki_meta` (idempotent upsert).
unsafe fn write_meta(db: *mut sqlite3, meta_table: &str, id: &str, dim: usize) -> c_int {
    let ddl = format!(
        "CREATE TABLE IF NOT EXISTS {meta_table}(key TEXT PRIMARY KEY, value TEXT)"
    );
    if exec(db, &ddl) != SQLITE_OK {
        return SQLITE_ERROR;
    }
    let sql = format!("INSERT OR REPLACE INTO {meta_table}(key, value) VALUES('model_id', ?), ('embed_dim', ?)");
    let csql = match CString::new(sql) {
        Ok(c) => c,
        Err(_) => return SQLITE_ERROR,
    };
    let mut stmt: *mut sqlite3_stmt = ptr::null_mut();
    if sqlite3_prepare_v2(db, csql.as_ptr(), -1, &mut stmt, ptr::null_mut()) != SQLITE_OK {
        return SQLITE_ERROR;
    }
    sqlite3_bind_text(
        stmt,
        1,
        id.as_ptr() as *const c_char,
        id.len() as c_int,
        transient(),
    );
    let dim_s = dim.to_string();
    sqlite3_bind_text(
        stmt,
        2,
        dim_s.as_ptr() as *const c_char,
        dim_s.len() as c_int,
        transient(),
    );
    let rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    if rc == SQLITE_DONE {
        SQLITE_OK
    } else {
        SQLITE_ERROR
    }
}

/// Reads `(model_id, dim)` from `anki_meta`, or `None` if absent/incomplete.
unsafe fn read_meta(db: *mut sqlite3, meta_table: &str) -> Option<(String, usize)> {
    let sql = format!("SELECT key, value FROM {meta_table}");
    let csql = CString::new(sql).ok()?;
    let mut stmt: *mut sqlite3_stmt = ptr::null_mut();
    if sqlite3_prepare_v2(db, csql.as_ptr(), -1, &mut stmt, ptr::null_mut()) != SQLITE_OK {
        return None;
    }
    let mut id: Option<String> = None;
    let mut dim: Option<usize> = None;
    while sqlite3_step(stmt) == SQLITE_ROW {
        let key = column_to_cell(stmt, 0);
        let val = column_to_cell(stmt, 1);
        if let (Cell::Text(k), Cell::Text(v)) = (key, val) {
            match k.as_str() {
                "model_id" => id = Some(v),
                "embed_dim" => dim = v.parse::<usize>().ok(),
                _ => {}
            }
        }
    }
    sqlite3_finalize(stmt);
    match (id, dim) {
        (Some(i), Some(d)) => Some((i, d)),
        _ => None,
    }
}

unsafe fn value_to_string(v: *mut sqlite3_value) -> Option<String> {
    if sqlite3_value_type(v) != SQLITE_TEXT {
        return None;
    }
    let n = sqlite3_value_bytes(v);
    if n <= 0 {
        return Some(String::new());
    }
    let p = sqlite3_value_text(v);
    if p.is_null() {
        return None;
    }
    let bytes = slice::from_raw_parts(p, n as usize);
    Some(String::from_utf8_lossy(bytes).into_owned())
}

unsafe fn value_to_cell(v: *mut sqlite3_value) -> Cell {
    match sqlite3_value_type(v) {
        SQLITE_INTEGER => Cell::Int(sqlite3_value_int64(v)),
        SQLITE_FLOAT => Cell::Real(sqlite3_value_double(v)),
        SQLITE_TEXT => Cell::Text(value_to_string(v).unwrap_or_default()),
        _ => Cell::Null,
    }
}

/// `SQLITE_TRANSIENT`: tells SQLite to copy the bound/returned bytes.
fn transient() -> SqliteDestructor {
    unsafe { transmute(-1isize) }
}

unsafe fn result_text(ctx: *mut sqlite3_context, s: &str) {
    let bytes = s.as_bytes();
    sqlite3_result_text(
        ctx,
        bytes.as_ptr() as *const c_char,
        bytes.len() as c_int,
        transient(),
    );
}

// --- persistence (shadow table) ----------------------------------------------

fn quote_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

unsafe fn arg_str(argv: *const *const c_char, i: isize) -> String {
    let p = *argv.offset(i);
    if p.is_null() {
        String::new()
    } else {
        CStr::from_ptr(p).to_string_lossy().into_owned()
    }
}

/// Quoted, db-qualified shadow table name, e.g. `"main"."customers_data"`.
fn data_table_ident(db_name: &str, table: &str) -> String {
    format!(
        "{}.{}",
        quote_ident(db_name),
        quote_ident(&format!("{table}_data"))
    )
}

fn build_ddl(data_table: &str, ncol: usize, vector_cols: &[usize]) -> String {
    let mut defs = vec!["id INTEGER PRIMARY KEY".to_string()];
    for i in 0..ncol {
        defs.push(format!("c{i}"));
    }
    for vi in vector_cols {
        defs.push(format!("e{vi} BLOB"));
    }
    format!("CREATE TABLE IF NOT EXISTS {data_table}({})", defs.join(", "))
}

/// Column list shared by the INSERT and SELECT: `id, c0..c{ncol-1}, e{vi}…`.
fn data_columns(ncol: usize, vector_cols: &[usize]) -> Vec<String> {
    let mut cols = vec!["id".to_string()];
    for i in 0..ncol {
        cols.push(format!("c{i}"));
    }
    for vi in vector_cols {
        cols.push(format!("e{vi}"));
    }
    cols
}

fn emb_to_blob(v: &[f32]) -> Vec<u8> {
    let mut b = Vec::with_capacity(v.len() * 4);
    for x in v {
        b.extend_from_slice(&x.to_le_bytes());
    }
    b
}

fn blob_to_emb(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

unsafe fn exec(db: *mut sqlite3, sql: &str) -> c_int {
    let csql = match CString::new(sql) {
        Ok(c) => c,
        Err(_) => return SQLITE_ERROR,
    };
    sqlite3_exec(db, csql.as_ptr(), None, ptr::null_mut(), ptr::null_mut())
}

unsafe fn bind_cell(stmt: *mut sqlite3_stmt, idx: c_int, cell: &Cell) {
    match cell {
        Cell::Null => {
            sqlite3_bind_null(stmt, idx);
        }
        Cell::Int(v) => {
            sqlite3_bind_int64(stmt, idx, *v);
        }
        Cell::Real(v) => {
            sqlite3_bind_double(stmt, idx, *v);
        }
        Cell::Text(s) => {
            sqlite3_bind_text(
                stmt,
                idx,
                s.as_ptr() as *const c_char,
                s.len() as c_int,
                transient(),
            );
        }
    }
}

unsafe fn column_to_cell(stmt: *mut sqlite3_stmt, idx: c_int) -> Cell {
    match sqlite3_column_type(stmt, idx) {
        SQLITE_INTEGER => Cell::Int(sqlite3_column_int64(stmt, idx)),
        SQLITE_FLOAT => Cell::Real(sqlite3_column_double(stmt, idx)),
        SQLITE_TEXT => {
            let n = sqlite3_column_bytes(stmt, idx);
            let p = sqlite3_column_text(stmt, idx);
            if p.is_null() || n <= 0 {
                Cell::Text(String::new())
            } else {
                let bytes = slice::from_raw_parts(p, n as usize);
                Cell::Text(String::from_utf8_lossy(bytes).into_owned())
            }
        }
        _ => Cell::Null,
    }
}

/// Upserts one row into the shadow table. Embeddings are stored as little-endian
/// `f32` BLOBs in the `e{col}` columns.
unsafe fn persist_row(
    st: &TableState,
    rowid: i64,
    cells: &[Cell],
    embeddings: &[Option<Vec<f32>>],
) -> c_int {
    let cols = data_columns(st.ncol, &st.vector_cols);
    let placeholders = vec!["?"; cols.len()].join(", ");
    let sql = format!(
        "INSERT OR REPLACE INTO {}({}) VALUES({})",
        st.data_table,
        cols.join(", "),
        placeholders
    );
    let csql = match CString::new(sql) {
        Ok(c) => c,
        Err(_) => return SQLITE_ERROR,
    };
    let mut stmt: *mut sqlite3_stmt = ptr::null_mut();
    if sqlite3_prepare_v2(st.db, csql.as_ptr(), -1, &mut stmt, ptr::null_mut()) != SQLITE_OK {
        return SQLITE_ERROR;
    }

    sqlite3_bind_int64(stmt, 1, rowid);
    for i in 0..st.ncol {
        bind_cell(stmt, (2 + i) as c_int, &cells[i]);
    }
    for (k, &vi) in st.vector_cols.iter().enumerate() {
        let idx = (2 + st.ncol + k) as c_int;
        match embeddings.get(vi).and_then(|e| e.as_ref()) {
            Some(e) => {
                let blob = emb_to_blob(e);
                sqlite3_bind_blob(
                    stmt,
                    idx,
                    blob.as_ptr() as *const c_void,
                    blob.len() as c_int,
                    transient(),
                );
            }
            None => {
                sqlite3_bind_null(stmt, idx);
            }
        }
    }

    let rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    if rc == SQLITE_DONE {
        SQLITE_OK
    } else {
        SQLITE_ERROR
    }
}

unsafe fn delete_row(st: &TableState, rowid: i64) -> c_int {
    let sql = format!("DELETE FROM {} WHERE id = ?", st.data_table);
    let csql = match CString::new(sql) {
        Ok(c) => c,
        Err(_) => return SQLITE_ERROR,
    };
    let mut stmt: *mut sqlite3_stmt = ptr::null_mut();
    if sqlite3_prepare_v2(st.db, csql.as_ptr(), -1, &mut stmt, ptr::null_mut()) != SQLITE_OK {
        return SQLITE_ERROR;
    }
    sqlite3_bind_int64(stmt, 1, rowid);
    let rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    if rc == SQLITE_DONE {
        SQLITE_OK
    } else {
        SQLITE_ERROR
    }
}

/// Replaces `st.rows` with the shadow table's contents and resets `next_rowid`.
/// Used both for the initial `xConnect` and to resync after a rollback.
unsafe fn load_all(st: &mut TableState) {
    st.rows.clear();
    st.next_rowid = 1;
    st.dirty = false;
    st.index_dirty = true;
    let cols = data_columns(st.ncol, &st.vector_cols);
    let sql = format!("SELECT {} FROM {} ORDER BY id", cols.join(", "), st.data_table);
    let csql = match CString::new(sql) {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut stmt: *mut sqlite3_stmt = ptr::null_mut();
    if sqlite3_prepare_v2(st.db, csql.as_ptr(), -1, &mut stmt, ptr::null_mut()) != SQLITE_OK {
        return;
    }

    while sqlite3_step(stmt) == SQLITE_ROW {
        let rowid = sqlite3_column_int64(stmt, 0);
        let mut cells = Vec::with_capacity(st.ncol);
        for i in 0..st.ncol {
            cells.push(column_to_cell(stmt, (1 + i) as c_int));
        }
        let mut embeddings: Vec<Option<Vec<f32>>> = vec![None; st.ncol];
        for (k, &vi) in st.vector_cols.iter().enumerate() {
            let idx = (1 + st.ncol + k) as c_int;
            if sqlite3_column_type(stmt, idx) == SQLITE_BLOB {
                let n = sqlite3_column_bytes(stmt, idx);
                let p = sqlite3_column_blob(stmt, idx) as *const u8;
                if !p.is_null() && n > 0 {
                    let bytes = slice::from_raw_parts(p, n as usize);
                    embeddings[vi] = Some(blob_to_emb(bytes));
                }
            }
        }
        if rowid >= st.next_rowid {
            st.next_rowid = rowid + 1;
        }
        st.rows.insert(rowid, Row { cells, embeddings });
    }
    sqlite3_finalize(stmt);
}

/// Parses columns, declares the user-facing schema, and builds an empty state.
/// Shared by `xCreate` and `xConnect`; returns a raw `TableState` on success.
unsafe fn new_state(
    db: *mut sqlite3,
    argc: c_int,
    argv: *const *const c_char,
) -> Option<*mut TableState> {
    let mut columns: Vec<ColumnDef> = Vec::new();
    for i in 3..argc as isize {
        let p = *argv.offset(i);
        if p.is_null() {
            continue;
        }
        let s = CStr::from_ptr(p).to_string_lossy();
        if let Some(cd) = parse_column(&s) {
            columns.push(cd);
        }
    }
    if columns.is_empty() {
        return None;
    }

    let cdecl = CString::new(build_declare(&columns)).ok()?;
    if sqlite3_declare_vtab(db, cdecl.as_ptr()) != SQLITE_OK {
        return None;
    }

    let vector_cols: Vec<usize> = columns
        .iter()
        .enumerate()
        .filter_map(|(i, c)| if c.is_vector { Some(i) } else { None })
        .collect();
    let ncol = columns.len();
    let data_table = data_table_ident(&arg_str(argv, 1), &arg_str(argv, 2));

    Some(Box::into_raw(Box::new(TableState {
        columns,
        ncol,
        vector_cols,
        rows: BTreeMap::new(),
        next_rowid: 1,
        db,
        data_table,
        dirty: false,
        indexes: (0..ncol).map(|_| None).collect(),
        index_dirty: true,
    })))
}

/// Rebuilds one HNSW index per `TEXT VECTOR` column from the in-memory cache.
unsafe fn rebuild_indexes(st: &mut TableState) {
    let t0 = metrics::now_ms();
    let mut indexes: Vec<Option<Hnsw>> = (0..st.ncol).map(|_| None).collect();
    for &ci in &st.vector_cols {
        let points: Vec<(i64, Vec<f32>)> = st
            .rows
            .iter()
            .filter_map(|(rid, row)| {
                row.embeddings
                    .get(ci)
                    .and_then(|e| e.clone())
                    .map(|e| (*rid, e))
            })
            .collect();
        indexes[ci] = Hnsw::build(&points);
    }
    st.indexes = indexes;
    st.index_dirty = false;
    metrics::record_index_rebuild(metrics::now_ms() - t0);
}

/// Brute-force cosine over `rows` for column `col`, pushing rows above the
/// similarity threshold into `results`. With `filter`, only rows passing it are
/// considered (the relational pre-filter). No candidate cap — exact + complete.
/// Returns the number of cosine computations performed (for metrics).
fn exact_scan(
    results: &mut Vec<MatchRow>,
    rows: &BTreeMap<i64, Row>,
    col: usize,
    q: &[f32],
    filter: Option<&dyn Fn(&Row) -> bool>,
) -> usize {
    let mut computed = 0usize;
    for (rowid, row) in rows.iter() {
        if let Some(f) = filter {
            if !f(row) {
                continue;
            }
        }
        if let Some(Some(emb)) = row.embeddings.get(col) {
            computed += 1;
            let sim = cosine(q, emb);
            if sim >= DEFAULT_SIMILARITY_THRESHOLD {
                results.push(MatchRow {
                    rowid: *rowid,
                    sims: vec![sim],
                });
            }
        }
    }
    computed
}

// --- module callbacks --------------------------------------------------------
//
// These are the entry points SQLite calls — *we never call SQLite to "run a
// query"*. This module is a row SOURCE, not a query interceptor: SQLite's
// planner owns the query, and our table is just one input it pulls rows from.
// The query's `WHERE`/`ORDER BY`/`LIMIT` are applied by SQLite to the rows we
// emit; all we control is which rows we emit and in what order.
//
// Lifecycle for a `SELECT ... FROM anki_table WHERE col MATCH ? AND x = ?`:
//   xCreate/xConnect   build per-table state (once per table / per connection)
//   xBestIndex         planning: SQLite offers the WHERE constraints; we say
//                      which we'll handle and how (encoded into idxStr)
//   xOpen              make a cursor for one scan
//   xFilter            start the scan: embed the query, build the result list
//   xEof/xColumn/xNext/xRowid   hand rows back one at a time
//   xClose             done
// `similarity()` (via xFindFunction) reads the current cursor's score; xUpdate
// handles writes. The constraint values (`?`) arrive in xFilter's `argv`.

unsafe extern "C" fn x_create(
    db: *mut sqlite3,
    _aux: *mut c_void,
    argc: c_int,
    argv: *const *const c_char,
    pp_vtab: *mut *mut sqlite3_vtab,
    _err: *mut *mut c_char,
) -> c_int {
    // argv[0]=module, [1]=db, [2]=table, [3..]=column definitions.
    // new_state parses the columns and declares the user-facing schema to SQLite.
    let state = match new_state(db, argc, argv) {
        Some(s) => s, // raw *mut TableState we now own
        None => return SQLITE_ERROR,
    };

    // Create the persistent shadow table (`<name>_data`) backing this vtab.
    let ddl = build_ddl(&(*state).data_table, (*state).ncol, &(*state).vector_cols);
    let rc = exec(db, &ddl);
    if rc != SQLITE_OK {
        drop(Box::from_raw(state)); // reclaim the leaked state on the error path
        return rc;
    }

    // Record the active model so a later reopen with a different model is caught.
    if let Some((id, dim)) = crate::loader::current() {
        let meta = meta_table_ident(&arg_str(argv, 1));
        if write_meta(db, &meta, &id, dim) != SQLITE_OK {
            drop(Box::from_raw(state));
            return SQLITE_ERROR;
        }
    }

    // Hand ownership of the vtab object to SQLite via *pp_vtab; it lives until
    // xDisconnect/xDestroy. The base sqlite3_vtab must be the first field so the
    // pointer can be cast both ways.
    let vt = Box::into_raw(Box::new(AnkiVtab {
        base: zeroed_vtab(),
        state,
    }));
    *pp_vtab = vt as *mut sqlite3_vtab;
    SQLITE_OK
}

unsafe extern "C" fn x_connect(
    db: *mut sqlite3,
    _aux: *mut c_void,
    argc: c_int,
    argv: *const *const c_char,
    pp_vtab: *mut *mut sqlite3_vtab,
    pz_err: *mut *mut c_char,
) -> c_int {
    // Reopen: the shadow table already exists; reload its rows into memory.
    let state = match new_state(db, argc, argv) {
        Some(s) => s,
        None => return SQLITE_ERROR,
    };

    // Guard against opening a table whose stored vectors were built with a
    // different model (incompatible dimension / vector space).
    if let Some((cur_id, cur_dim)) = crate::loader::current() {
        let meta = meta_table_ident(&arg_str(argv, 1));
        if let Some((stored_id, stored_dim)) = read_meta(db, &meta) {
            let id_conflict = !stored_id.is_empty() && !cur_id.is_empty() && stored_id != cur_id;
            if stored_dim != cur_dim || id_conflict {
                set_err(
                    pz_err,
                    &format!(
                        "anki: table built with model '{stored_id}' (dim {stored_dim}), \
                         current model is '{cur_id}' (dim {cur_dim}) — reindex required"
                    ),
                );
                drop(Box::from_raw(state));
                return SQLITE_ERROR;
            }
        }
    }

    load_all(&mut *state);

    let vt = Box::into_raw(Box::new(AnkiVtab {
        base: zeroed_vtab(),
        state,
    }));
    *pp_vtab = vt as *mut sqlite3_vtab;
    SQLITE_OK
}

/// Frees in-memory state but keeps the shadow table (data persists).
unsafe extern "C" fn x_disconnect(vtab: *mut sqlite3_vtab) -> c_int {
    let vt = Box::from_raw(vtab as *mut AnkiVtab);
    drop(Box::from_raw(vt.state));
    drop(vt);
    SQLITE_OK
}

/// `DROP TABLE`: removes the shadow table, then frees state.
unsafe extern "C" fn x_destroy(vtab: *mut sqlite3_vtab) -> c_int {
    let vt = Box::from_raw(vtab as *mut AnkiVtab);
    let st = Box::from_raw(vt.state);
    exec(st.db, &format!("DROP TABLE IF EXISTS {}", st.data_table));
    drop(st);
    drop(vt);
    SQLITE_OK
}

// Transaction hooks. Providing xBegin enrolls the vtab so xCommit/xRollback are
// delivered. Writes go straight to the shadow table (rolled back with the
// connection), so commit needs nothing; rollback only has to invalidate the
// in-memory cache, which is reloaded lazily on the next xFilter.

unsafe extern "C" fn x_begin(_vtab: *mut sqlite3_vtab) -> c_int {
    SQLITE_OK
}

unsafe extern "C" fn x_sync(_vtab: *mut sqlite3_vtab) -> c_int {
    SQLITE_OK
}

unsafe extern "C" fn x_commit(_vtab: *mut sqlite3_vtab) -> c_int {
    SQLITE_OK
}

unsafe extern "C" fn x_rollback(vtab: *mut sqlite3_vtab) -> c_int {
    // The shadow table is reverted by SQLite's pager. Defer the cache reload to
    // the next xFilter, when the rollback is fully settled and a SELECT is safe.
    let vt = &*(vtab as *mut AnkiVtab);
    (*vt.state).dirty = true;
    SQLITE_OK
}

// Savepoint hooks (module v2): SAVEPOINT/RELEASE need no action since writes go
// to the shadow table, but ROLLBACK TO must invalidate the cache like xRollback.

unsafe extern "C" fn x_savepoint(_vtab: *mut sqlite3_vtab, _n: c_int) -> c_int {
    SQLITE_OK
}

unsafe extern "C" fn x_release(_vtab: *mut sqlite3_vtab, _n: c_int) -> c_int {
    SQLITE_OK
}

unsafe extern "C" fn x_rollback_to(vtab: *mut sqlite3_vtab, _n: c_int) -> c_int {
    let vt = &*(vtab as *mut AnkiVtab);
    (*vt.state).dirty = true;
    SQLITE_OK
}

/// Planning callback. SQLite has already decomposed the `WHERE` clause into
/// simple `column OP value` constraints (it cannot offer OR / functions /
/// column-vs-column — those it evaluates itself afterward). For each constraint
/// we either "claim" it (assign an `argvIndex`, so its value is delivered to
/// `xFilter`) or ignore it (SQLite applies it to our output).
///
/// We claim:
///   - `MATCH` on a vector column, with `omit=1` (we fully satisfy it), and
///   - the comparison ops (=,<>,<,<=,>,>=) on any column, with `omit=0` so
///     SQLite still re-checks them — that lets our pre-filter be a conservative
///     narrowing rather than an exact filter.
/// The chosen plan is serialized into `idxStr` (token per claimed constraint,
/// in argv order) for `xFilter` to read back. `estimatedCost` nudges the
/// planner toward the filtered/pre-filter plan.
/// Maps the collation SQLite will use for constraint `i` to a `Coll` we can
/// reproduce, or `None` for a custom collation we must leave to SQLite.
unsafe fn collation_of(info: *mut sqlite3_index_info, i: isize) -> Option<Coll> {
    let p = sqlite3_vtab_collation(info, i as c_int);
    if p.is_null() {
        return Some(Coll::Binary);
    }
    match CStr::from_ptr(p).to_str() {
        Ok(n) if n.eq_ignore_ascii_case("BINARY") => Some(Coll::Binary),
        Ok(n) if n.eq_ignore_ascii_case("NOCASE") => Some(Coll::Nocase),
        Ok(n) if n.eq_ignore_ascii_case("RTRIM") => Some(Coll::Rtrim),
        _ => None,
    }
}

unsafe extern "C" fn x_best_index(vtab: *mut sqlite3_vtab, info: *mut sqlite3_index_info) -> c_int {
    let vt = &*(vtab as *mut AnkiVtab);
    let st = &*vt.state;
    let info_ptr = info;
    let info = &mut *info;
    let ncol = st.columns.len();

    // Walk the offered constraints. `argv_n` is the 1-based slot each claimed
    // constraint's value will occupy in xFilter's argv; we record the same order
    // in `tokens` so xFilter can map argv[k] back to (kind, column, op).
    let mut tokens: Vec<String> = Vec::new();
    let mut argv_n: c_int = 0;
    let mut has_match = false;
    let mut has_filter = false;

    for i in 0..info.nConstraint as isize {
        let c = &*info.aConstraint.offset(i); // i-th constraint SQLite is offering
        if c.usable == 0 {
            continue; // not usable in this plan (e.g. on the wrong side of a join)
        }
        let col = c.iColumn; // which table column this constraint is on
        if col < 0 || (col as usize) >= ncol {
            continue; // rowid (-1) or out of range — we don't push these
        }
        // aConstraintUsage[i] is our reply slot for constraint i.
        let u = &mut *info.aConstraintUsage.offset(i);
        if c.op == SQLITE_INDEX_CONSTRAINT_MATCH && st.columns[col as usize].is_vector {
            // Semantic search on a TEXT VECTOR column. Claim *every* MATCH so
            // `a MATCH x AND b MATCH y` works (SQLite errors if any is left
            // unclaimed); xFilter ANDs them.
            argv_n += 1;
            u.argvIndex = argv_n; // its RHS arrives as xFilter argv[argv_n-1]
            u.omit = 1; // MATCH is fully handled here
            has_match = true;
            tokens.push(format!("m{col}")); // record: argv slot -> MATCH on `col`
        } else if is_filter_op(c.op) {
            // A relational comparison (=,<>,<,<=,>,>=) we can pre-filter on — but
            // only if we can reproduce its collation. For a custom collation we
            // can't replicate, leave it unclaimed so SQLite evaluates it itself
            // (claiming + binary-comparing could wrongly drop rows it would keep).
            let coll = match collation_of(info_ptr, i) {
                Some(c) => c,
                None => continue,
            };
            argv_n += 1;
            u.argvIndex = argv_n;
            u.omit = 0; // SQLite re-checks; pre-filter only narrows
            has_filter = true;
            tokens.push(format!("f{col},{},{}", c.op, coll.code())); // filter: col/op/coll
        }
        // anything else: left unclaimed -> SQLite evaluates it on our output
    }

    // Tell the planner this plan is usable and roughly how cheap it is. Lower =
    // preferred; the filtered/pre-filter plans are cheapest so SQLite picks them.
    info.idxNum = if has_match || has_filter { 1 } else { 0 };
    info.estimatedCost = if has_match {
        // Pre-filtering avoids the post-filter recall cliff; prefer this plan.
        if has_filter {
            1.0
        } else {
            10.0
        }
    } else if has_filter {
        100.0
    } else {
        1.0e9
    };
    if !tokens.is_empty() {
        set_idx_str(info, &tokens.join(";"));
    }
    SQLITE_OK
}

/// Opens a cursor for one scan. The cursor holds the *materialized result list*
/// that `xFilter` will populate; `xNext`/`xEof`/`xColumn`/`xRowid` then walk it.
unsafe extern "C" fn x_open(vtab: *mut sqlite3_vtab, pp: *mut *mut sqlite3_vtab_cursor) -> c_int {
    let cur = Box::into_raw(Box::new(AnkiCursor {
        base: sqlite3_vtab_cursor { pVtab: vtab },
        vtab: vtab as *mut AnkiVtab,
        results: Vec::new(),
        pos: 0,
        match_cols: Vec::new(),
    }));
    *pp = cur as *mut sqlite3_vtab_cursor;
    SQLITE_OK
}

unsafe extern "C" fn x_close(cur: *mut sqlite3_vtab_cursor) -> c_int {
    if CURRENT_CURSOR == cur as *mut AnkiCursor {
        CURRENT_CURSOR = ptr::null_mut();
    }
    drop(Box::from_raw(cur as *mut AnkiCursor));
    SQLITE_OK
}

/// Starts a scan: decodes the plan from `idxStr`, reads the constraint values
/// from `argv`, and builds the cursor's result list. This is where the
/// "filter-first vs MATCH-first" decision lives. Three shapes:
///   1. MATCH + relational filter → PRE-FILTER: rank only rows passing the
///      filter (no candidate cap over the subset → no recall cliff).
///   2. MATCH only → HNSW over the whole table (or exact scan if no index yet).
///   3. no MATCH → a (possibly filtered) plain scan; `similarity()` stays NULL.
/// SQLite re-applies every `WHERE` term to the rows we emit, so correctness does
/// not depend on us getting the filter exactly right — only on emitting a
/// superset of the matching rows.
unsafe extern "C" fn x_filter(
    cur: *mut sqlite3_vtab_cursor,
    _idx_num: c_int,
    idx_str: *const c_char,
    _argc: c_int,
    argv: *mut *mut sqlite3_value,
) -> c_int {
    let c = &mut *(cur as *mut AnkiCursor); // our cursor (subclass of the base)
    let st = &mut *(*c.vtab).state; // the shared per-table state

    // Resync the cache if a prior transaction rolled back the shadow table.
    if st.dirty {
        load_all(st);
    }

    // Reset the cursor for a fresh scan.
    c.results.clear();
    c.pos = 0;
    c.match_cols.clear();

    // Decode the plan x_best_index chose (which argv slots are MATCH vs filters).
    let plan = parse_idx_str(idx_str);

    // Pair each pushed filter with its actual RHS value from argv (e.g. 'active').
    let preds: Vec<(usize, u8, Cell, Coll)> = plan
        .filters
        .iter()
        .map(|f| (f.col, f.op, value_to_cell(*argv.offset(f.slot as isize)), f.coll))
        .collect();
    // A row survives the relational filter iff it satisfies every pushed pred.
    let row_passes = |row: &Row| -> bool {
        preds.iter().all(|(col, op, rhs, coll)| {
            row.cells
                .get(*col)
                .map_or(true, |cell| cell_passes(cell, *op, rhs, *coll))
        })
    };

    if plan.matches.is_empty() {
        // No MATCH: a (possibly filtered) scan. `similarity()` stays NULL.
        for (rowid, row) in st.rows.iter() {
            if row_passes(row) {
                c.results.push(MatchRow { rowid: *rowid, sims: Vec::new() });
            }
        }
    } else {
        // One or more semantic MATCHes. Parse the DSL + embed each query; a NULL
        // or empty query means the (AND'd) result set is empty.
        struct MatchQ {
            col: usize,
            q: Vec<f32>,
            mode: Mode,
            candidates: Option<usize>,
        }
        let mut queries: Vec<MatchQ> = Vec::with_capacity(plan.matches.len());
        for (col, slot) in &plan.matches {
            let raw = value_to_string(*argv.offset(*slot as isize));
            let mq = match raw.as_deref() {
                Some(s) => match parse_match(s) {
                    Ok(mq) => mq,
                    Err(e) => {
                        set_err(&mut (*c.vtab).base.zErrMsg, &format!("anki: {e}"));
                        return SQLITE_ERROR;
                    }
                },
                None => {
                    queries.clear();
                    break;
                }
            };
            match embed_text(&mq.query) {
                Some(q) => queries.push(MatchQ {
                    col: *col,
                    q,
                    mode: mq.mode,
                    candidates: mq.candidates,
                }),
                None => {
                    queries.clear();
                    break;
                }
            }
        }
        c.match_cols = queries.iter().map(|m| m.col).collect();

        if !queries.is_empty() {
            let t_search = metrics::now_ms();
            let mut candidates = 0usize;

            if queries.len() == 1 && preds.is_empty() {
                // Fast path: a single MATCH with no relational filter. `mode`
                // chooses HNSW (approximate) vs exact.
                let m = &queries[0];
                match m.mode {
                    Mode::Hnsw => {
                        if st.index_dirty {
                            rebuild_indexes(st);
                        }
                        let cap = m.candidates.unwrap_or(HNSW_CANDIDATE_CAP);
                        match st.indexes.get(m.col).and_then(|o| o.as_ref()) {
                            Some(idx) => {
                                let k = cap.min(st.rows.len());
                                for (rowid, sim) in idx.search(&m.q, k, cap) {
                                    candidates += 1;
                                    if sim >= DEFAULT_SIMILARITY_THRESHOLD {
                                        c.results.push(MatchRow { rowid, sims: vec![sim] });
                                    }
                                }
                            }
                            None => {
                                candidates = exact_scan(&mut c.results, &st.rows, m.col, &m.q, None)
                            }
                        }
                    }
                    Mode::Exact => {
                        candidates = exact_scan(&mut c.results, &st.rows, m.col, &m.q, None)
                    }
                }
            } else {
                // General path: AND of several MATCHes (and/or a relational
                // filter). Exact-scan the pre-filtered rows; a row qualifies only
                // if EVERY matched column clears the threshold. Keep per-column
                // scores so `similarity(col)` can return each one.
                for (rowid, row) in st.rows.iter() {
                    if !preds.is_empty() && !row_passes(row) {
                        continue;
                    }
                    let mut sims = Vec::with_capacity(queries.len());
                    let mut all = true;
                    for m in &queries {
                        candidates += 1;
                        match row.embeddings.get(m.col).and_then(|e| e.as_ref()) {
                            Some(emb) => {
                                let s = cosine(&m.q, emb);
                                if s < DEFAULT_SIMILARITY_THRESHOLD {
                                    all = false;
                                    break;
                                }
                                sims.push(s);
                            }
                            None => {
                                all = false;
                                break;
                            }
                        }
                    }
                    if all {
                        c.results.push(MatchRow { rowid: *rowid, sims });
                    }
                }
            }

            // Rank by combined relevance (sum of per-column scores); an explicit
            // ORDER BY similarity(col) in the query overrides this.
            c.results.sort_by(|a, b| {
                let sa: f32 = a.sims.iter().sum();
                let sb: f32 = b.sims.iter().sum();
                sb.partial_cmp(&sa).unwrap_or(Ordering::Equal)
            });
            metrics::record_search(metrics::now_ms() - t_search, candidates, c.results.len());
        }
    }

    CURRENT_CURSOR = cur as *mut AnkiCursor;
    SQLITE_OK
}

// Advance to the next result row. We also stash the cursor globally so a
// `similarity()` call evaluated for this row can find its score (see
// similarity_fn / CURRENT_CURSOR).
unsafe extern "C" fn x_next(cur: *mut sqlite3_vtab_cursor) -> c_int {
    let c = &mut *(cur as *mut AnkiCursor);
    c.pos += 1;
    CURRENT_CURSOR = cur as *mut AnkiCursor;
    SQLITE_OK
}

// End-of-scan when we've walked past the last materialized result.
unsafe extern "C" fn x_eof(cur: *mut sqlite3_vtab_cursor) -> c_int {
    let c = &*(cur as *mut AnkiCursor);
    (c.pos >= c.results.len()) as c_int
}

// Return column `i` of the current result row. The result list holds rowids;
// the actual cell values come from the in-memory cache keyed by rowid.
unsafe extern "C" fn x_column(
    cur: *mut sqlite3_vtab_cursor,
    ctx: *mut sqlite3_context,
    i: c_int,
) -> c_int {
    let c = &*(cur as *mut AnkiCursor);
    let vt = &*c.vtab;
    let st = &*vt.state;
    CURRENT_CURSOR = cur as *mut AnkiCursor;

    if c.pos >= c.results.len() {
        sqlite3_result_null(ctx);
        return SQLITE_OK;
    }
    let rowid = c.results[c.pos].rowid;
    match st.rows.get(&rowid).and_then(|r| r.cells.get(i as usize)) {
        Some(Cell::Int(v)) => sqlite3_result_int64(ctx, *v),
        Some(Cell::Real(v)) => sqlite3_result_double(ctx, *v),
        Some(Cell::Text(s)) => result_text(ctx, s),
        _ => sqlite3_result_null(ctx),
    }
    SQLITE_OK
}

// The current row's rowid (our internal id), used by SQLite to join/order.
unsafe extern "C" fn x_rowid(cur: *mut sqlite3_vtab_cursor, p: *mut sqlite3_int64) -> c_int {
    let c = &*(cur as *mut AnkiCursor);
    *p = c.results.get(c.pos).map(|r| r.rowid).unwrap_or(0);
    SQLITE_OK
}

/// All writes (INSERT/UPDATE/DELETE) funnel through here via SQLite's protocol,
/// encoded in `argc`/`argv`:
///   - `argc == 1`            → DELETE the row whose rowid is `argv[0]`.
///   - `argv[0]` is NULL      → INSERT (`argv[1]` = new rowid or NULL; columns
///                              follow in `argv[2..]`).
///   - `argv[0]` non-NULL     → UPDATE the row `argv[0]` (rowid may change to
///                              `argv[1]`).
/// On insert/update we (re-)embed each `TEXT VECTOR` column, write through to
/// the shadow table, update the cache, and mark the HNSW index dirty.
unsafe extern "C" fn x_update(
    vtab: *mut sqlite3_vtab,
    argc: c_int,
    argv: *mut *mut sqlite3_value,
    p_rowid: *mut sqlite3_int64,
) -> c_int {
    let vt = &*(vtab as *mut AnkiVtab);
    let st = &mut *vt.state;

    // DELETE: a single rowid argument.
    if argc == 1 {
        let v = *argv.offset(0);
        if sqlite3_value_type(v) != SQLITE_NULL {
            let id = sqlite3_value_int64(v);
            let rc = delete_row(st, id);
            if rc != SQLITE_OK {
                return rc;
            }
            st.rows.remove(&id);
            st.index_dirty = true;
        }
        return SQLITE_OK;
    }

    // INSERT or UPDATE. argv[0]=old rowid (NULL for insert), argv[1]=new rowid,
    // argv[2..]=the column values in declared order.
    let old = *argv.offset(0);
    let new_rowid_v = *argv.offset(1);
    let ncol = st.ncol;

    // Read the new column values into our Cell representation.
    let mut cells: Vec<Cell> = Vec::with_capacity(ncol);
    for i in 0..ncol {
        cells.push(value_to_cell(*argv.offset(2 + i as isize)));
    }

    // (Re-)embed each TEXT VECTOR column; non-vector or non-text cells get none.
    let mut embeddings: Vec<Option<Vec<f32>>> = Vec::with_capacity(ncol);
    for i in 0..ncol {
        let emb = if st.columns[i].is_vector {
            match &cells[i] {
                Cell::Text(s) => embed_text(s), // None for empty/whitespace text
                _ => None,
            }
        } else {
            None
        };
        embeddings.push(emb);
    }

    let is_insert = sqlite3_value_type(old) == SQLITE_NULL;
    // Use the rowid SQLite supplies, or assign the next one for a bare INSERT.
    let rowid = if sqlite3_value_type(new_rowid_v) != SQLITE_NULL {
        sqlite3_value_int64(new_rowid_v)
    } else {
        st.next_rowid
    };

    // Persist to the shadow table first; only mutate the cache on success so a
    // failed write leaves cache and store consistent.
    let t_persist = metrics::now_ms();
    let rc = persist_row(st, rowid, &cells, &embeddings);
    metrics::record_persist(metrics::now_ms() - t_persist);
    if rc != SQLITE_OK {
        return rc;
    }

    // UPDATE that moves the rowid: drop the old entry first.
    if !is_insert {
        let oldid = sqlite3_value_int64(old);
        if oldid != rowid {
            let _ = delete_row(st, oldid);
            st.rows.remove(&oldid);
        }
    }

    // Update the in-memory cache and bookkeeping (index rebuilt lazily on query).
    st.rows.insert(rowid, Row { cells, embeddings });
    if rowid >= st.next_rowid {
        st.next_rowid = rowid + 1;
    }
    st.index_dirty = true;
    if !p_rowid.is_null() {
        *p_rowid = rowid; // report the rowid SQLite should associate with the row
    }
    SQLITE_OK
}

unsafe extern "C" fn x_find_function(
    _vtab: *mut sqlite3_vtab,
    n_arg: c_int,
    z_name: *const c_char,
    px_func: *mut Option<ScalarFn>,
    pp_arg: *mut *mut c_void,
) -> c_int {
    let name = CStr::from_ptr(z_name).to_bytes();
    if n_arg == 1 && name.eq_ignore_ascii_case(b"similarity") {
        *px_func = Some(similarity_fn);
        *pp_arg = ptr::null_mut();
        return 1;
    }
    0
}

/// `similarity(col)` for the active `MATCH`: returns the current row's cosine
/// similarity, or `NULL` when no `MATCH` is active on the scan.
unsafe extern "C" fn similarity_fn(
    ctx: *mut sqlite3_context,
    argc: c_int,
    argv: *mut *mut sqlite3_value,
) {
    let cur = CURRENT_CURSOR;
    if cur.is_null() {
        sqlite3_result_null(ctx);
        return;
    }
    let c = &*cur;
    if c.match_cols.is_empty() || c.pos >= c.results.len() {
        sqlite3_result_null(ctx);
        return;
    }
    let sims = &c.results[c.pos].sims;
    if sims.is_empty() {
        sqlite3_result_null(ctx);
        return;
    }
    // Single MATCH: the column is unambiguous.
    if c.match_cols.len() == 1 {
        sqlite3_result_double(ctx, sims[0] as f64);
        return;
    }
    // Multiple MATCHes: `similarity(col)` is passed that column's *value* for the
    // current row, so map it back to a matched column by comparing values.
    let arg = if argc >= 1 { value_to_string(*argv) } else { None };
    let st = &*(*c.vtab).state;
    if let Some(row) = st.rows.get(&c.results[c.pos].rowid) {
        for (i, &col) in c.match_cols.iter().enumerate() {
            let cell_text = match row.cells.get(col) {
                Some(Cell::Text(t)) => Some(t.as_str()),
                _ => None,
            };
            if cell_text.is_some() && cell_text == arg.as_deref() {
                sqlite3_result_double(ctx, sims[i] as f64);
                return;
            }
        }
    }
    sqlite3_result_null(ctx);
}

/// Global `similarity(x)` stub: `NULL` outside a `MATCH` context. The vtab
/// overrides this via [`x_find_function`] when the argument is one of its
/// columns.
unsafe extern "C" fn similarity_stub(
    ctx: *mut sqlite3_context,
    _argc: c_int,
    _argv: *mut *mut sqlite3_value,
) {
    sqlite3_result_null(ctx);
}

/// `anki_model()` — id of the loaded model, or `NULL` if none loaded.
unsafe extern "C" fn anki_model_fn(
    ctx: *mut sqlite3_context,
    _argc: c_int,
    _argv: *mut *mut sqlite3_value,
) {
    match crate::loader::current() {
        Some((id, _)) if !id.is_empty() => result_text(ctx, &id),
        _ => sqlite3_result_null(ctx),
    }
}

/// `anki_dim()` — embedding dimension of the loaded model, or `NULL` if none.
unsafe extern "C" fn anki_dim_fn(
    ctx: *mut sqlite3_context,
    _argc: c_int,
    _argv: *mut *mut sqlite3_value,
) {
    match crate::loader::current() {
        Some((_, dim)) => sqlite3_result_int64(ctx, dim as sqlite3_int64),
        None => sqlite3_result_null(ctx),
    }
}

static ANKI_MODULE: sqlite3_module = sqlite3_module {
    iVersion: 2,
    xCreate: Some(x_create),
    xConnect: Some(x_connect),
    xBestIndex: Some(x_best_index),
    xDisconnect: Some(x_disconnect),
    xDestroy: Some(x_destroy),
    xOpen: Some(x_open),
    xClose: Some(x_close),
    xFilter: Some(x_filter),
    xNext: Some(x_next),
    xEof: Some(x_eof),
    xColumn: Some(x_column),
    xRowid: Some(x_rowid),
    xUpdate: Some(x_update),
    xBegin: Some(x_begin),
    xSync: Some(x_sync),
    xCommit: Some(x_commit),
    xRollback: Some(x_rollback),
    xFindFunction: Some(x_find_function),
    xRename: None,
    xSavepoint: Some(x_savepoint),
    xRelease: Some(x_release),
    xRollbackTo: Some(x_rollback_to),
    xShadowName: None,
    xIntegrity: None,
};

/// Registers the `anki` virtual table module and the `similarity()` function.
///
/// Called from `wasm/anki_extension.c` during `sqlite3_anki_init`.
///
/// # Safety
///
/// `db` must be a valid `sqlite3*` connection handle.
#[no_mangle]
pub unsafe extern "C" fn anki_register_vtab(db: *mut sqlite3) -> c_int {
    let rc = sqlite3_create_module_v2(
        db,
        b"anki\0".as_ptr() as *const c_char,
        &ANKI_MODULE,
        ptr::null_mut(),
        None,
    );
    if rc != SQLITE_OK {
        return rc;
    }
    let rc = sqlite3_create_function_v2(
        db,
        b"similarity\0".as_ptr() as *const c_char,
        1,
        SQLITE_UTF8,
        ptr::null_mut(),
        Some(similarity_stub),
        None,
        None,
        None,
    );
    if rc != SQLITE_OK {
        return rc;
    }
    // anki_model() / anki_dim() read the runtime-loaded model metadata.
    let rc = sqlite3_create_function_v2(
        db,
        b"anki_model\0".as_ptr() as *const c_char,
        0,
        SQLITE_UTF8,
        ptr::null_mut(),
        Some(anki_model_fn),
        None,
        None,
        None,
    );
    if rc != SQLITE_OK {
        return rc;
    }
    sqlite3_create_function_v2(
        db,
        b"anki_dim\0".as_ptr() as *const c_char,
        0,
        SQLITE_UTF8,
        ptr::null_mut(),
        Some(anki_dim_fn),
        None,
        None,
        None,
    )
}

#[cfg(test)]
mod prefilter_tests {
    //! The pushed-down WHERE pre-filter must never drop a row SQLite would keep
    //! (a false negative SQLite can't recover, since it only re-checks rows we
    //! emit). These cover the two cases where a naive compare would: int↔real
    //! precision past 2^53, and non-BINARY text collations.
    use super::*;

    fn txt(s: &str) -> Cell {
        Cell::Text(s.to_string())
    }

    #[test]
    fn int_real_compare_exact_past_2_53() {
        let x = 9007199254740993_i64; // 2^53 + 1, not representable as f64
        let y = 9007199254740992.0_f64; // 2^53
        // Naive `x as f64` would round to 2^53 and report Equal — this must not.
        assert_eq!(cmp_int_real(x, y), Some(Ordering::Greater));
        assert_eq!(
            cell_partial_cmp(&Cell::Int(x), &Cell::Real(y), Coll::Binary),
            Some(Ordering::Greater),
        );
        assert!(cell_passes(&Cell::Int(x), SQLITE_INDEX_CONSTRAINT_GT, &Cell::Real(y), Coll::Binary));
    }

    #[test]
    fn int_real_fractions_and_bounds() {
        assert_eq!(cmp_int_real(3, 3.5), Some(Ordering::Less));
        assert_eq!(cmp_int_real(3, 3.0), Some(Ordering::Equal));
        assert_eq!(cmp_int_real(4, 3.5), Some(Ordering::Greater));
        assert_eq!(cmp_int_real(i64::MAX, f64::INFINITY), Some(Ordering::Less));
        assert_eq!(cmp_int_real(i64::MIN, f64::NEG_INFINITY), Some(Ordering::Greater));
        assert_eq!(cmp_int_real(0, f64::NAN), None); // unordered → cell_passes keeps
    }

    #[test]
    fn nocase_matches_sqlite_and_binary_does_not() {
        assert_eq!(collated_cmp("alice", "Alice", Coll::Nocase), Ordering::Equal);
        assert_eq!(collated_cmp("alice", "Alice", Coll::Binary), Ordering::Greater);
        // A NOCASE column: 'alice' = 'Alice' must be kept...
        assert!(cell_passes(&txt("alice"), SQLITE_INDEX_CONSTRAINT_EQ, &txt("Alice"), Coll::Nocase));
        // ...whereas a binary pre-filter would have wrongly dropped it.
        assert!(!cell_passes(&txt("alice"), SQLITE_INDEX_CONSTRAINT_EQ, &txt("Alice"), Coll::Binary));
    }

    #[test]
    fn rtrim_ignores_trailing_spaces() {
        assert_eq!(collated_cmp("hi   ", "hi", Coll::Rtrim), Ordering::Equal);
        assert!(cell_passes(&txt("hi   "), SQLITE_INDEX_CONSTRAINT_EQ, &txt("hi"), Coll::Rtrim));
    }

    #[test]
    fn unknown_comparisons_keep_the_row() {
        // NULL and cross-type are "unknown" → keep (SQLite re-checks; only narrows).
        assert!(cell_passes(&Cell::Null, SQLITE_INDEX_CONSTRAINT_GT, &Cell::Int(10), Coll::Binary));
        assert!(cell_passes(&txt("x"), SQLITE_INDEX_CONSTRAINT_LT, &Cell::Int(5), Coll::Binary));
    }
}
