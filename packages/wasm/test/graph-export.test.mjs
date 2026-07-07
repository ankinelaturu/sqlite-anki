/**
 * Graph export SQL functions: `anki_graph_json(table, col)` and
 * `anki_graph_dot(table, col)` expose the persisted HNSW graph topology so the
 * app (explorer) can visualize it. They read the `<table>_anki_graph` cache and
 * decode it in Rust — a single source of truth for the blob format.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { withModel } from "./harness.mjs";

let sqlite3;
before(async () => {
  sqlite3 = await withModel();
});

const WORDS = [
  "the cat sat on the warm windowsill", "invoice overdue for last month order",
  "sunny weather forecast for the weekend", "please process my refund request",
  "the dog barked at the mail carrier", "quarterly revenue exceeded expectations",
  "rain and thunderstorms expected tomorrow", "customer billing dispute review",
  "a gentle breeze across the meadow", "payment confirmation email sent",
  "the moon rose over the quiet lake", "annual budget planning meeting notes",
];

function seeded(db) {
  db.exec(`CREATE VIRTUAL TABLE t USING anki(abcd TEXT VECTOR);`);
  for (const w of WORDS) db.exec(`INSERT INTO t(abcd) VALUES(?)`, { bind: [w] });
  db.selectObjects(`SELECT rowid FROM t WHERE abcd MATCH 'invoice'`); // build graph
  db.exec(`UPDATE t SET abcd = abcd WHERE rowid = 1`); // commit → persists at xSync
}

test("anki_graph_json returns the persisted topology", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    seeded(db);
    const json = db.selectValue(`SELECT anki_graph_json('t','abcd')`);
    assert.equal(typeof json, "string", "returns a JSON string once persisted");
    const g = JSON.parse(json);

    assert.equal(g.nodes.length, WORDS.length, "one node per row");
    assert.ok(g.edges.length > 0, "graph has edges");
    assert.equal(typeof g.entry, "number", "entry node present");
    assert.ok(g.max_level >= 0);

    // Every node carries a compact index, a rowid, and a level.
    const rowids = new Set(db.selectObjects(`SELECT anki_id AS id FROM t_anki`).map((r) => r.id));
    for (const n of g.nodes) {
      assert.equal(typeof n.node, "number");
      assert.ok(rowids.has(n.rowid), `node rowid ${n.rowid} exists in the table`);
      assert.ok(n.level >= 0);
    }
    // Edges reference valid node indices.
    for (const e of g.edges) {
      assert.ok(e.a < g.nodes.length && e.b < g.nodes.length, "edge in range");
      assert.ok(e.a !== e.b, "no self loops");
      assert.ok(e.layer >= 0);
    }
    // The entry index is one of the nodes.
    assert.ok(g.nodes.some((n) => n.node === g.entry), "entry is a real node");
  } finally {
    db.close();
  }
});

test("anki_graph_dot returns Graphviz DOT with a label per node", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    seeded(db);
    const dot = db.selectValue(`SELECT anki_graph_dot('t','abcd')`);
    assert.equal(typeof dot, "string");
    assert.ok(dot.startsWith("graph hnsw {"), "is a DOT graph");
    assert.ok(dot.trimEnd().endsWith("}"));
    assert.equal((dot.match(/\[label=/g) || []).length, WORDS.length, "one label per node");
    assert.ok(/ -- /.test(dot), "has edges");
  } finally {
    db.close();
  }
});

test("labels come from the app via a JOIN on rowid", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    seeded(db);
    const g = JSON.parse(db.selectValue(`SELECT anki_graph_json('t','abcd')`));
    // Resolve the entry node's rowid → its text, the way the explorer would.
    const entryRow = g.nodes.find((n) => n.node === g.entry);
    const text = db.selectValue(`SELECT abcd FROM t_anki WHERE anki_id = ?`, [entryRow.rowid]);
    assert.equal(typeof text, "string");
    assert.ok(text.length > 0, "rowid joins back to the row text");
  } finally {
    db.close();
  }
});

test("NULL when there is no persisted graph or the target is unknown", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE t USING anki(abcd TEXT VECTOR);`);
    db.exec(`INSERT INTO t(abcd) VALUES('hello world')`);
    // No search has built/persisted a graph yet.
    assert.equal(db.selectValue(`SELECT anki_graph_json('t','abcd')`), null, "no cache yet → NULL");
    // Unknown table (no _anki_graph) and unknown column → NULL, not an error.
    assert.equal(db.selectValue(`SELECT anki_graph_json('nope','abcd')`), null);
    assert.equal(db.selectValue(`SELECT anki_graph_dot('t','not_a_col')`), null);
  } finally {
    db.close();
  }
});
