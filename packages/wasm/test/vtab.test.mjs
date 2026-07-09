/**
 * The core `anki` virtual-table SQL surface.
 *
 * Contract under test (see docs/DESIGN.md):
 *  - `CREATE VIRTUAL TABLE ... USING anki(col TEXT, col TEXT VECTOR)` declares a
 *    table where `TEXT VECTOR` columns store plain text and auto-embed on write.
 *  - `WHERE col MATCH 'query'` is *semantic* search: the query is embedded and
 *    rows above the default cosine threshold (0.5) are returned.
 *  - `<col>_score` is a hidden, query-time column holding the current row's
 *    cosine similarity to the active MATCH on that column — NULL when there is
 *    no MATCH on it.
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
// which real apps use, and `ORDER BY <col>_score DESC` for best-first order.
test("MATCH ranks the semantically closest row first (parameterized)", async () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    seed(db);
    const stmt = db.prepare(
      `SELECT name FROM customers WHERE notes MATCH ? ORDER BY notes_score DESC`
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

// `<col>_score` is only meaningful alongside a MATCH: without one it yields
// NULL for every row; with one, every returned row has a numeric score that
// already passed the default 0.5 threshold.
test("col_score is NULL without a MATCH, a score with one", async () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    seed(db);
    const noMatch = db.selectObjects(`SELECT notes_score AS s FROM customers`);
    assert.ok(noMatch.every((r) => r.s === null));

    const withMatch = db.selectObjects(
      `SELECT notes_score AS s FROM customers WHERE notes MATCH 'billing'`
    );
    assert.ok(withMatch.length > 0);
    assert.ok(withMatch.every((r) => typeof r.s === "number" && r.s >= 0.5));
  } finally {
    db.close();
  }
});

// A user can tighten the default threshold with `AND col_score > X`; that
// can only ever return a subset of the unfiltered MATCH.
test("stricter threshold filter narrows results", async () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    seed(db);
    const all = db.selectValue(`SELECT count(*) FROM customers WHERE notes MATCH 'billing'`);
    const strict = db.selectValue(
      `SELECT count(*) FROM customers WHERE notes MATCH 'billing' AND notes_score > 0.8`
    );
    assert.ok(strict <= all);
  } finally {
    db.close();
  }
});

// A non-vector BLOB column must round-trip byte-identically through the vtab.
// The shadow table stores non-vector columns typelessly and `Cell::Blob` carries
// the raw bytes, so binary data (zero bytes, high bytes) survives INSERT→SELECT
// even alongside a TEXT VECTOR column that still embeds and matches normally.
test("non-vector BLOB column round-trips byte-identically", async () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE docs USING anki(title TEXT, body TEXT VECTOR, thumb BLOB);`);
    const bytes = new Uint8Array([0, 1, 2, 255, 128, 0, 42, 7]);
    db.exec({
      sql: `INSERT INTO docs(title, body, thumb) VALUES (?, ?, ?)`,
      bind: ["Cloud migration guide", "How to migrate enterprise workloads to the cloud", bytes],
    });

    const got = db.selectValue(`SELECT thumb FROM docs WHERE title='Cloud migration guide'`);
    assert.ok(got instanceof Uint8Array, `expected Uint8Array, got ${got}`);
    assert.deepEqual([...got], [...bytes]);

    // The vector column is unaffected — it still embeds and matches.
    const hit = db.selectValue(`SELECT title FROM docs WHERE body MATCH 'moving apps to the cloud'`);
    assert.equal(hit, "Cloud migration guide");

    // A NULL blob stays NULL (not an empty blob).
    db.exec({
      sql: `INSERT INTO docs(title, body, thumb) VALUES (?, ?, NULL)`,
      bind: ["No thumb", "unrelated text"],
    });
    assert.equal(db.selectValue(`SELECT thumb FROM docs WHERE title='No thumb'`), null);
  } finally {
    db.close();
  }
});

// The shadow table now carries each column's declared type (for affinity/collation).
// Well-typed values of every storage class round-trip, and the vector column still
// embeds + matches. (Mixed-type affinity coercion only becomes observable once
// xColumn reads from the shadow table — covered in a later commit.)
test("typed shadow columns round-trip every storage class", async () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE items USING anki(
      label TEXT, qty INTEGER, price REAL, blob_col BLOB, body TEXT VECTOR);`);
    db.exec({
      sql: `INSERT INTO items(label, qty, price, blob_col, body) VALUES (?,?,?,?,?)`,
      bind: ["widget", 42, 3.5, new Uint8Array([1, 2, 3]), "a small mechanical part"],
    });
    const row = db.selectObjects(`SELECT qty, price, label, blob_col FROM items`)[0];
    assert.equal(row.qty, 42);
    assert.equal(row.price, 3.5);
    assert.equal(row.label, "widget");
    assert.deepEqual([...row.blob_col], [1, 2, 3]);
    assert.equal(
      db.selectValue(`SELECT label FROM items WHERE body MATCH 'tiny machine component'`),
      "widget",
    );
  } finally {
    db.close();
  }
});

// xColumn now serves user columns from the typed shadow table, so a mixed-type
// insert takes the column's affinity: text '42' into an INTEGER column reads back
// as the number 42 (exactly what SQLite does for a real INTEGER column).
test("xColumn reflects declared affinity (text '42' into INTEGER → 42)", async () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE items USING anki(qty INTEGER, body TEXT VECTOR);`);
    db.exec({ sql: `INSERT INTO items(qty, body) VALUES (?, ?)`, bind: ["42", "a mechanical part"] });
    const qty = db.selectValue(`SELECT qty FROM items`);
    assert.equal(typeof qty, "number");
    assert.equal(qty, 42);
  } finally {
    db.close();
  }
});

// Only rowid + embeddings live in RAM now; user column data is served from the
// shadow table. A large non-vector column round-trips intact while a MATCH (which
// uses the in-RAM embeddings) selects the row — RAM search + on-disk columns combine.
test("large non-vector column round-trips from disk alongside MATCH", async () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE docs USING anki(payload TEXT, body TEXT VECTOR);`);
    const big = "x".repeat(20000); // well beyond any inline threshold
    db.exec({
      sql: `INSERT INTO docs(payload, body) VALUES (?, ?)`,
      bind: [big, "database hosting in the cloud"],
    });
    const row = db.selectObjects(
      `SELECT payload, round(body_score, 3) AS score FROM docs
       WHERE body MATCH 'managed cloud database' ORDER BY score DESC`
    )[0];
    assert.equal(row.payload, big, "large payload intact from disk");
    assert.ok(row.score >= 0.5, "matched via in-RAM embedding");
  } finally {
    db.close();
  }
});

// Data columns are stored under their REAL names in the shadow table (`<t>_anki_data`),
// with internal columns namespaced `anki_`. So a column named `id` or `c0` — which
// the old positional scheme existed to avoid — now round-trips fine.
test("real column names (incl 'id'/'c0') round-trip; shadow uses them", async () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE docs USING anki(id TEXT, c0 TEXT, body TEXT VECTOR);`);
    db.exec({
      sql: `INSERT INTO docs(id, c0, body) VALUES (?,?,?)`,
      bind: ["X-1", "legacy", "database hosting in the cloud"],
    });
    const row = db.selectObjects(`SELECT id, c0 FROM docs`)[0];
    assert.equal(row.id, "X-1");
    assert.equal(row.c0, "legacy");
    assert.equal(db.selectValue(`SELECT id FROM docs WHERE body MATCH 'cloud database'`), "X-1");
    // The shadow carries the user's real column names verbatim (no injected rowid
    // column) plus the `anki_emb_<col>` blob; it keys on SQLite's implicit rowid.
    const cols = db.selectObjects(`PRAGMA table_info("docs_anki_data")`).map((c) => c.name);
    assert.deepEqual(cols, ["id", "c0", "body", "anki_emb_body"]);
  } finally {
    db.close();
  }
});

// The `anki_` prefix is reserved for internal columns, so a user column can't use it.
test("reserved 'anki_' column prefix is rejected at CREATE", async () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    assert.throws(
      () => db.exec(`CREATE VIRTUAL TABLE t USING anki(anki_foo TEXT, body TEXT VECTOR);`),
      /reserved/,
    );
  } finally {
    db.close();
  }
});

// Real names must be unique (they'd collide in the shadow CREATE otherwise).
test("duplicate column names are rejected at CREATE", async () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    assert.throws(
      () => db.exec(`CREATE VIRTUAL TABLE t USING anki(x TEXT, x TEXT VECTOR);`),
      /duplicate/,
    );
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
      `SELECT name FROM customers WHERE notes MATCH 'billing support' ORDER BY notes_score DESC`
    ).map((r) => r.name);
    assert.ok(!afterDelete.includes("Beta LLC"));

    db.exec(`UPDATE customers SET notes='invoice and billing dispute' WHERE name='Acme Corp'`);
    const top = db.selectObjects(
      `SELECT name FROM customers WHERE notes MATCH 'billing invoice' ORDER BY notes_score DESC`
    )[0].name;
    assert.equal(top, "Acme Corp");
  } finally {
    db.close();
  }
});
