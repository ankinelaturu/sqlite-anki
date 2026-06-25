/**
 * Safety guards around model state.
 *
 *  1. No model loaded: the extension must degrade gracefully, never crash.
 *     Writes still store the text (it's the source of truth); MATCH simply
 *     finds nothing because nothing could be embedded.
 *  2. Model mismatch: a table's stored vectors belong to the model that created
 *     them. Reopening with a different model (different dimension / vector
 *     space) would silently return garbage, so `xConnect` compares the loaded
 *     model against `anki_meta` and fails with a clear, actionable error
 *     instead of loading incompatible data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule, withModel } from "./harness.mjs";

// With no model, INSERT still persists the row (text is retained), but the
// vector column can't be embedded, so MATCH returns nothing — and crucially the
// whole thing doesn't throw.
test("no model loaded: MATCH is empty, rows still store, no crash", async () => {
  const sqlite3 = await loadModule(); // no model
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE t USING anki(name TEXT, notes TEXT VECTOR);`);
    db.exec(`INSERT INTO t(name,notes) VALUES('a','hello world');`);
    assert.equal(db.selectValue(`SELECT count(*) FROM t`), 1);
    assert.equal(db.selectValue(`SELECT count(*) FROM t WHERE notes MATCH 'hello'`), 0);
  } finally {
    db.close();
  }
});

// We can't load a second, differently-sized model in one process (first load
// wins), so we simulate a "table built with a different model" by rewriting the
// recorded dim in anki_meta, then reopen. xConnect must detect 768 != 384 and
// refuse with a "reindex required" error rather than silently mis-reading the
// 384-dim BLOBs as 768-dim vectors.
test("model-mismatch guard fails reopen with a clear error", async () => {
  const sqlite3 = await withModel(); // dim 384
  const path = "/mismatch.db";
  let db = new sqlite3.oo1.DB(path, "c");
  db.exec(`CREATE VIRTUAL TABLE customers USING anki(name TEXT, notes TEXT VECTOR);`);
  db.exec(`INSERT INTO customers(name,notes) VALUES('Acme','hello');`);
  db.exec(`UPDATE anki_meta SET value='768' WHERE key='embed_dim'`);
  db.close();

  db = new sqlite3.oo1.DB(path, "w"); // current model is still dim 384
  let message = null;
  try {
    db.selectValue("SELECT count(*) FROM customers");
  } catch (e) {
    message = String(e.message || e);
  } finally {
    db.close();
  }
  assert.ok(message, "expected the mismatch guard to throw");
  assert.match(message, /reindex required/);
});
