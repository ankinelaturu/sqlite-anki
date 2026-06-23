//! `anki` SQLite virtual table module.
//!
//! Implements `CREATE VIRTUAL TABLE ... USING anki(...)` with `TEXT VECTOR`
//! columns, automatic embedding on write, and planner-driven `MATCH` queries.

use std::os::raw::{c_char, c_int, c_void};

/// Name of the virtual table module passed to `CREATE VIRTUAL TABLE ... USING anki`.
pub const MODULE_NAME: &str = "anki";

/// SQLite extension entry point (registered via `sqlite3_auto_extension`).
///
/// # Safety
///
/// Must be called by SQLite during extension load with valid `db` and `p_api`.
#[no_mangle]
pub extern "C" fn sqlite3_anki_init(
    _db: *mut c_void,
    _pz_err_msg: *mut *mut c_char,
    _p_api: *const c_void,
) -> c_int {
    // TODO: sqlite3_create_module for MODULE_NAME, register similarity(), etc.
    0
}
