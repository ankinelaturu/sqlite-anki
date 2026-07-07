/**
 * Operation metrics (see docs/metrics.md). The extension keeps cumulative
 * counters; `anki_metrics()` returns a JSON snapshot the app diffs before/after
 * an operation. This verifies the export shape and that the relevant counters
 * advance for embeds, searches, persists, and HNSW rebuilds.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { withModel } from "./harness.mjs";

let sqlite3;
before(async () => {
  sqlite3 = await withModel();
});

const snap = () =>
  JSON.parse(sqlite3.wasm.cstrToJs(sqlite3.wasm.exports.anki_metrics()));

test("anki_metrics() returns the documented JSON shape", () => {
  const m = snap();
  for (const k of [
    "embed_ms",
    "embed_calls",
    "search_ms",
    "search_ops",
    "persist_ms",
    "index_rebuild_ms",
    "index_rebuilds",
    "graph_save_ms",
    "graph_saves",
    "graph_load_ms",
    "graph_loads",
    "candidates",
    "rows_matched",
  ]) {
    assert.equal(typeof m[k], "number", `missing/!number: ${k}`);
  }
});

test("counters advance for insert (embed + persist) and search", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE docs USING anki(notes TEXT VECTOR);`);

    // INSERT: embeds once + persists.
    const a = snap();
    db.exec(`INSERT INTO docs(notes) VALUES('billing support request')`);
    const b = snap();
    assert.equal(b.embed_calls - a.embed_calls, 1, "one embedding per inserted row");
    assert.ok(b.embed_ms - a.embed_ms >= 0, "embed time recorded");
    assert.ok(b.persist_ms - a.persist_ms >= 0, "persist time recorded");

    db.exec(`INSERT INTO docs(notes) VALUES('weather forecast')`);

    // MATCH: embeds the query (+1) + a search op + an index rebuild (first
    // query after writes).
    const c = snap();
    const rows = db.selectObjects(`SELECT rowid FROM docs WHERE notes MATCH 'billing'`);
    const d = snap();
    assert.equal(d.embed_calls - c.embed_calls, 1, "one embedding for the query");
    assert.equal(d.search_ops - c.search_ops, 1, "one search op");
    assert.ok(d.candidates - c.candidates >= rows.length, "candidates >= rows returned");
    assert.ok(d.index_rebuilds - c.index_rebuilds >= 1, "HNSW rebuilt on first query after writes");
    assert.equal(d.rows_matched - c.rows_matched, rows.length, "rows_matched matches result count");
  } finally {
    db.close();
  }
});

test("writes after the first MATCH splice in incrementally (no full rebuild)", () => {
  // Roadmap #1: once the HNSW index is live, an INSERT/UPDATE/DELETE splices the
  // single row in instead of dirtying the whole index. So the *first* MATCH
  // rebuilds, but subsequent write→MATCH cycles must not rebuild again — while
  // still returning the freshly written rows.
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE docs USING anki(notes TEXT VECTOR);`);
    db.exec(`INSERT INTO docs(notes) VALUES('billing support request'),('weather forecast');`);

    // First MATCH builds the index (rebuild happens here).
    const a = snap();
    db.selectObjects(`SELECT rowid FROM docs WHERE notes MATCH 'billing'`);
    const b = snap();
    assert.ok(b.index_rebuilds - a.index_rebuilds >= 1, "first MATCH builds the index");

    // Now write more rows and re-query: the index is live, so these splice in.
    db.exec(`INSERT INTO docs(notes) VALUES('refund and invoice dispute'),('sunny skies tomorrow');`);
    const c = snap();
    const rows = db.selectObjects(
      `SELECT notes FROM docs WHERE notes MATCH 'invoice payment' ORDER BY notes_score DESC`,
    );
    const d = snap();
    assert.equal(d.index_rebuilds - c.index_rebuilds, 0, "no full rebuild after incremental write");
    assert.equal(d.search_ops - c.search_ops, 1, "the search still ran via HNSW");
    // The row inserted after the index was built is retrievable.
    assert.equal(rows[0].notes, "refund and invoice dispute", "incrementally-added row is found");

    // A DELETE also splices (tombstone) without a rebuild, and drops the row.
    db.exec(`DELETE FROM docs WHERE notes = 'refund and invoice dispute'`);
    const e = snap();
    const after = db.selectObjects(`SELECT notes FROM docs WHERE notes MATCH 'invoice payment'`);
    const f = snap();
    assert.equal(f.index_rebuilds - e.index_rebuilds, 0, "no rebuild after incremental delete");
    assert.ok(
      after.every((r) => r.notes !== "refund and invoice dispute"),
      "deleted row is gone from results",
    );
  } finally {
    db.close();
  }
});

test("exact mode records a search but no index rebuild", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE docs USING anki(notes TEXT VECTOR);`);
    db.exec(`INSERT INTO docs(notes) VALUES('alpha'),('beta');`);
    const a = snap();
    db.selectObjects(`SELECT rowid FROM docs WHERE notes MATCH 'alpha/exact'`);
    const b = snap();
    assert.equal(b.search_ops - a.search_ops, 1);
    assert.equal(b.index_rebuilds - a.index_rebuilds, 0, "exact mode skips HNSW");
  } finally {
    db.close();
  }
});
