/**
 * Persistence via the per-table shadow table.
 *
 * Each `anki` virtual table is backed by a real, hidden SQLite table
 * (`<name>_data`) that stores the column values AND the embeddings (as
 * little-endian f32 BLOBs). The in-memory state is just a cache:
 *  - `xUpdate` write-through persists every change to the shadow table.
 *  - `xConnect` (reopen) reloads rows + embeddings from it.
 *  - `xDestroy` (DROP TABLE) deletes it.
 *
 * Note on the test environment: SQLite-WASM in Node uses an in-memory (MEMFS)
 * filesystem, which persists across `db.close()`/reopen *within one process*.
 * That's enough to exercise the close/reopen reload path. In the browser the
 * same path rides on the OPFS-backed file.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { withModel } from "./harness.mjs";

let sqlite3;
before(async () => {
  sqlite3 = await withModel();
});

// The decisive check: after close + reopen, not only do the rows come back, but
// semantic search works — which can only happen if the embeddings round-tripped
// correctly through BLOB storage and were rebuilt into the HNSW index on connect.
test("rows + embeddings survive close/reopen (search works on reload)", () => {
  const path = "/persist.db";
  let db = new sqlite3.oo1.DB(path, "c");
  db.exec(`CREATE VIRTUAL TABLE customers USING anki(name TEXT, notes TEXT VECTOR);`);
  db.exec(`INSERT INTO customers(name,notes) VALUES
    ('Acme','potential upsell opportunity'),
    ('Beta','support ticket about billing');`);
  // The shadow table is a real table we can count directly — proves write-through.
  const shadow = db.selectValue(`SELECT count(*) FROM "main"."customers_data"`);
  db.close();
  assert.equal(shadow, 2, "write-through to shadow table");

  db = new sqlite3.oo1.DB(path, "w"); // reopen -> xConnect reloads from shadow table
  try {
    assert.equal(db.selectValue("SELECT count(*) FROM customers"), 2);
    const top = db.selectObjects(
      `SELECT name FROM customers WHERE notes MATCH 'billing support' ORDER BY similarity(notes) DESC`
    )[0].name;
    assert.equal(top, "Beta");
  } finally {
    db.close();
  }
});

// DROP TABLE must not leak the backing store: xDestroy drops `<name>_data` too.
test("DROP TABLE removes the shadow table (xDestroy)", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE t USING anki(name TEXT, notes TEXT VECTOR);`);
    db.exec(`INSERT INTO t(name,notes) VALUES('a','hello world');`);
    assert.equal(db.selectValue(`SELECT count(*) FROM sqlite_master WHERE name='t_data'`), 1);
    db.exec(`DROP TABLE t`);
    assert.equal(db.selectValue(`SELECT count(*) FROM sqlite_master WHERE name='t_data'`), 0);
  } finally {
    db.close();
  }
});
