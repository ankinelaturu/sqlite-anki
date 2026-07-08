//! `anki` virtual table module: planner-driven semantic `MATCH` + `<col>_score`.
//!
//! v1 storage is in-memory and search is brute-force cosine over stored
//! embeddings (HNSW is a later optimization; see [`crate::hnsw`]). The module is
//! registered from `wasm/anki_extension.c` via [`anki_register_vtab`].
//!
//! Semantics (see `docs/DESIGN.md`):
//! - `TEXT VECTOR` columns store plain text; their embedding is managed here.
//! - `WHERE col MATCH ?` embeds the query and returns rows with cosine
//!   similarity >= [`crate::DEFAULT_SIMILARITY_THRESHOLD`], best-first.
//! - the hidden `<col>_score` column holds the current row's cosine similarity
//!   for an active `MATCH` on that column, or `NULL` when it has no `MATCH`.
#![allow(non_camel_case_types, non_snake_case, private_interfaces)]

use crate::embedder::Embedder;
use crate::hnsw::Hnsw;
use crate::match_query::{parse_match, Mode};
use crate::metrics;
use crate::{DEFAULT_SIMILARITY_THRESHOLD, HNSW_CANDIDATE_CAP};
use core::cmp::Ordering;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::{BTreeMap, HashMap, HashSet};
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

// Conflict-resolution modes returned by `sqlite3_vtab_on_conflict`
// (SQLITE_ABORT = 4 is the default and maps to the `_` arm below).
const SQLITE_ROLLBACK: c_int = 1;
const SQLITE_IGNORE: c_int = 2;
const SQLITE_FAIL: c_int = 3;
const SQLITE_REPLACE: c_int = 5;

/// The `INSERT OR <x>` / `UPDATE OR <x>` keyword for a conflict-resolution mode.
/// Anything unexpected (incl. `SQLITE_ABORT`) maps to `ABORT`, the SQL default.
fn conflict_keyword(mode: c_int) -> &'static str {
    match mode {
        SQLITE_ROLLBACK => "ROLLBACK",
        SQLITE_FAIL => "FAIL",
        SQLITE_IGNORE => "IGNORE",
        SQLITE_REPLACE => "REPLACE",
        _ => "ABORT",
    }
}

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
    fn sqlite3_value_blob(v: *mut sqlite3_value) -> *const c_void;
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
    fn sqlite3_result_blob(
        ctx: *mut sqlite3_context,
        p: *const c_void,
        n: c_int,
        d: SqliteDestructor,
    );
    // The connection a scalar function is running on (for nested reads).
    fn sqlite3_context_db_handle(ctx: *mut sqlite3_context) -> *mut sqlite3;

    // The conflict-resolution mode of the SQL that triggered the current xUpdate
    // (e.g. `INSERT OR REPLACE`); one of SQLITE_ROLLBACK/ABORT/FAIL/IGNORE/REPLACE.
    fn sqlite3_vtab_on_conflict(db: *mut sqlite3) -> c_int;

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
    fn sqlite3_reset(stmt: *mut sqlite3_stmt) -> c_int;

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
    /// Raw bytes of a `BLOB` value in a non-vector column, stored verbatim in the
    /// shadow table's real-named data column and returned as-is by `xColumn`.
    Blob(Vec<u8>),
}

struct ColumnDef {
    name: String,
    decl_type: String,
    is_vector: bool,
}

/// The only per-row state held in RAM: the embeddings (for cosine + the HNSW
/// index). User column data lives in the shadow table and is read on demand by
/// `xColumn`. See docs/streaming-storage.md.
struct Row {
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
    /// Bare vtab name (argv[2]) — the registry key for live graph export.
    table_name: String,
    /// Name of the shadow's rowid column (its `INTEGER PRIMARY KEY`). When the user
    /// declares a single `INTEGER PRIMARY KEY` column, that column *is* the rowid and
    /// this is its name; otherwise we inject `anki_id` and this is `"anki_id"`.
    rowid_col: String,
    /// `Some(i)` when the rowid is user column `i` (no injected `anki_id`); `None`
    /// when `anki_id` is injected. The rowid column is bound with the rowid value on
    /// write and served directly on read, not treated as an ordinary user cell.
    rowid_user_idx: Option<usize>,
    /// Quoted, db-qualified shadow table name, e.g. `"main"."customers_anki_data"`.
    data_table: String,
    /// Set on `xRollback`: the cache may diverge from the rolled-back shadow
    /// table, so reload it lazily at the next `xFilter`.
    dirty: bool,
    /// One HNSW index per column (`Some` only for `TEXT VECTOR` columns).
    indexes: Vec<Option<Hnsw>>,
    /// Set on any write/reload: indexes are stale and rebuilt at the next `MATCH`.
    index_dirty: bool,
    /// Quoted, db-qualified graph-cache table, e.g. `"main"."customers_anki_hnsw"`.
    hnsw_table: String,
    /// Set on any write: the persisted graph no longer matches committed data, so
    /// the next `xSync` must re-persist (if the graph is live) or clear it.
    graph_disk_stale: bool,
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
    /// each `<col>_score` column maps back to one of these.
    match_cols: Vec<usize>,
    /// Reused `SELECT <cols> FROM <name>_anki_data WHERE anki_id=?` for serving user columns
    /// on demand (xColumn). NULL until first used; finalized in x_close.
    row_stmt: *mut sqlite3_stmt,
    /// rowid whose values are cached in `row_cells` (`0` = none; rowids are ≥ 1).
    row_cache_id: i64,
    /// The cached user-column cells for `row_cache_id`, in declared column order.
    row_cells: Vec<Cell>,
    /// Query-embedding cache `(col, match text) -> embedding`, reused across the
    /// repeated `xFilter` calls a join makes (one per outer row, same MATCH text),
    /// so the (dominant) embedding cost is paid once per distinct query.
    q_cache: Vec<(usize, String, Vec<f32>)>,
}

impl AnkiCursor {
    /// Embeds `text` for `col`, reusing a prior embedding of the same query on this
    /// cursor (see `q_cache`). `None` only when the text embeds to nothing.
    fn embed_cached(&mut self, col: usize, text: &str) -> Option<Vec<f32>> {
        if let Some((_, _, emb)) = self.q_cache.iter().find(|(c, t, _)| *c == col && t == text) {
            return Some(emb.clone());
        }
        let emb = embed_text(text)?;
        self.q_cache.push((col, text.to_string(), emb.clone()));
        Some(emb)
    }
}

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

/// SQL text for a pushed comparison operator (only `is_filter_op` ops reach here).
fn op_sql(op: u8) -> &'static str {
    match op {
        SQLITE_INDEX_CONSTRAINT_EQ => "=",
        SQLITE_INDEX_CONSTRAINT_GT => ">",
        SQLITE_INDEX_CONSTRAINT_LE => "<=",
        SQLITE_INDEX_CONSTRAINT_LT => "<",
        SQLITE_INDEX_CONSTRAINT_GE => ">=",
        SQLITE_INDEX_CONSTRAINT_NE => "<>",
        _ => "=",
    }
}

/// Explicit `COLLATE` clause for the collation SQLite reported for the constraint
/// (recorded at `x_best_index`). Emitting it explicitly overrides the column's
/// declared collation so the shadow comparison uses exactly the one SQLite would;
/// it is ignored (harmless) on numeric comparisons.
fn coll_sql(coll: Coll) -> &'static str {
    match coll {
        Coll::Binary => " COLLATE BINARY",
        Coll::Nocase => " COLLATE NOCASE",
        Coll::Rtrim => " COLLATE RTRIM",
    }
}

