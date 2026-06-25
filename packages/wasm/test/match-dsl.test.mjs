/**
 * The MATCH DSL (see docs/match-dsl.md): a regex-inspired suffix on the MATCH
 * string controlling semantic-search behavior — `query/[mode[:candidates]]`.
 *
 *   notes MATCH 'apple'            -> query="apple", hnsw (default)
 *   notes MATCH 'apple/exact'      -> exact brute-force
 *   notes MATCH 'apple/hnsw:1'     -> hnsw, candidate budget 1
 *
 * Keyword-gated: a trailing "/x" is a directive only if x is a known mode, so
 * slashy queries (TCP/IP) stay literal; quote to force any string literal.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { withModel } from "./harness.mjs";

let sqlite3;
before(async () => {
  sqlite3 = await withModel();
});

function seeded() {
  const db = new sqlite3.oo1.DB(":memory:");
  db.exec(`CREATE VIRTUAL TABLE docs USING anki(label TEXT, notes TEXT VECTOR);`);
  db.exec(`INSERT INTO docs(label, notes) VALUES
    ('a','billing support request'),
    ('b','invoice and payment help'),
    ('c','weather forecast notes'),
    ('tcp','TCP/IP networking guide');`);
  return db;
}
const names = (db, sql, bind) =>
  db.selectObjects(sql, bind).map((r) => r.label).sort();

test("bare query still works (default mode)", () => {
  const db = seeded();
  try {
    assert.ok(db.selectObjects(`SELECT label FROM docs WHERE notes MATCH 'billing'`).length > 0);
  } finally {
    db.close();
  }
});

test("/exact and /hnsw agree on small data (cap doesn't bite under 256 rows)", () => {
  const db = seeded();
  try {
    const hnsw = names(db, `SELECT label FROM docs WHERE notes MATCH 'billing/hnsw'`);
    const exact = names(db, `SELECT label FROM docs WHERE notes MATCH 'billing/exact'`);
    assert.deepEqual(hnsw, exact);
  } finally {
    db.close();
  }
});

test("candidates budget caps HNSW result count (/hnsw:1)", () => {
  const db = seeded();
  try {
    const one = db.selectObjects(`SELECT label FROM docs WHERE notes MATCH 'billing/hnsw:1'`);
    assert.ok(one.length <= 1, `expected <=1, got ${one.length}`);
  } finally {
    db.close();
  }
});

test("slashy query stays literal (TCP/IP == \"TCP/IP\")", () => {
  const db = seeded();
  try {
    // Keyword-gating: '/IP' isn't a directive, so the whole string is the query
    // — identical to explicitly quoting it. (Ranking itself is MiniLM's call.)
    const bare = names(db, `SELECT label FROM docs WHERE notes MATCH 'TCP/IP'`);
    const quoted = names(db, `SELECT label FROM docs WHERE notes MATCH '"TCP/IP"'`);
    assert.deepEqual(bare, quoted);
    assert.ok(bare.length > 0);
  } finally {
    db.close();
  }
});

test("quoted query + trailing directive parses (verbatim query, exact mode)", () => {
  const db = seeded();
  try {
    // Must not treat the inner '/' as a directive; runs in exact mode.
    const rows = db.selectObjects(
      `SELECT label FROM docs WHERE notes MATCH '"TCP/IP networking"/exact'`
    );
    assert.ok(Array.isArray(rows)); // ran without error
    // Same query, no directive, should give the same set (exact==hnsw small data).
    const plain = names(db, `SELECT label FROM docs WHERE notes MATCH '"TCP/IP networking"'`);
    assert.deepEqual(rows.map((r) => r.label).sort(), plain);
  } finally {
    db.close();
  }
});

test("malformed directives are hard errors", () => {
  const db = seeded();
  try {
    assert.throws(() => db.exec(`SELECT * FROM docs WHERE notes MATCH 'billing/hnsw:abc'`));
    assert.throws(() => db.exec(`SELECT * FROM docs WHERE notes MATCH 'billing/exact:256'`));
    assert.throws(() => db.exec(`SELECT * FROM docs WHERE notes MATCH 'billing/hnsw:0'`));
  } finally {
    db.close();
  }
});

test("mode is irrelevant once a relational filter pre-filters (exact == hnsw)", () => {
  const db = seeded();
  try {
    const exact = names(db, `SELECT label FROM docs WHERE label='a' AND notes MATCH 'billing/exact'`);
    const hnsw = names(db, `SELECT label FROM docs WHERE label='a' AND notes MATCH 'billing/hnsw'`);
    assert.deepEqual(exact, hnsw);
  } finally {
    db.close();
  }
});

// The headline of the DSL: with >256 matching rows, HNSW is capped at the
// candidate budget while `mode:exact` returns them all. (Slow — embeds ~300
// rows.)
test("mode:exact returns matches the HNSW cap would drop (>256 rows)", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE big USING anki(notes TEXT VECTOR);`);
    const ins = db.prepare(`INSERT INTO big(notes) VALUES(?)`);
    const N = 300;
    for (let i = 0; i < N; i++) ins.bind(["billing support request"]).stepReset();
    ins.finalize();

    const hnsw = db.selectValue(`SELECT count(*) FROM big WHERE notes MATCH 'billing support/hnsw'`);
    const exact = db.selectValue(`SELECT count(*) FROM big WHERE notes MATCH 'billing support/exact'`);
    assert.ok(hnsw <= 256, `hnsw should be capped at 256, got ${hnsw}`);
    assert.equal(exact, N, `exact should return all ${N}, got ${exact}`);
    assert.ok(exact > hnsw, "exact must return more than the capped HNSW");
  } finally {
    db.close();
  }
});
