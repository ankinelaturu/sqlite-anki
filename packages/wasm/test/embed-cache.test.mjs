/**
 * Session query-embedding cache (roadmap #1). A module-global LRU keyed by query
 * text lets the (dominant) ONNX forward pass be paid once per distinct query
 * *across* queries — not just within one cursor's scan. Observable via the
 * `embed_calls` metric: a repeated query does NOT re-embed.
 *
 * Uses its own module instance so the cache starts empty, and distinctive query
 * strings so nothing else in this file has warmed them.
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

test("a repeated query is served from the session cache (no re-embed)", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE t USING anki(body TEXT VECTOR);`);
    db.exec(`INSERT INTO t(body) VALUES('quarterly revenue report'),('sunny weather outlook');`);

    // First search embeds the query (one forward pass).
    const a = snap();
    db.selectObjects(`SELECT rowid FROM t WHERE body MATCH 'lru-probe distinctive alpha'`);
    const b = snap();
    assert.equal(b.embed_calls - a.embed_calls, 1, "first query embeds once");

    // The SAME query in a fresh statement (new cursor) → served from the cache.
    db.selectObjects(`SELECT rowid FROM t WHERE body MATCH 'lru-probe distinctive alpha'`);
    const c = snap();
    assert.equal(c.embed_calls - b.embed_calls, 0, "repeat query hits the session cache");

    // A different query embeds again.
    db.selectObjects(`SELECT rowid FROM t WHERE body MATCH 'lru-probe distinctive beta'`);
    const d = snap();
    assert.equal(d.embed_calls - c.embed_calls, 1, "a new query embeds");
  } finally {
    db.close();
  }
});

test("the cache is shared across databases (same module, global model)", () => {
  const db1 = new sqlite3.oo1.DB(":memory:");
  const db2 = new sqlite3.oo1.DB(":memory:");
  try {
    for (const db of [db1, db2]) {
      db.exec(`CREATE VIRTUAL TABLE t USING anki(body TEXT VECTOR);`);
      db.exec(`INSERT INTO t(body) VALUES('alpha one'),('beta two');`);
    }
    const a = snap();
    db1.selectObjects(`SELECT rowid FROM t WHERE body MATCH 'lru-probe shared gamma'`);
    const b = snap();
    assert.equal(b.embed_calls - a.embed_calls, 1, "first DB embeds it");
    // Same query text on a *different* DB → still a cache hit (model is global).
    db2.selectObjects(`SELECT rowid FROM t WHERE body MATCH 'lru-probe shared gamma'`);
    const c = snap();
    assert.equal(c.embed_calls - b.embed_calls, 0, "second DB reuses the cached embedding");
  } finally {
    db1.close();
    db2.close();
  }
});
