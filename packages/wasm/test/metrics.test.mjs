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
