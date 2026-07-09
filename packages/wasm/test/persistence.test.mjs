/**
 * Persistence via the per-table shadow table.
 *
 * Each `anki` virtual table is backed by a real, hidden SQLite table
 * (`<name>_anki_data`) that stores the column values AND the embeddings (as
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
  const shadow = db.selectValue(`SELECT count(*) FROM "main"."customers_anki_data"`);
  db.close();
  assert.equal(shadow, 2, "write-through to shadow table");

  db = new sqlite3.oo1.DB(path, "w"); // reopen -> xConnect reloads from shadow table
  try {
    assert.equal(db.selectValue("SELECT count(*) FROM customers"), 2);
    const top = db.selectObjects(
      `SELECT name FROM customers WHERE notes MATCH 'billing support' ORDER BY notes_score DESC`
    )[0].name;
    assert.equal(top, "Beta");
  } finally {
    db.close();
  }
});

const metricsSnap = (sqlite3) =>
  JSON.parse(sqlite3.wasm.cstrToJs(sqlite3.wasm.exports.anki_metrics()));

// Roadmap #2: the built HNSW graph is persisted to `<name>_anki_hnsw` at commit,
// so reopening reads it instead of paying a cold O(N) rebuild on the first MATCH.
// The graph is only persisted for a **pinned** (INTEGER PRIMARY KEY) rowid, so the
// table declares one.
test("HNSW graph persists across reopen: first MATCH skips the rebuild", () => {
  const path = "/graph-persist.db";
  let db = new sqlite3.oo1.DB(path, "c");
  db.exec(`CREATE VIRTUAL TABLE docs USING anki(id INTEGER PRIMARY KEY, notes TEXT VECTOR);`);
  db.exec(`INSERT INTO docs(notes) VALUES
    ('billing and invoice dispute'),('weather forecast tomorrow'),
    ('refund request for an order'),('sunny skies and a warm wind');`);
  // Build the in-RAM graph (first MATCH), then a write commits it to the cache.
  db.selectObjects(`SELECT rowid FROM docs WHERE notes MATCH 'invoice'`);
  db.exec(`INSERT INTO docs(notes) VALUES('payment overdue notice')`);
  // The graph cache is a real shadow table we can observe directly.
  const cached = db.selectValue(
    `SELECT count(*) FROM "main"."docs_anki_hnsw" WHERE graph IS NOT NULL`,
  );
  db.close();
  assert.equal(cached, 1, "one vector column's graph persisted to the cache");

  const pre = metricsSnap(sqlite3);
  db = new sqlite3.oo1.DB(path, "w"); // reopen -> xConnect loads the graph
  try {
    const rows = db.selectObjects(
      `SELECT notes FROM docs WHERE notes MATCH 'invoice payment' ORDER BY notes_score DESC`,
    );
    const post = metricsSnap(sqlite3);
    assert.ok(post.graph_loads - pre.graph_loads >= 1, "graph loaded from cache on reopen");
    assert.equal(
      post.index_rebuilds - pre.index_rebuilds,
      0,
      "first MATCH after reopen must not rebuild the index",
    );
    assert.ok(rows.length >= 1, "search still returns results from the loaded graph");
    assert.match(rows[0].notes, /invoice|payment/, "top result is semantically right");
  } finally {
    db.close();
  }
});

// Deletes are compacted out of the serialized graph, so a removed row stays gone
// after reopen — and still without a rebuild.
test("a deleted row stays gone after reopen (compacted graph, no rebuild)", () => {
  const path = "/graph-persist-del.db";
  let db = new sqlite3.oo1.DB(path, "c");
  db.exec(`CREATE VIRTUAL TABLE docs USING anki(id INTEGER PRIMARY KEY, notes TEXT VECTOR);`);
  db.exec(`INSERT INTO docs(notes) VALUES
    ('alpha one two three'),('beta four five six'),
    ('gamma seven eight nine'),('unique deletion sentinel phrase');`);
  db.selectObjects(`SELECT rowid FROM docs WHERE notes MATCH 'alpha'`); // build graph
  db.exec(`DELETE FROM docs WHERE notes = 'unique deletion sentinel phrase'`); // splice + persist
  db.close();

  const pre = metricsSnap(sqlite3);
  db = new sqlite3.oo1.DB(path, "w");
  try {
    const rows = db.selectObjects(
      `SELECT notes FROM docs WHERE notes MATCH 'unique deletion sentinel phrase'`,
    );
    const post = metricsSnap(sqlite3);
    assert.equal(post.index_rebuilds - pre.index_rebuilds, 0, "no rebuild after reopen");
    assert.ok(
      rows.every((r) => r.notes !== "unique deletion sentinel phrase"),
      "deleted row must not resurface from the persisted graph",
    );
  } finally {
    db.close();
  }
});

// An unpinned table (no INTEGER PRIMARY KEY) has a VACUUM-unstable rowid, so the
// graph is deliberately never persisted — it just rebuilds in RAM on open.
test("an unpinned table does not persist the graph (rebuilds on reopen)", () => {
  const path = "/graph-unpinned.db";
  let db = new sqlite3.oo1.DB(path, "c");
  db.exec(`CREATE VIRTUAL TABLE docs USING anki(notes TEXT VECTOR);`); // no integer PK
  db.exec(`INSERT INTO docs(notes) VALUES ('billing dispute'),('weather forecast');`);
  db.selectObjects(`SELECT rowid FROM docs WHERE notes MATCH 'billing'`); // build in RAM
  db.exec(`INSERT INTO docs(notes) VALUES ('refund request')`); // commit
  assert.equal(
    db.selectValue(`SELECT count(*) FROM "main"."docs_anki_hnsw"`),
    0,
    "unpinned table never writes a persisted graph",
  );
  db.close();

  const pre = metricsSnap(sqlite3);
  db = new sqlite3.oo1.DB(path, "w");
  try {
    db.selectObjects(`SELECT notes FROM docs WHERE notes MATCH 'billing'`);
    const post = metricsSnap(sqlite3);
    assert.equal(post.graph_loads - pre.graph_loads, 0, "nothing to load");
    assert.ok(post.index_rebuilds - pre.index_rebuilds >= 1, "rebuilds on open instead");
  } finally {
    db.close();
  }
});

// DROP TABLE must not leak the backing store: xDestroy drops `<name>_anki_data` too.
test("DROP TABLE removes the shadow table (xDestroy)", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE t USING anki(name TEXT, notes TEXT VECTOR);`);
    db.exec(`INSERT INTO t(name,notes) VALUES('a','hello world');`);
    assert.equal(db.selectValue(`SELECT count(*) FROM sqlite_master WHERE name='t_anki_data'`), 1);
    assert.equal(db.selectValue(`SELECT count(*) FROM sqlite_master WHERE name='t_anki_hnsw'`), 1);
    db.exec(`DROP TABLE t`);
    assert.equal(db.selectValue(`SELECT count(*) FROM sqlite_master WHERE name='t_anki_data'`), 0);
    assert.equal(db.selectValue(`SELECT count(*) FROM sqlite_master WHERE name='t_anki_hnsw'`), 0);
  } finally {
    db.close();
  }
});
