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

const SQLITE_INDEX_CONSTRAINT_MATCH: u8 = 64;

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
    sim: Option<f32>,
}

#[repr(C)]
struct AnkiCursor {
    base: sqlite3_vtab_cursor,
    vtab: *mut AnkiVtab,
    results: Vec<MatchRow>,
    pos: usize,
    /// Active `MATCH` column index, or -1 when scanning without `MATCH`.
    match_col: i32,
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
}

// --- module callbacks --------------------------------------------------------

unsafe extern "C" fn x_create(
    db: *mut sqlite3,
    _aux: *mut c_void,
    argc: c_int,
    argv: *const *const c_char,
    pp_vtab: *mut *mut sqlite3_vtab,
    _err: *mut *mut c_char,
) -> c_int {
    // argv[0]=module, [1]=db, [2]=table, [3..]=column definitions.
    let state = match new_state(db, argc, argv) {
        Some(s) => s,
        None => return SQLITE_ERROR,
    };

    // Create the persistent shadow table on first CREATE.
    let ddl = build_ddl(&(*state).data_table, (*state).ncol, &(*state).vector_cols);
    let rc = exec(db, &ddl);
    if rc != SQLITE_OK {
        drop(Box::from_raw(state));
        return rc;
    }

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
    _err: *mut *mut c_char,
) -> c_int {
    // Reopen: the shadow table already exists; reload its rows into memory.
    let state = match new_state(db, argc, argv) {
        Some(s) => s,
        None => return SQLITE_ERROR,
    };
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

unsafe extern "C" fn x_best_index(vtab: *mut sqlite3_vtab, info: *mut sqlite3_index_info) -> c_int {
    let vt = &*(vtab as *mut AnkiVtab);
    let st = &*vt.state;
    let info = &mut *info;

    let mut match_col: i32 = -1;
    for i in 0..info.nConstraint as isize {
        let c = &*info.aConstraint.offset(i);
        if c.usable != 0 && c.op == SQLITE_INDEX_CONSTRAINT_MATCH {
            let col = c.iColumn;
            if col >= 0 && (col as usize) < st.columns.len() && st.columns[col as usize].is_vector {
                let u = &mut *info.aConstraintUsage.offset(i);
                u.argvIndex = 1;
                u.omit = 1;
                match_col = col;
                break;
            }
        }
    }

    if match_col >= 0 {
        info.idxNum = match_col + 1;
        info.estimatedCost = 1.0;
    } else {
        info.idxNum = 0;
        info.estimatedCost = 1.0e9;
    }
    SQLITE_OK
}

unsafe extern "C" fn x_open(vtab: *mut sqlite3_vtab, pp: *mut *mut sqlite3_vtab_cursor) -> c_int {
    let cur = Box::into_raw(Box::new(AnkiCursor {
        base: sqlite3_vtab_cursor { pVtab: vtab },
        vtab: vtab as *mut AnkiVtab,
        results: Vec::new(),
        pos: 0,
        match_col: -1,
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

unsafe extern "C" fn x_filter(
    cur: *mut sqlite3_vtab_cursor,
    idx_num: c_int,
    _idx_str: *const c_char,
    argc: c_int,
    argv: *mut *mut sqlite3_value,
) -> c_int {
    let c = &mut *(cur as *mut AnkiCursor);
    let st = &mut *(*c.vtab).state;

    // Resync the cache if a prior transaction rolled back the shadow table.
    if st.dirty {
        load_all(st);
    }

    c.results.clear();
    c.pos = 0;
    c.match_col = -1;

    if idx_num > 0 && argc >= 1 {
        let col = (idx_num - 1) as usize;
        c.match_col = col as i32;
        let query = value_to_string(*argv.offset(0));
        if let Some(q) = query.as_deref().and_then(embed_text) {
            if st.index_dirty {
                rebuild_indexes(st);
            }
            match st.indexes.get(col).and_then(|o| o.as_ref()) {
                // HNSW: retrieve up to the candidate cap, then threshold.
                Some(idx) => {
                    let k = HNSW_CANDIDATE_CAP.min(st.rows.len());
                    for (rowid, sim) in idx.search(&q, k, HNSW_CANDIDATE_CAP) {
                        if sim >= DEFAULT_SIMILARITY_THRESHOLD {
                            c.results.push(MatchRow {
                                rowid,
                                sim: Some(sim),
                            });
                        }
                    }
                }
                // No index yet (column has no embeddings): exact scan.
                None => {
                    for (rowid, row) in st.rows.iter() {
                        if let Some(Some(emb)) = row.embeddings.get(col) {
                            let sim = cosine(&q, emb);
                            if sim >= DEFAULT_SIMILARITY_THRESHOLD {
                                c.results.push(MatchRow {
                                    rowid: *rowid,
                                    sim: Some(sim),
                                });
                            }
                        }
                    }
                }
            }
            c.results
                .sort_by(|a, b| b.sim.partial_cmp(&a.sim).unwrap_or(Ordering::Equal));
        }
    } else {
        for rowid in st.rows.keys() {
            c.results.push(MatchRow {
                rowid: *rowid,
                sim: None,
            });
        }
    }

    CURRENT_CURSOR = cur as *mut AnkiCursor;
    SQLITE_OK
}

unsafe extern "C" fn x_next(cur: *mut sqlite3_vtab_cursor) -> c_int {
    let c = &mut *(cur as *mut AnkiCursor);
    c.pos += 1;
    CURRENT_CURSOR = cur as *mut AnkiCursor;
    SQLITE_OK
}

unsafe extern "C" fn x_eof(cur: *mut sqlite3_vtab_cursor) -> c_int {
    let c = &*(cur as *mut AnkiCursor);
    (c.pos >= c.results.len()) as c_int
}

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

unsafe extern "C" fn x_rowid(cur: *mut sqlite3_vtab_cursor, p: *mut sqlite3_int64) -> c_int {
    let c = &*(cur as *mut AnkiCursor);
    *p = c.results.get(c.pos).map(|r| r.rowid).unwrap_or(0);
    SQLITE_OK
}

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

    let old = *argv.offset(0);
    let new_rowid_v = *argv.offset(1);
    let ncol = st.ncol;

    let mut cells: Vec<Cell> = Vec::with_capacity(ncol);
    for i in 0..ncol {
        cells.push(value_to_cell(*argv.offset(2 + i as isize)));
    }

    let mut embeddings: Vec<Option<Vec<f32>>> = Vec::with_capacity(ncol);
    for i in 0..ncol {
        let emb = if st.columns[i].is_vector {
            match &cells[i] {
                Cell::Text(s) => embed_text(s),
                _ => None,
            }
        } else {
            None
        };
        embeddings.push(emb);
    }

    let is_insert = sqlite3_value_type(old) == SQLITE_NULL;
    let rowid = if sqlite3_value_type(new_rowid_v) != SQLITE_NULL {
        sqlite3_value_int64(new_rowid_v)
    } else {
        st.next_rowid
    };

    // Persist to the shadow table first; only mutate the cache on success so a
    // failed write leaves cache and store consistent.
    let rc = persist_row(st, rowid, &cells, &embeddings);
    if rc != SQLITE_OK {
        return rc;
    }

    if !is_insert {
        let oldid = sqlite3_value_int64(old);
        if oldid != rowid {
            let _ = delete_row(st, oldid);
            st.rows.remove(&oldid);
        }
    }

    st.rows.insert(rowid, Row { cells, embeddings });
    if rowid >= st.next_rowid {
        st.next_rowid = rowid + 1;
    }
    st.index_dirty = true;
    if !p_rowid.is_null() {
        *p_rowid = rowid;
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
    _argc: c_int,
    _argv: *mut *mut sqlite3_value,
) {
    let cur = CURRENT_CURSOR;
    if cur.is_null() {
        sqlite3_result_null(ctx);
        return;
    }
    let c = &*cur;
    if c.match_col < 0 || c.pos >= c.results.len() {
        sqlite3_result_null(ctx);
        return;
    }
    match c.results[c.pos].sim {
        Some(s) => sqlite3_result_double(ctx, s as f64),
        None => sqlite3_result_null(ctx),
    }
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
    sqlite3_create_function_v2(
        db,
        b"similarity\0".as_ptr() as *const c_char,
        1,
        SQLITE_UTF8,
        ptr::null_mut(),
        Some(similarity_stub),
        None,
        None,
        None,
    )
}
