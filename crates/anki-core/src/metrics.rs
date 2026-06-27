//! Cumulative operation metrics, surfaced to JS via `anki_metrics()`.
//!
//! Counters accumulate since module load; the app diffs a JSON snapshot
//! before/after an operation to get that operation's breakdown. See
//! `docs/metrics.md`.

use parking_lot::Mutex;
use std::ffi::CString;
use std::os::raw::c_char;

#[derive(Clone)]
struct Metrics {
    embed_ms: f64,
    embed_calls: u64,
    search_ms: f64,
    search_ops: u64,
    persist_ms: f64,
    index_rebuild_ms: f64,
    index_rebuilds: u64,
    candidates: u64,
    rows_matched: u64,
}

const ZERO: Metrics = Metrics {
    embed_ms: 0.0,
    embed_calls: 0,
    search_ms: 0.0,
    search_ops: 0,
    persist_ms: 0.0,
    index_rebuild_ms: 0.0,
    index_rebuilds: 0,
    candidates: 0,
    rows_matched: 0,
};

static METRICS: Mutex<Metrics> = Mutex::new(ZERO);
/// Holds the last JSON snapshot alive while JS reads the returned pointer.
static JSON_BUF: Mutex<Option<CString>> = Mutex::new(None);

/// Per-embedding profiling log: (text snippet, ms). Capped to bound memory.
static EMBED_LOG: Mutex<Vec<(String, f64)>> = Mutex::new(Vec::new());
static LOG_BUF: Mutex<Option<CString>> = Mutex::new(None);
const EMBED_LOG_CAP: usize = 8000;

#[cfg(target_os = "emscripten")]
extern "C" {
    fn emscripten_get_now() -> f64;
}

/// Monotonic milliseconds. Uses Emscripten's high-res timer in WASM; a process
/// clock on the host (tests).
pub fn now_ms() -> f64 {
    #[cfg(target_os = "emscripten")]
    {
        unsafe { emscripten_get_now() }
    }
    #[cfg(not(target_os = "emscripten"))]
    {
        use once_cell::sync::OnceCell;
        use std::time::Instant;
        static START: OnceCell<Instant> = OnceCell::new();
        START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
    }
}

pub fn record_embed(text: &str, ms: f64) {
    {
        let mut m = METRICS.lock();
        m.embed_ms += ms;
        m.embed_calls += 1;
    }
    let mut log = EMBED_LOG.lock();
    if log.len() < EMBED_LOG_CAP {
        log.push((text.chars().take(80).collect(), ms));
    }
}

pub fn record_search(ms: f64, candidates: usize, rows: usize) {
    let mut m = METRICS.lock();
    m.search_ms += ms;
    m.search_ops += 1;
    m.candidates += candidates as u64;
    m.rows_matched += rows as u64;
}

pub fn record_persist(ms: f64) {
    METRICS.lock().persist_ms += ms;
}

pub fn record_index_rebuild(ms: f64) {
    let mut m = METRICS.lock();
    m.index_rebuild_ms += ms;
    m.index_rebuilds += 1;
}

fn to_json(m: &Metrics) -> String {
    format!(
        "{{\"embed_ms\":{:.3},\"embed_calls\":{},\"search_ms\":{:.3},\"search_ops\":{},\
         \"persist_ms\":{:.3},\"index_rebuild_ms\":{:.3},\"index_rebuilds\":{},\
         \"candidates\":{},\"rows_matched\":{}}}",
        m.embed_ms,
        m.embed_calls,
        m.search_ms,
        m.search_ops,
        m.persist_ms,
        m.index_rebuild_ms,
        m.index_rebuilds,
        m.candidates,
        m.rows_matched,
    )
}

/// Returns a pointer to a NUL-terminated JSON snapshot of the counters. The
/// buffer stays valid until the next call. Read it immediately (e.g. with
/// `sqlite3.wasm.cstrToJs`).
///
/// # Safety
///
/// The returned pointer is owned by the extension; do not free it.
#[no_mangle]
pub unsafe extern "C" fn anki_metrics_json() -> *const c_char {
    let json = to_json(&METRICS.lock());
    let cs = CString::new(json).unwrap_or_else(|_| CString::new("{}").unwrap());
    let ptr = cs.as_ptr();
    *JSON_BUF.lock() = Some(cs); // keep alive; heap buffer doesn't move
    ptr
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// JSON array of `{ "text", "ms" }` per embedding (profiling). Pointer valid
/// until the next call; read immediately. Owned by the extension — do not free.
#[no_mangle]
pub unsafe extern "C" fn anki_embed_log_json() -> *const c_char {
    let log = EMBED_LOG.lock();
    let mut s = String::from("[");
    for (i, (text, ms)) in log.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!("{{\"text\":\"{}\",\"ms\":{:.2}}}", json_escape(text), ms));
    }
    s.push(']');
    let cs = CString::new(s).unwrap_or_else(|_| CString::new("[]").unwrap());
    let ptr = cs.as_ptr();
    *LOG_BUF.lock() = Some(cs);
    ptr
}

/// Clears the per-embedding log (call before a run to profile just that run).
#[no_mangle]
pub unsafe extern "C" fn anki_embed_log_clear() {
    EMBED_LOG.lock().clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_shape() {
        let m = Metrics {
            embed_ms: 1.5,
            embed_calls: 2,
            ..ZERO
        };
        let j = to_json(&m);
        assert!(j.contains("\"embed_ms\":1.500"));
        assert!(j.contains("\"embed_calls\":2"));
        assert!(j.starts_with('{') && j.ends_with('}'));
    }

    #[test]
    fn clock_is_monotonic() {
        let a = now_ms();
        let b = now_ms();
        assert!(b >= a);
    }
}