/// Evaluates the pushed relational filters as SQL on the (typed) shadow table and
/// returns the set of candidate rowids. SQLite performs the comparison, so affinity
/// (from the typed columns) and collation (emitted explicitly) match the virtual
/// column's semantics — see docs/streaming-storage.md.
///
/// Returns `None` when there are no pushed filters, or on any prepare/step error —
/// meaning "no pre-filter, scan everything". Since we leave `omit = 0`, SQLite
/// re-checks the constraint, so a `None` fallback can only over-return (never drop a
/// row): this pre-filter is purely an optimization to narrow the cosine candidates.
unsafe fn filter_candidate_ids(
    st: &TableState,
    filters: &[Filter],
    argv: *mut *mut sqlite3_value,
) -> Option<HashSet<i64>> {
    if filters.is_empty() {
        return None;
    }
    let where_sql = filters
        .iter()
        .enumerate()
        .map(|(i, f)| {
            format!(
                "{} {} ?{}{}",
                quote_ident(&st.columns[f.col].name),
                op_sql(f.op),
                i + 1,
                coll_sql(f.coll)
            )
        })
        .collect::<Vec<_>>()
        .join(" AND ");
    let sql = format!(
        "SELECT {} FROM {} WHERE {}",
        quote_ident(&st.rowid_col),
        st.data_table,
        where_sql
    );
    let csql = CString::new(sql).ok()?;
    let mut stmt: *mut sqlite3_stmt = ptr::null_mut();
    if sqlite3_prepare_v2(st.db, csql.as_ptr(), -1, &mut stmt, ptr::null_mut()) != SQLITE_OK {
        return None;
    }
    for (i, f) in filters.iter().enumerate() {
        let cell = value_to_cell(*argv.offset(f.slot as isize));
        bind_cell(stmt, (i + 1) as c_int, &cell);
    }
    let mut ids = HashSet::new();
    let mut rc = sqlite3_step(stmt);
    while rc == SQLITE_ROW {
        ids.insert(sqlite3_column_int64(stmt, 0));
        rc = sqlite3_step(stmt);
    }
    sqlite3_finalize(stmt);
    // A clean completion → trust the set; any error → fall back to a full scan.
    if rc == SQLITE_DONE {
        Some(ids)
    } else {
        None
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
    let mut parts: Vec<String> = cols
        .iter()
        .map(|c| {
            if c.decl_type.is_empty() {
                format!("\"{}\"", c.name)
            } else {
                format!("\"{}\" {}", c.name, c.decl_type)
            }
        })
        .collect();
    // One hidden REAL score column per vector column: `"<col>_score" REAL HIDDEN`.
    // The query-time cosine for an active MATCH on that column is returned here by
    // xColumn; it's NULL when the column has no MATCH in the query. HIDDEN keeps it
    // out of `SELECT *`. Appended after the user columns, in vector-column order,
    // so the score column at declared index `ncol + k` maps to `vector_cols[k]`.
    for c in cols.iter().filter(|c| c.is_vector) {
        parts.push(format!("\"{}_score\" REAL HIDDEN", c.name));
    }
    format!("CREATE TABLE x({})", parts.join(", "))
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

/// On-disk storage-format version of the per-table shadow tables. Bumped when the
/// layout changes incompatibly; `x_connect` refuses to open an older format.
/// v2 introduced typed shadow columns; v3 gave the shadow real column names
/// (`anki_id`, `anki_emb_<col>`, data columns under their real names); v4 added the
/// HNSW graph cache; v5 renamed the shadow tables to the parallel `<name>_anki_data`
/// (rows + embeddings) and `<name>_anki_hnsw` (graph cache), both created at `xCreate`
/// so writes persist the index without DDL at commit time; v6 lets a user
/// `INTEGER PRIMARY KEY` column *be* the shadow rowid (no injected `anki_id`) — see
/// docs/streaming-storage.md.
const STORAGE_FORMAT: u32 = 6;

/// Quoted, db-qualified `anki_meta` table name (database-wide model metadata).
fn meta_table_ident(db_name: &str) -> String {
    format!("{}.{}", quote_ident(db_name), quote_ident("anki_meta"))
}

/// Records the shadow-table storage-format version in `anki_meta` (idempotent).
/// Written unconditionally on `xCreate` (independent of whether a model is loaded).
unsafe fn write_storage_format(db: *mut sqlite3, meta_table: &str) -> c_int {
    let ddl =
        format!("CREATE TABLE IF NOT EXISTS {meta_table}(key TEXT PRIMARY KEY, value TEXT)");
    if exec(db, &ddl) != SQLITE_OK {
        return SQLITE_ERROR;
    }
    let sql = format!(
        "INSERT OR REPLACE INTO {meta_table}(key, value) VALUES('storage_format', '{STORAGE_FORMAT}')"
    );
    exec(db, &sql)
}

/// Reads the shadow-table storage-format version from `anki_meta`; `None` if the
/// key (or the whole table) is absent — i.e. a table built before formats were
/// versioned, which `x_connect` treats as an incompatible older format.
unsafe fn read_storage_format(db: *mut sqlite3, meta_table: &str) -> Option<u32> {
    let sql = format!("SELECT value FROM {meta_table} WHERE key = 'storage_format'");
    let csql = CString::new(sql).ok()?;
    let mut stmt: *mut sqlite3_stmt = ptr::null_mut();
    if sqlite3_prepare_v2(db, csql.as_ptr(), -1, &mut stmt, ptr::null_mut()) != SQLITE_OK {
        return None;
    }
    let mut out = None;
    if sqlite3_step(stmt) == SQLITE_ROW {
        if let Cell::Text(v) = column_to_cell(stmt, 0) {
            out = v.parse::<u32>().ok();
        }
    }
    sqlite3_finalize(stmt);
    out
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
        SQLITE_BLOB => Cell::Blob(value_to_blob(v)),
        _ => Cell::Null,
    }
}

/// Copies a `BLOB` `sqlite3_value`'s bytes into an owned `Vec<u8>`.
unsafe fn value_to_blob(v: *mut sqlite3_value) -> Vec<u8> {
    let n = sqlite3_value_bytes(v);
    let p = sqlite3_value_blob(v) as *const u8;
    if p.is_null() || n <= 0 {
        Vec::new()
    } else {
        slice::from_raw_parts(p, n as usize).to_vec()
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

unsafe fn result_blob(ctx: *mut sqlite3_context, b: &[u8]) {
    sqlite3_result_blob(
        ctx,
        b.as_ptr() as *const c_void,
        b.len() as c_int,
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

/// Quoted, db-qualified shadow table name, e.g. `"main"."customers_anki_data"`. The
/// `_anki_data` suffix follows SQLite's `<vtabname>_<suffix>` shadow-table convention.
fn data_table_ident(db_name: &str, table: &str) -> String {
    format!(
        "{}.{}",
        quote_ident(db_name),
        quote_ident(&format!("{table}_anki_data"))
    )
}

/// Quoted, db-qualified HNSW graph-cache table, e.g.
/// `"main"."customers_anki_hnsw"`. Sits beside the `<name>_anki_data` data shadow
/// (same `<vtabname>_*` shadow convention) and holds one serialized graph per
/// vector column so open can read the index instead of rebuilding it.
fn hnsw_table_ident(db_name: &str, table: &str) -> String {
    format!(
        "{}.{}",
        quote_ident(db_name),
        quote_ident(&format!("{table}_anki_hnsw"))
    )
}

/// Live-table registry: `(db connection, vtab name) -> *mut TableState` (stored as
/// `usize` so the map is `Send`). Lets the `anki_hnsw_json`/`anki_hnsw_dot` scalar
/// functions read a table's **in-RAM** HNSW index directly — reflecting the graph
/// right after a `MATCH` builds it, without waiting for it to be persisted. Entries
/// are added at `xCreate`/`xConnect` and removed at `xDisconnect`/`xDestroy`.
static VTAB_REGISTRY: Lazy<Mutex<HashMap<(usize, String), usize>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Records `state` as the live table for `(db, name)`. Call once the state is fully
/// built, just before handing the vtab to SQLite.
fn register_vtab(db: *mut sqlite3, name: &str, state: *mut TableState) {
    VTAB_REGISTRY
        .lock()
        .insert((db as usize, name.to_string()), state as usize);
}

/// Removes the live-table entry (idempotent). Call before freeing the state so no
/// scalar function can observe a dangling pointer.
fn unregister_vtab(db: *mut sqlite3, name: &str) {
    VTAB_REGISTRY.lock().remove(&(db as usize, name.to_string()));
}

/// Looks up the live `TableState` for `(db, name)`, if any is registered.
fn lookup_vtab(db: *mut sqlite3, name: &str) -> Option<*mut TableState> {
    VTAB_REGISTRY
        .lock()
        .get(&(db as usize, name.to_string()))
        .map(|&p| p as *mut TableState)
}

/// Quoted embedding-column identifier for a vector column, e.g. `"anki_emb_notes"`.
/// The `anki_` prefix is reserved from user column names, so it never collides.
fn emb_col_ident(name: &str) -> String {
    quote_ident(&format!("anki_emb_{name}"))
}

/// True if a declared type is `INTEGER PRIMARY KEY [AUTOINCREMENT]` — the one form
/// SQLite treats as a rowid alias. Such a user column can *be* the shadow's rowid
/// (VACUUM-stable) instead of a redundant injected `anki_id`. `TEXT PRIMARY KEY` and
/// other affinities are not rowid-eligible (they map to `UNIQUE` via `shadow_decl_type`).
fn is_integer_pk(decl_type: &str) -> bool {
    let up = decl_type.to_ascii_uppercase();
    let mut toks = up.split_whitespace();
    toks.next() == Some("INTEGER") && up.contains("PRIMARY KEY")
}

/// Rewrites a user column's declared type for the **shadow** table: a user
/// `PRIMARY KEY` becomes `UNIQUE` (the shadow's own `anki_id` is the sole PRIMARY
/// KEY, and SQLite allows only one per table), and a trailing `AUTOINCREMENT`
/// (valid only on `INTEGER PRIMARY KEY`) is dropped. Uniqueness is still enforced.
/// Everything else (`NOT NULL`, `UNIQUE`, `CHECK`, `COLLATE`, `DEFAULT`) is
/// unchanged. Case-insensitive on the keywords.
fn shadow_decl_type(decl_type: &str) -> String {
    let toks: Vec<&str> = decl_type.split_whitespace().collect();
    let mut out: Vec<String> = Vec::with_capacity(toks.len());
    let mut i = 0;
    while i < toks.len() {
        let is_pk = toks[i].eq_ignore_ascii_case("primary")
            && toks.get(i + 1).is_some_and(|t| t.eq_ignore_ascii_case("key"));
        if is_pk {
            out.push("UNIQUE".to_string());
            i += 2;
            if toks.get(i).is_some_and(|t| t.eq_ignore_ascii_case("autoincrement")) {
                i += 1;
            }
        } else {
            out.push(toks[i].to_string());
            i += 1;
        }
    }
    out.join(" ")
}

fn build_ddl(
    data_table: &str,
    columns: &[ColumnDef],
    rowid_col: &str,
    rowid_user_idx: Option<usize>,
) -> String {
    // Internal columns are namespaced with `anki_` (reserved from user names) so the
    // data columns can keep their *real* names + declared type/COLLATE — a WHERE run
    // directly on the shadow table then matches SQLite's semantics for the virtual
    // column, and CHECK exprs / errors read naturally. See docs/streaming-storage.md.
    let mut defs: Vec<String> = Vec::new();
    // The rowid is the shadow's sole `INTEGER PRIMARY KEY`. If a user column fills
    // that role we keep it in place (below); otherwise inject a synthetic one.
    if rowid_user_idx.is_none() {
        defs.push(format!("{} INTEGER PRIMARY KEY", quote_ident(rowid_col)));
    }
    for (i, c) in columns.iter().enumerate() {
        if Some(i) == rowid_user_idx {
            // The user's own INTEGER PRIMARY KEY *is* the rowid — keep it verbatim
            // (INTEGER PRIMARY KEY [AUTOINCREMENT]), VACUUM-stable, no injected id.
            defs.push(format!("{} {}", quote_ident(&c.name), c.decl_type));
        } else {
            // A non-rowid PRIMARY KEY maps to UNIQUE (only one PK per table).
            let decl = shadow_decl_type(&c.decl_type);
            if decl.is_empty() {
                defs.push(quote_ident(&c.name));
            } else {
                defs.push(format!("{} {}", quote_ident(&c.name), decl));
            }
        }
    }
    for c in columns.iter().filter(|c| c.is_vector) {
        defs.push(format!("{} BLOB", emb_col_ident(&c.name)));
    }
    format!("CREATE TABLE IF NOT EXISTS {data_table}({})", defs.join(", "))
}

/// Write-path column list, in bind order: **rowid column first**, then the other
/// user columns (declared order), then `anki_emb_<vec>` per vector column. The rowid
/// column is bound with the rowid value (`bind_row_values` skips its user cell), so
/// this works whether the rowid is injected (`anki_id`) or a user `INTEGER PRIMARY
/// KEY`. Matches `bind_row_values`' order.
fn data_columns(st: &TableState) -> Vec<String> {
    let mut cols = vec![quote_ident(&st.rowid_col)];
    for (i, c) in st.columns.iter().enumerate() {
        if Some(i) == st.rowid_user_idx {
            continue; // the rowid column is already first
        }
        cols.push(quote_ident(&c.name));
    }
    for c in st.columns.iter().filter(|c| c.is_vector) {
        cols.push(emb_col_ident(&c.name));
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
        Cell::Blob(b) => {
            sqlite3_bind_blob(
                stmt,
                idx,
                b.as_ptr() as *const c_void,
                b.len() as c_int,
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
        SQLITE_BLOB => {
            let n = sqlite3_column_bytes(stmt, idx);
            let p = sqlite3_column_blob(stmt, idx) as *const u8;
            if p.is_null() || n <= 0 {
                Cell::Blob(Vec::new())
            } else {
                Cell::Blob(slice::from_raw_parts(p, n as usize).to_vec())
            }
        }
        _ => Cell::Null,
    }
}

/// Binds the row's `cells` then its vector-column `embeddings` into `stmt`, starting
/// at 1-based parameter index `start`. Returns the next free index.
unsafe fn bind_row_values(
    stmt: *mut sqlite3_stmt,
    st: &TableState,
    cells: &[Cell],
    embeddings: &[Option<Vec<f32>>],
    start: c_int,
) -> c_int {
    let mut idx = start;
    for (i, cell) in cells.iter().take(st.ncol).enumerate() {
        if Some(i) == st.rowid_user_idx {
            continue; // the rowid column is bound with the rowid value, not this cell
        }
        bind_cell(stmt, idx, cell);
        idx += 1;
    }
    for &vi in &st.vector_cols {
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
        idx += 1;
    }
    idx
}

/// `SQLITE_DONE` → OK; otherwise propagate the real result code (e.g. a
/// `SQLITE_CONSTRAINT_*` for a UNIQUE/CHECK/NOT NULL violation) so the failure
/// surfaces as a constraint error, not a generic "SQL logic error".
unsafe fn finish_write(stmt: *mut sqlite3_stmt) -> c_int {
    let rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    if rc == SQLITE_DONE {
        SQLITE_OK
    } else {
        rc
    }
}

/// Inserts one new row into the shadow table with the caller-supplied conflict mode
/// (`INSERT OR <conflict>`). Embeddings are little-endian `f32` BLOBs in the
/// `anki_emb_<col>` columns.
unsafe fn insert_row(
    st: &TableState,
    rowid: i64,
    cells: &[Cell],
    embeddings: &[Option<Vec<f32>>],
    conflict: &str,
) -> c_int {
    let cols = data_columns(st);
    let placeholders = vec!["?"; cols.len()].join(", ");
    let sql = format!(
        "INSERT OR {} INTO {}({}) VALUES({})",
        conflict,
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
    bind_row_values(stmt, st, cells, embeddings, 2);
    finish_write(stmt)
}

/// Updates the shadow row identified by its rowid (the `rowid_col` value) in place,
/// with the caller-supplied conflict mode (`UPDATE OR <conflict>`).
unsafe fn update_row(
    st: &TableState,
    rowid: i64,
    cells: &[Cell],
    embeddings: &[Option<Vec<f32>>],
    conflict: &str,
) -> c_int {
    let cols = data_columns(st);
    // Every column except the rowid (cols[0]) is assigned; the rowid is the WHERE key.
    let set = cols[1..]
        .iter()
        .map(|c| format!("{c}=?"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "UPDATE OR {} {} SET {} WHERE {} = ?",
        conflict,
        st.data_table,
        set,
        quote_ident(&st.rowid_col)
    );
    let csql = match CString::new(sql) {
        Ok(c) => c,
        Err(_) => return SQLITE_ERROR,
    };
    let mut stmt: *mut sqlite3_stmt = ptr::null_mut();
    if sqlite3_prepare_v2(st.db, csql.as_ptr(), -1, &mut stmt, ptr::null_mut()) != SQLITE_OK {
        return SQLITE_ERROR;
    }
    let next = bind_row_values(stmt, st, cells, embeddings, 1);
    sqlite3_bind_int64(stmt, next, rowid);
    finish_write(stmt)
}

unsafe fn delete_row(st: &TableState, rowid: i64) -> c_int {
    let sql = format!(
        "DELETE FROM {} WHERE {} = ?",
        st.data_table,
        quote_ident(&st.rowid_col)
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
    // Only rowid + embeddings are held in RAM; user column data stays on disk and
    // is read on demand by xColumn. The SELECT fetches `<rowid>, anki_emb_<col>…`.
    let rowid = quote_ident(&st.rowid_col);
    let mut cols = vec![rowid.clone()];
    for &vi in &st.vector_cols {
        cols.push(emb_col_ident(&st.columns[vi].name));
    }
    let sql = format!(
        "SELECT {} FROM {} ORDER BY {}",
        cols.join(", "),
        st.data_table,
        rowid
    );
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
        // Embedding columns follow `id`, one per vector column, in vector_cols order.
        let mut embeddings: Vec<Option<Vec<f32>>> = vec![None; st.ncol];
        for (k, &vi) in st.vector_cols.iter().enumerate() {
            let idx = (1 + k) as c_int;
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
        st.rows.insert(rowid, Row { embeddings });
    }
    sqlite3_finalize(stmt);
}

/// Parses columns, declares the user-facing schema, and builds an empty state.
/// Shared by `xCreate` and `xConnect`; returns a raw `TableState` on success.
unsafe fn new_state(
    db: *mut sqlite3,
    argc: c_int,
    argv: *const *const c_char,
    pz_err: *mut *mut c_char,
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

    // The shadow table stores data columns under their real names, so: reserve the
    // `anki_` prefix (used by internal columns `anki_id`/`anki_emb_*`), and require
    // unique names (duplicates would collide in the shadow CREATE).
    let mut seen: HashSet<String> = HashSet::new();
    for c in &columns {
        if c.name.to_ascii_lowercase().starts_with("anki_") {
            set_err(
                pz_err,
                &format!("anki: column name '{}' uses the reserved 'anki_' prefix", c.name),
            );
            return None;
        }
        if !seen.insert(c.name.to_ascii_lowercase()) {
            set_err(pz_err, &format!("anki: duplicate column name '{}'", c.name));
            return None;
        }
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
    let db_name = arg_str(argv, 1);
    let table_name = arg_str(argv, 2);
    let data_table = data_table_ident(&db_name, &table_name);
    let hnsw_table = hnsw_table_ident(&db_name, &table_name);

    // A single user `INTEGER PRIMARY KEY` becomes the rowid (no injected `anki_id`);
    // otherwise inject `anki_id`. Any other PRIMARY KEY column → shadow UNIQUE.
    let rowid_user_idx = columns.iter().position(|c| is_integer_pk(&c.decl_type));
    let rowid_col = match rowid_user_idx {
        Some(i) => columns[i].name.clone(),
        None => "anki_id".to_string(),
    };

    Some(Box::into_raw(Box::new(TableState {
        columns,
        ncol,
        vector_cols,
        rows: BTreeMap::new(),
        next_rowid: 1,
        db,
        table_name,
        rowid_col,
        rowid_user_idx,
        data_table,
        dirty: false,
        indexes: (0..ncol).map(|_| None).collect(),
        index_dirty: true,
        hnsw_table,
        graph_disk_stale: false,
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

/// Incrementally splices one row's embeddings into each column's live HNSW index
/// (~O(log N) per column), avoiding a full [`rebuild_indexes`] on the next
/// `MATCH`. Only called when the indexes are already built and in sync
/// (`!index_dirty`). If a column's index doesn't exist yet (all prior rows had
/// NULL embeddings for it), it's created from this single point.
fn index_add_row(st: &mut TableState, rowid: i64, embeddings: &[Option<Vec<f32>>]) {
    for k in 0..st.vector_cols.len() {
        let ci = st.vector_cols[k];
        if let Some(emb) = embeddings.get(ci).and_then(|e| e.as_ref()) {
            match &mut st.indexes[ci] {
                Some(idx) => idx.add(rowid, emb.clone()),
                None => st.indexes[ci] = Hnsw::build(&[(rowid, emb.clone())]),
            }
        }
    }
}

/// Tombstones `rowid` in each column's live HNSW index (O(1) per column). The
/// counterpart to [`index_add_row`]; a no-op for columns whose index is `None`
/// or that never held this rowid.
fn index_remove_row(st: &mut TableState, rowid: i64) {
    for k in 0..st.vector_cols.len() {
        let ci = st.vector_cols[k];
        if let Some(idx) = st.indexes[ci].as_mut() {
            idx.remove(rowid);
        }
    }
}

/// Persists each column's live HNSW graph into the `<name>_anki_hnsw` shadow
/// table so a later open can [`load_graphs`] instead of rebuilding. Writes one
/// row per vector column (serialized topology, or NULL for an empty column),
/// replacing any prior contents so the stored set stays all-or-nothing. Called
/// from `xSync`, inside the committing transaction, so the graph is durable and
/// rolled back atomically with the data it describes. Only the topology is
/// stored — vectors are rehydrated from `anki_emb_<col>` on load.
///
/// Requires the indexes to be built and in sync (`!index_dirty`); the caller
/// enforces that and otherwise [`clear_graphs`] instead.
unsafe fn save_graphs(st: &mut TableState) -> c_int {
    let t0 = metrics::now_ms();
    // The table is created at xCreate (storage format v4), so xSync only does DML —
    // running DDL inside the committing transaction would be unsafe.
    if exec(st.db, &format!("DELETE FROM {}", st.hnsw_table)) != SQLITE_OK {
        return SQLITE_ERROR;
    }

    let sql = format!(
        "INSERT INTO {}(col, graph) VALUES(?, ?)",
        st.hnsw_table
    );
    for k in 0..st.vector_cols.len() {
        let ci = st.vector_cols[k];
        let name = st.columns[ci].name.clone();
        let blob = st.indexes[ci].as_ref().and_then(|idx| idx.serialize());

        let csql = match CString::new(sql.clone()) {
            Ok(c) => c,
            Err(_) => return SQLITE_ERROR,
        };
        let mut stmt: *mut sqlite3_stmt = ptr::null_mut();
        if sqlite3_prepare_v2(st.db, csql.as_ptr(), -1, &mut stmt, ptr::null_mut()) != SQLITE_OK {
            return SQLITE_ERROR;
        }
        sqlite3_bind_text(
            stmt,
            1,
            name.as_ptr() as *const c_char,
            name.len() as c_int,
            transient(),
        );
        match &blob {
            Some(b) => {
                sqlite3_bind_blob(
                    stmt,
                    2,
                    b.as_ptr() as *const c_void,
                    b.len() as c_int,
                    transient(),
                );
            }
            None => {
                sqlite3_bind_null(stmt, 2);
            }
        }
        let rc = finish_write(stmt);
        if rc != SQLITE_OK {
            return rc;
        }
    }
    metrics::record_graph_save(metrics::now_ms() - t0);
    SQLITE_OK
}

/// Drops any persisted graph, so the next open rebuilds from scratch. Called from
/// `xSync` when a write happened but no live graph is available to persist —
/// keeping the invariant that the stored graph, if present, matches committed
/// data.
unsafe fn clear_graphs(st: &TableState) {
    // If the table was never created there is nothing to clear (and the DELETE
    // would error): guard with IF EXISTS-style tolerance by ignoring failure.
    let _ = exec(st.db, &format!("DELETE FROM {}", st.hnsw_table));
}

/// Loads a persisted graph for every vector column, rehydrating vectors from the
/// in-RAM cache (populated by `load_all`). Returns `true` only if the store has
/// a row for **each** vector column and all deserialize — an all-or-nothing load
/// mirroring [`save_graphs`]. On `true` the caller installs the indexes and skips
/// the rebuild; on `false` nothing is changed and the usual rebuild-on-first-
/// `MATCH` path applies. A missing table, stale/corrupt blob, or a referenced
/// rowid whose vector is gone all yield `false`, never an error.
unsafe fn load_graphs(st: &mut TableState) -> bool {
    let t0 = metrics::now_ms();
    let sql = format!("SELECT col, graph FROM {}", st.hnsw_table);
    let csql = match CString::new(sql) {
        Ok(c) => c,
        Err(_) => return false,
    };
    let mut stmt: *mut sqlite3_stmt = ptr::null_mut();
    // A missing graph table makes prepare fail — treated as "no persisted graph".
    if sqlite3_prepare_v2(st.db, csql.as_ptr(), -1, &mut stmt, ptr::null_mut()) != SQLITE_OK {
        return false;
    }
    // col name -> serialized blob (`None` for a NULL = legitimately empty column).
    let mut stored: HashMap<String, Option<Vec<u8>>> = HashMap::new();
    while sqlite3_step(stmt) == SQLITE_ROW {
        let name = match column_to_cell(stmt, 0) {
            Cell::Text(s) => s,
            _ => {
                sqlite3_finalize(stmt);
                return false;
            }
        };
        let blob = if sqlite3_column_type(stmt, 1) == SQLITE_BLOB {
            let n = sqlite3_column_bytes(stmt, 1);
            let p = sqlite3_column_blob(stmt, 1) as *const u8;
            if p.is_null() || n <= 0 {
                Some(Vec::new())
            } else {
                Some(slice::from_raw_parts(p, n as usize).to_vec())
            }
        } else {
            None // NULL → empty column
        };
        stored.insert(name, blob);
    }
    sqlite3_finalize(stmt);

    // Build the indexes locally first; only commit them to `st` on full success.
    let mut new_indexes: Vec<Option<Hnsw>> = (0..st.ncol).map(|_| None).collect();
    for k in 0..st.vector_cols.len() {
        let ci = st.vector_cols[k];
        let name = &st.columns[ci].name;
        let entry = match stored.get(name) {
            Some(e) => e,
            None => return false, // no row for this column → incomplete store
        };
        match entry {
            None => new_indexes[ci] = None, // empty column, no graph
            Some(b) => {
                let hnsw = Hnsw::deserialize(b, |id| {
                    st.rows
                        .get(&id)
                        .and_then(|row| row.embeddings.get(ci))
                        .and_then(|e| e.clone())
                });
                match hnsw {
                    Some(h) => new_indexes[ci] = Some(h),
                    None => return false, // corrupt/stale → fall back to rebuild
                }
            }
        }
    }

    st.indexes = new_indexes;
    st.index_dirty = false;
    metrics::record_graph_load(metrics::now_ms() - t0);
    true
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
// xColumn returns `<col>_score` from the current row's cached score; xUpdate
// handles writes. The constraint values (`?`) arrive in xFilter's `argv`.

unsafe extern "C" fn x_create(
    db: *mut sqlite3,
    _aux: *mut c_void,
    argc: c_int,
    argv: *const *const c_char,
    pp_vtab: *mut *mut sqlite3_vtab,
    err: *mut *mut c_char,
) -> c_int {
    // argv[0]=module, [1]=db, [2]=table, [3..]=column definitions.
    // new_state parses the columns and declares the user-facing schema to SQLite.
    let state = match new_state(db, argc, argv, err) {
        Some(s) => s, // raw *mut TableState we now own
        None => return SQLITE_ERROR,
    };

    // Create the persistent shadow table (`<name>_anki_data`) backing this vtab.
    let ddl = build_ddl(
        &(*state).data_table,
        &(*state).columns,
        &(*state).rowid_col,
        (*state).rowid_user_idx,
    );
    let rc = exec(db, &ddl);
    if rc != SQLITE_OK {
        drop(Box::from_raw(state)); // reclaim the leaked state on the error path
        return rc;
    }

    // Create the HNSW graph cache (`<name>_anki_hnsw`) up front so persisting the
    // index at commit (`xSync`) is pure DML — never schema-changing DDL. One row per
    // vector column; populated on the first write after the index is built.
    let graph_ddl = format!(
        "CREATE TABLE IF NOT EXISTS {}(col TEXT PRIMARY KEY, graph BLOB)",
        (*state).hnsw_table
    );
    if exec(db, &graph_ddl) != SQLITE_OK {
        drop(Box::from_raw(state));
        return SQLITE_ERROR;
    }

    let meta = meta_table_ident(&arg_str(argv, 1));

    // Stamp the storage-format version so a future reopen can refuse an older,
    // incompatible on-disk layout. Written regardless of whether a model is loaded.
    if write_storage_format(db, &meta) != SQLITE_OK {
        drop(Box::from_raw(state));
        return SQLITE_ERROR;
    }

    // Record the active model so a later reopen with a different model is caught.
    if let Some((id, dim)) = crate::loader::current() {
        if write_meta(db, &meta, &id, dim) != SQLITE_OK {
            drop(Box::from_raw(state));
            return SQLITE_ERROR;
        }
    }

    // Publish the live state so the graph-export functions can read the in-RAM index.
    register_vtab(db, &(*state).table_name, state);

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
    let state = match new_state(db, argc, argv, pz_err) {
        Some(s) => s,
        None => return SQLITE_ERROR,
    };

    // Refuse to open a shadow table written in an older (pre-typed) storage format,
    // whose columns lack the affinity/collation the current code's filters rely on.
    let meta = meta_table_ident(&arg_str(argv, 1));
    if read_storage_format(db, &meta) != Some(STORAGE_FORMAT) {
        set_err(
            pz_err,
            "anki: table built with an older storage format — rebuild required \
             (see docs/streaming-storage.md)",
        );
        drop(Box::from_raw(state));
        return SQLITE_ERROR;
    }

    // Guard against opening a table whose stored vectors were built with a
    // different model (incompatible dimension / vector space).
    if let Some((cur_id, cur_dim)) = crate::loader::current() {
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

    // Reload the persisted HNSW graph so the first `MATCH` reads it instead of
    // paying a cold O(N) rebuild. On any miss (no/partial/corrupt cache) this is a
    // no-op and `index_dirty` stays set, falling back to rebuild-on-first-`MATCH`.
    load_graphs(&mut *state);

    // Publish the live state for the graph-export functions.
    register_vtab(db, &(*state).table_name, state);

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
    // Drop the live-table entry before freeing the state (no dangling lookups).
    unregister_vtab((*vt.state).db, &(*vt.state).table_name);
    drop(Box::from_raw(vt.state));
    drop(vt);
    SQLITE_OK
}

/// `DROP TABLE`: removes the shadow table, then frees state.
unsafe extern "C" fn x_destroy(vtab: *mut sqlite3_vtab) -> c_int {
    let vt = Box::from_raw(vtab as *mut AnkiVtab);
    let st = Box::from_raw(vt.state);
    unregister_vtab(st.db, &st.table_name);
    exec(st.db, &format!("DROP TABLE IF EXISTS {}", st.data_table));
    exec(st.db, &format!("DROP TABLE IF EXISTS {}", st.hnsw_table));
    drop(st);
    drop(vt);
    SQLITE_OK
}

// Transaction hooks. Providing xBegin enrolls the vtab so xSync/xCommit/xRollback
// are delivered. Data writes go straight to the shadow table (rolled back with the
// connection); xSync additionally persists the HNSW graph cache inside the same
// transaction so it stays consistent. Rollback only has to invalidate the in-memory
// cache, which is reloaded lazily on the next xFilter.

unsafe extern "C" fn x_begin(_vtab: *mut sqlite3_vtab) -> c_int {
    SQLITE_OK
}

unsafe extern "C" fn x_sync(vtab: *mut sqlite3_vtab) -> c_int {
    // Persist the HNSW graph as part of the committing transaction, so on disk it
    // is always consistent with (and rolled back atomically alongside) the data.
    let vt = &*(vtab as *mut AnkiVtab);
    let st = &mut *vt.state;
    if !st.graph_disk_stale {
        return SQLITE_OK; // no write this txn → stored graph already current
    }
    let rc = if !st.index_dirty {
        // The graph is built and kept in sync by incremental writes → persist it.
        save_graphs(st)
    } else {
        // No live graph to persist (never built, or invalidated by rollback /
        // REPLACE / IGNORE): drop any stale cache so the next open rebuilds.
        clear_graphs(st);
        SQLITE_OK
    };
    if rc != SQLITE_OK {
        return rc;
    }
    st.graph_disk_stale = false;
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
        row_stmt: ptr::null_mut(),
        row_cache_id: 0,
        row_cells: Vec::new(),
        q_cache: Vec::new(),
    }));
    *pp = cur as *mut sqlite3_vtab_cursor;
    SQLITE_OK
}

unsafe extern "C" fn x_close(cur: *mut sqlite3_vtab_cursor) -> c_int {
    let c = &mut *(cur as *mut AnkiCursor);
    if !c.row_stmt.is_null() {
        sqlite3_finalize(c.row_stmt);
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
///   3. no MATCH → a (possibly filtered) plain scan; `<col>_score` stays NULL.
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

    // Evaluate the pushed relational filters as SQL on the typed shadow table:
    // SQLite does the comparison (affinity + collation) and hands back the candidate
    // rowids. `None` = no filter (scan everything). We leave `omit = 0`, so SQLite
    // re-checks the constraint — this pre-filter only narrows the cosine candidates.
    let candidate_ids = filter_candidate_ids(st, &plan.filters, argv);
    let in_candidates =
        |rowid: &i64| candidate_ids.as_ref().map_or(true, |ids| ids.contains(rowid));

    if plan.matches.is_empty() {
        // No MATCH: a (possibly filtered) scan. `<col>_score` stays NULL.
        for rowid in st.rows.keys() {
            if in_candidates(rowid) {
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
            match c.embed_cached(*col, &mq.query) {
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

            if queries.len() == 1 && plan.filters.is_empty() {
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
                // scores so each `<col>_score` can return its own.
                for (rowid, row) in st.rows.iter() {
                    if !in_candidates(rowid) {
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
            // ORDER BY <col>_score in the query overrides this.
            c.results.sort_by(|a, b| {
                let sa: f32 = a.sims.iter().sum();
                let sb: f32 = b.sims.iter().sum();
                sb.partial_cmp(&sa).unwrap_or(Ordering::Equal)
            });
            metrics::record_search(metrics::now_ms() - t_search, candidates, c.results.len());
        }
    }

    SQLITE_OK
}

// Advance to the next result row.
unsafe extern "C" fn x_next(cur: *mut sqlite3_vtab_cursor) -> c_int {
    let c = &mut *(cur as *mut AnkiCursor);
    c.pos += 1;
    SQLITE_OK
}

// End-of-scan when we've walked past the last materialized result.
unsafe extern "C" fn x_eof(cur: *mut sqlite3_vtab_cursor) -> c_int {
    let c = &*(cur as *mut AnkiCursor);
    (c.pos >= c.results.len()) as c_int
}

// Return column `i` of the current result row. The result list holds rowids;
// the actual cell values come from the in-memory cache keyed by rowid.
/// Loads the current result row's user-column cells into the cursor cache, reading
/// them from the (typed) shadow table on demand — the vtab no longer needs user
/// column data resident in RAM to serve reads. The fetch statement is prepared once
/// per cursor and reused; cells are cached per rowid, so all columns of one row cost
/// a single point lookup.
unsafe fn load_cursor_row(c: &mut AnkiCursor, st: &TableState, rowid: i64) {
    if c.row_cache_id == rowid {
        return; // already cached for this row
    }
    if c.row_stmt.is_null() {
        // Real column names, in declared order, so row_cells[i] aligns with column i.
        let cols = st
            .columns
            .iter()
            .map(|c| quote_ident(&c.name))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT {} FROM {} WHERE {} = ?",
            cols,
            st.data_table,
            quote_ident(&st.rowid_col)
        );
        if let Ok(csql) = CString::new(sql) {
            let mut stmt: *mut sqlite3_stmt = ptr::null_mut();
            if sqlite3_prepare_v2(st.db, csql.as_ptr(), -1, &mut stmt, ptr::null_mut())
                == SQLITE_OK
            {
                c.row_stmt = stmt;
            }
        }
    }
    c.row_cells.clear();
    c.row_cache_id = rowid;
    if c.row_stmt.is_null() {
        return; // couldn't prepare → the row's columns read as NULL
    }
    sqlite3_reset(c.row_stmt);
    sqlite3_bind_int64(c.row_stmt, 1, rowid);
    if sqlite3_step(c.row_stmt) == SQLITE_ROW {
        for i in 0..st.ncol {
            c.row_cells.push(column_to_cell(c.row_stmt, i as c_int));
        }
    }
}

unsafe extern "C" fn x_column(
    cur: *mut sqlite3_vtab_cursor,
    ctx: *mut sqlite3_context,
    i: c_int,
) -> c_int {
    let c = &mut *(cur as *mut AnkiCursor);
    let st = &*(*c.vtab).state;

    if c.pos >= c.results.len() {
        sqlite3_result_null(ctx);
        return SQLITE_OK;
    }

    // Hidden `<col>_score` columns come after the user columns: declared index
    // `ncol + k` is the score of `vector_cols[k]`. Return the cached cosine for
    // that column's active MATCH on the current row, or NULL if it isn't matched
    // in this query. (This is the aggregate-/sort-/subquery-safe path: the value
    // flows through SQLite as ordinary row data.)
    if (i as usize) >= st.ncol {
        let k = i as usize - st.ncol;
        if let Some(&vc) = st.vector_cols.get(k) {
            if let Some(j) = c.match_cols.iter().position(|&mc| mc == vc) {
                if let Some(s) = c.results[c.pos].sims.get(j) {
                    sqlite3_result_double(ctx, *s as f64);
                    return SQLITE_OK;
                }
            }
        }
        sqlite3_result_null(ctx);
        return SQLITE_OK;
    }

    // Serve the user column from the shadow table on demand (cached per row).
    let rowid = c.results[c.pos].rowid;
    load_cursor_row(c, st, rowid);
    match c.row_cells.get(i as usize) {
        Some(Cell::Int(v)) => sqlite3_result_int64(ctx, *v),
        Some(Cell::Real(v)) => sqlite3_result_double(ctx, *v),
        Some(Cell::Text(s)) => result_text(ctx, s),
        Some(Cell::Blob(b)) => result_blob(ctx, b),
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
/// the shadow table, update the cache, and splice the row into the live HNSW
/// indexes (falling back to a full rebuild when they aren't yet in sync — see
/// `index_add_row` / `rebuild_indexes`).
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
            // Splice the deletion into the live indexes; if a rebuild is already
            // pending it will drop the row anyway, so skip the tombstone.
            if !st.index_dirty {
                index_remove_row(st, id);
            }
            // Data changed → the persisted graph is now stale; xSync will refresh
            // or clear it.
            st.graph_disk_stale = true;
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
    let oldid = if is_insert {
        None
    } else {
        Some(sqlite3_value_int64(old))
    };
    // Determine the rowid. SQLite's supplied rowid (`argv[1]`) wins. Otherwise, when
    // a user `INTEGER PRIMARY KEY` column is the rowid, take the value the caller gave
    // that column (so `INSERT INTO t(id,…) VALUES(10,…)` yields rowid 10); a bare
    // INSERT (NULL id) auto-assigns the next rowid, like a normal INTEGER PRIMARY KEY.
    let rowid = if sqlite3_value_type(new_rowid_v) != SQLITE_NULL {
        sqlite3_value_int64(new_rowid_v)
    } else if let Some(idx) = st.rowid_user_idx {
        match cells.get(idx) {
            Some(Cell::Int(v)) => *v,
            _ => st.next_rowid,
        }
    } else {
        st.next_rowid
    };

    // Honor the conflict clause the triggering SQL used (INSERT OR REPLACE, etc.).
    let mode = sqlite3_vtab_on_conflict(st.db);
    let conflict = conflict_keyword(mode);

    // An UPDATE that moves the rowid: drop the old row first, so the re-insert is
    // clean and can't self-conflict on a UNIQUE column it keeps.
    if let Some(o) = oldid {
        if o != rowid {
            let _ = delete_row(st, o);
            st.rows.remove(&o);
        }
    }

    // Persist to the shadow first; only mutate the cache on success so a failed write
    // leaves cache and store consistent. In-place UPDATE (same rowid) → UPDATE; an
    // INSERT or rowid-moving UPDATE → INSERT.
    let in_place = oldid == Some(rowid);
    let t_persist = metrics::now_ms();
    let rc = if in_place {
        update_row(st, rowid, &cells, &embeddings, conflict)
    } else {
        insert_row(st, rowid, &cells, &embeddings, conflict)
    };
    metrics::record_persist(metrics::now_ms() - t_persist);
    if rc != SQLITE_OK {
        return rc;
    }

    // Keep the HNSW indexes in sync with this write.
    if mode == SQLITE_REPLACE || mode == SQLITE_IGNORE {
        // REPLACE/IGNORE can delete/skip a row behind the vtab's back, so we
        // can't splice a single row reliably: mark the cache dirty to resync
        // from the shadow (source of truth) and fully rebuild on the next query.
        st.dirty = true;
        st.index_dirty = true;
    } else if !st.index_dirty {
        // Indexes are live and in sync → splice this row incrementally. Clear
        // any prior entry for this rowid (in-place update) and the moved-from
        // rowid, then add the new embeddings.
        if let Some(o) = oldid {
            if o != rowid {
                index_remove_row(st, o);
            }
        }
        index_remove_row(st, rowid);
        index_add_row(st, rowid, &embeddings);
    }
    // else: a full rebuild is already pending (first build / post-rollback); it
    // will include this row, so incremental work would be wasted.

    // Cache the embeddings + rowid bookkeeping.
    st.rows.insert(rowid, Row { embeddings });
    if rowid >= st.next_rowid {
        st.next_rowid = rowid + 1;
    }
    // Data changed → the persisted graph is now stale; xSync refreshes or clears it.
    st.graph_disk_stale = true;
    if !p_rowid.is_null() {
        *p_rowid = rowid; // report the rowid SQLite should associate with the row
    }
    SQLITE_OK
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

/// Reads the **persisted** HNSW graph blob for `table`.`col` from the
/// `<table>_anki_hnsw` cache. Returns `None` when there's no non-empty blob to
/// decode — no cache row yet, a `NULL` (empty-column) blob, or a query error.
/// This reads the on-disk cache (populated at commit), not the live in-RAM
/// index; the two match after a build has been committed.
unsafe fn read_graph_blob(db: *mut sqlite3, table: &str, col: &str) -> Option<Vec<u8>> {
    let hnsw_table = quote_ident(&format!("{table}_anki_hnsw"));
    let sql = format!("SELECT graph FROM {hnsw_table} WHERE col = ?");
    let csql = CString::new(sql).ok()?;
    let mut stmt: *mut sqlite3_stmt = ptr::null_mut();
    if sqlite3_prepare_v2(db, csql.as_ptr(), -1, &mut stmt, ptr::null_mut()) != SQLITE_OK {
        return None; // no such table (not an anki table / no graph cache)
    }
    let ccol = match CString::new(col) {
        Ok(c) => c,
        Err(_) => {
            sqlite3_finalize(stmt);
            return None;
        }
    };
    sqlite3_bind_text(stmt, 1, ccol.as_ptr(), col.len() as c_int, transient());
    let mut out = None;
    if sqlite3_step(stmt) == SQLITE_ROW && sqlite3_column_type(stmt, 0) == SQLITE_BLOB {
        let n = sqlite3_column_bytes(stmt, 0);
        let p = sqlite3_column_blob(stmt, 0) as *const u8;
        if !p.is_null() && n > 0 {
            out = Some(slice::from_raw_parts(p, n as usize).to_vec());
        }
    }
    sqlite3_finalize(stmt);
    out
}

/// Decodes the persisted graph for `argv[0]`.`argv[1]` and hands it to `render`.
/// Returns `NULL` (via the context) when there's no graph to show or it can't be
/// decoded — the caller (app) treats that as "no graph yet; run a search".
unsafe fn graph_export(
    ctx: *mut sqlite3_context,
    argc: c_int,
    argv: *mut *mut sqlite3_value,
    render: impl Fn(&Hnsw) -> String,
) {
    if argc < 2 {
        sqlite3_result_null(ctx);
        return;
    }
    let table = value_to_string(*argv.offset(0));
    let col = value_to_string(*argv.offset(1));
    let (table, col) = match (table, col) {
        (Some(t), Some(c)) if !t.is_empty() && !c.is_empty() => (t, c),
        _ => {
            sqlite3_result_null(ctx);
            return;
        }
    };
    let db = sqlite3_context_db_handle(ctx);

    // Prefer the live in-RAM index (reflects the graph right after a MATCH builds
    // it, before it's persisted). We only *read* the state — no rebuild, no
    // mutation — so this is safe alongside any concurrent (immutable) vtab access
    // on the single-threaded connection. When the live index isn't built yet
    // (`index_dirty`), or the table isn't registered, fall back to the persisted
    // cache so a freshly reopened DB still shows its last-committed graph.
    if let Some(state) = lookup_vtab(db, &table) {
        let st = &*state;
        if !st.index_dirty {
            match st.columns.iter().position(|c| c.name == col && c.is_vector) {
                Some(ci) => {
                    match &st.indexes[ci] {
                        Some(idx) => result_text(ctx, &render(idx)),
                        None => sqlite3_result_null(ctx), // vector column, no vectors
                    }
                }
                None => sqlite3_result_null(ctx), // not a vector column of this table
            }
            return;
        }
    }

    // Fallback: the persisted `<table>_anki_hnsw` cache.
    match read_graph_blob(db, &table, &col).and_then(|b| Hnsw::deserialize_topology(&b)) {
        Some(idx) => result_text(ctx, &render(&idx)),
        None => sqlite3_result_null(ctx),
    }
}

/// `anki_hnsw_json(table, col)` — the HNSW graph for a vector column as JSON
/// (`{entry, max_level, nodes:[{node,rowid,level}], edges:[{a,b,layer}]}`), or
/// `NULL` if there's no graph. Reads the live in-RAM index when built, else the
/// persisted cache. `rowid` joins back to `table` for labels.
unsafe extern "C" fn anki_hnsw_json_fn(
    ctx: *mut sqlite3_context,
    argc: c_int,
    argv: *mut *mut sqlite3_value,
) {
    graph_export(ctx, argc, argv, |idx| idx.to_json());
}

/// `anki_hnsw_dot(table, col)` — the HNSW graph as Graphviz DOT (live in-RAM index
/// when built, else the persisted cache), or `NULL` if none. Node labels are
/// rowids; edges are colored by layer.
unsafe extern "C" fn anki_hnsw_dot_fn(
    ctx: *mut sqlite3_context,
    argc: c_int,
    argv: *mut *mut sqlite3_value,
) {
    graph_export(ctx, argc, argv, |idx| idx.to_dot());
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
    xFindFunction: None,
    xRename: None,
    xSavepoint: Some(x_savepoint),
    xRelease: Some(x_release),
    xRollbackTo: Some(x_rollback_to),
    xShadowName: None,
    xIntegrity: None,
};

/// Registers the `anki` virtual table module and the `anki_*()` functions.
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
    let rc = sqlite3_create_function_v2(
        db,
        b"anki_dim\0".as_ptr() as *const c_char,
        0,
        SQLITE_UTF8,
        ptr::null_mut(),
        Some(anki_dim_fn),
        None,
        None,
        None,
    );
    if rc != SQLITE_OK {
        return rc;
    }
    // anki_hnsw_json(table, col) / anki_hnsw_dot(table, col) export the persisted
    // HNSW graph topology for a vector column (for the explorer's graph view).
    let rc = sqlite3_create_function_v2(
        db,
        b"anki_hnsw_json\0".as_ptr() as *const c_char,
        2,
        SQLITE_UTF8,
        ptr::null_mut(),
        Some(anki_hnsw_json_fn),
        None,
        None,
        None,
    );
    if rc != SQLITE_OK {
        return rc;
    }
    sqlite3_create_function_v2(
        db,
        b"anki_hnsw_dot\0".as_ptr() as *const c_char,
        2,
        SQLITE_UTF8,
        ptr::null_mut(),
        Some(anki_hnsw_dot_fn),
        None,
        None,
        None,
    )
}

// The WHERE pre-filter is now evaluated by SQLite on the typed shadow table
// (`filter_candidate_ids`), so the collation/affinity correctness this module used
// to guard is covered by the wasm e2e suites (hybrid-filtering, collation,
// pushdown-fidelity) against SQLite's real comparison.

#[cfg(test)]
mod tests {
    use super::shadow_decl_type;

    #[test]
    fn shadow_decl_maps_primary_key_to_unique() {
        // A user PRIMARY KEY → UNIQUE (the shadow's anki_id is the sole PK).
        assert_eq!(shadow_decl_type("INTEGER PRIMARY KEY"), "INTEGER UNIQUE");
        assert_eq!(shadow_decl_type("TEXT PRIMARY KEY"), "TEXT UNIQUE");
        // AUTOINCREMENT (only valid on INTEGER PRIMARY KEY) is dropped; keywords
        // are matched case-insensitively.
        assert_eq!(shadow_decl_type("integer primary key autoincrement"), "integer UNIQUE");
        // Everything else passes through untouched.
        assert_eq!(shadow_decl_type("TEXT NOT NULL"), "TEXT NOT NULL");
        assert_eq!(shadow_decl_type("TEXT COLLATE NOCASE"), "TEXT COLLATE NOCASE");
        assert_eq!(shadow_decl_type("INTEGER UNIQUE"), "INTEGER UNIQUE");
        assert_eq!(shadow_decl_type(""), "");
    }
}
