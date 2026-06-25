/**
 * The core `anki` virtual-table SQL surface.
 *
 * Contract under test (see docs/DESIGN.md):
 *  - `CREATE VIRTUAL TABLE ... USING anki(col TEXT, col TEXT VECTOR)` declares a
 *    table where `TEXT VECTOR` columns store plain text and auto-embed on write.
 *  - `WHERE col MATCH 'query'` is *semantic* search: the query is embedded and
 *    rows above the default cosine threshold (0.5) are returned.
 *  - `similarity(col)` is a FUNCTION (not a stored column) returning the current
 *    row's cosine similarity to the active MATCH query — NULL when there is no
 *    MATCH on that column.
 *  - INSERT/UPDATE/DELETE keep embeddings (and the HNSW index) in sync.
 *
 * The model is loaded once per file (the `before` hook); each test uses its own
 * in-memory DB so they don't interfere.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { withModel } from "./harness.mjs";

let sqlite3;
before(async () => {
  sqlite3 = await withModel();
});

// Three rows with distinct semantics: an upsell/opportunity note, a billing
// support note, and a growth/expansion note. Used to check ranking behaves.
function seed(db) {
  db.exec(`CREATE VIRTUAL TABLE customers USING anki(name TEXT, notes TEXT VECTOR);`);
  db.exec(`INSERT INTO customers(name, notes) VALUES
    ('Acme Corp', 'Discussed renewal — potential upsell opportunity in Q3'),
    ('Beta LLC',  'Support ticket about billing, no sales interest'),
    ('Gamma Inc', 'Exploring expansion and new growth opportunities next year');`);
}

// INSERT must embed the TEXT VECTOR column transparently and store the plain
// text so a normal SELECT returns it unchanged (embeddings are internal).
test("CREATE VIRTUAL TABLE + INSERT embeds and stores rows", async () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    seed(db);
    assert.equal(db.selectValue("SELECT count(*) FROM customers"), 3);
    assert.match(db.selectValue("SELECT notes FROM customers WHERE name='Beta LLC'"), /billing/);
  } finally {
    db.close();
  }
});

// A billing-themed query must rank the billing row first — the clearest
// semantic discriminator. Also exercises a *parameterized* MATCH (bound `?`),
// which real apps use, and `ORDER BY similarity(...) DESC` for best-first order.
test("MATCH ranks the semantically closest row first (parameterized)", async () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    seed(db);
    const stmt = db.prepare(
      `SELECT name FROM customers WHERE notes MATCH ? ORDER BY similarity(notes) DESC`
    );
    stmt.bind("billing support request");
    const names = [];
    while (stmt.step()) names.push(stmt.get({}).name);
    stmt.finalize();
    assert.equal(names[0], "Beta LLC", `got order ${JSON.stringify(names)}`);
  } finally {
    db.close();
  }
});

// `similarity()` is only meaningful alongside a MATCH: without one it yields
// NULL for every row; with one, every returned row has a numeric score that
// already passed the default 0.5 threshold.
test("similarity() is NULL without a MATCH, a score with one", async () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    seed(db);
    const noMatch = db.selectObjects(`SELECT similarity(notes) AS s FROM customers`);
    assert.ok(noMatch.every((r) => r.s === null));

    const withMatch = db.selectObjects(
      `SELECT similarity(notes) AS s FROM customers WHERE notes MATCH 'billing'`
    );
    assert.ok(withMatch.length > 0);
    assert.ok(withMatch.every((r) => typeof r.s === "number" && r.s >= 0.5));
  } finally {
    db.close();
  }
});

// A user can tighten the default threshold with `AND similarity(col) > X`; that
// can only ever return a subset of the unfiltered MATCH.
test("stricter threshold filter narrows results", async () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    seed(db);
    const all = db.selectValue(`SELECT count(*) FROM customers WHERE notes MATCH 'billing'`);
    const strict = db.selectValue(
      `SELECT count(*) FROM customers WHERE notes MATCH 'billing' AND similarity(notes) > 0.8`
    );
    assert.ok(strict <= all);
  } finally {
    db.close();
  }
});

// Writes keep embeddings current: a DELETE drops the row from future searches,
// and an UPDATE re-embeds the new text (so a row can become the top match for a
// query it previously didn't match).
test("UPDATE re-embeds; DELETE removes from results", async () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    seed(db);
    db.exec(`DELETE FROM customers WHERE name='Beta LLC'`);
    const afterDelete = db.selectObjects(
      `SELECT name FROM customers WHERE notes MATCH 'billing support' ORDER BY similarity(notes) DESC`
    ).map((r) => r.name);
    assert.ok(!afterDelete.includes("Beta LLC"));

    db.exec(`UPDATE customers SET notes='invoice and billing dispute' WHERE name='Acme Corp'`);
    const top = db.selectObjects(
      `SELECT name FROM customers WHERE notes MATCH 'billing invoice' ORDER BY similarity(notes) DESC`
    )[0].name;
    assert.equal(top, "Acme Corp");
  } finally {
    db.close();
  }
});
