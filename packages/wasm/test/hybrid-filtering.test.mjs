/**
 * Hybrid queries: relational `WHERE` + semantic `MATCH` in one statement.
 *
 * The vtab pushes equality/range filters down (xBestIndex claims them with
 * `omit=0` so SQLite still verifies) and, when a filter is present, *pre-filters*
 * — it ranks only the rows passing the filter instead of ranking everything and
 * filtering after. That keeps results both correct AND complete: a row that
 * passes the filter is never dropped just because many non-matching rows are
 * more similar (the "post-filter recall cliff"). See docs/hybrid-filtering.md.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { withModel } from "./harness.mjs";

let sqlite3;
before(async () => {
  sqlite3 = await withModel();
});

// Equality filter + MATCH returns only rows passing the filter, ranked.
test("equality filter + MATCH returns only matching rows, ranked", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE docs USING anki(status TEXT, body TEXT VECTOR);`);
    db.exec(`INSERT INTO docs(status, body) VALUES
      ('active',   'billing and invoice support request'),
      ('archived', 'billing and invoice support request'),
      ('active',   'marketing campaign ideas for spring'),
      ('archived', 'quarterly revenue and billing summary');`);
    const rows = db.selectObjects(
      `SELECT status, body FROM docs
       WHERE status = 'active' AND body MATCH 'billing support'
       ORDER BY similarity(body) DESC`
    );
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((r) => r.status === "active"), "only active rows");
    assert.equal(rows[0].body, "billing and invoice support request");
  } finally {
    db.close();
  }
});

// Range filter (>=) combines with MATCH.
test("range filter + MATCH", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE docs USING anki(year INTEGER, body TEXT VECTOR);`);
    db.exec(`INSERT INTO docs(year, body) VALUES
      (2019, 'annual revenue and billing report'),
      (2021, 'annual revenue and billing report'),
      (2023, 'team offsite planning notes');`);
    const years = db
      .selectObjects(
        `SELECT year FROM docs WHERE year >= 2020 AND body MATCH 'revenue billing' ORDER BY year`
      )
      .map((r) => r.year);
    assert.ok(years.every((y) => y >= 2020), `got ${JSON.stringify(years)}`);
    assert.ok(years.includes(2021));
  } finally {
    db.close();
  }
});

// A relational filter without any MATCH still works (filtered scan).
test("relational filter without MATCH (filtered scan)", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE docs USING anki(status TEXT, body TEXT VECTOR);`);
    db.exec(`INSERT INTO docs(status, body) VALUES
      ('active','a'),('archived','b'),('active','c');`);
    const n = db.selectValue(`SELECT count(*) FROM docs WHERE status='active'`);
    assert.equal(n, 2);
  } finally {
    db.close();
  }
});

// The cliff scenario: many non-matching rows that are *more* similar to the
// query than the few matching rows. With >256 total rows the old post-filter
// path would rank the top-256 (all non-matching) and drop the matching rows
// entirely. Pre-filtering ranks only the matching rows, so they all come back.
test("selective filter returns matching rows the cap would have dropped", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE docs USING anki(status TEXT, body TEXT VECTOR);`);
    const ins = db.prepare(`INSERT INTO docs(status, body) VALUES(?, ?)`);
    const query = "billing and invoice support request";
    // 300 archived rows identical to the query (cosine ~1.0) -> they would fill
    // the entire 256 candidate cap in a post-filter plan.
    for (let i = 0; i < 300; i++) ins.bind(["archived", query]).stepReset();
    // 3 active rows, related but less similar.
    ins.bind(["active", "support ticket about a billing question"]).stepReset();
    ins.bind(["active", "invoice dispute needs support"]).stepReset();
    ins.bind(["active", "help with a billing charge"]).stepReset();
    ins.finalize();

    const rows = db.selectObjects(
      `SELECT status FROM docs
       WHERE status='active' AND body MATCH $q
       ORDER BY similarity(body) DESC`,
      { $q: query }
    );
    // All three active rows must be returned despite 300 more-similar archived
    // rows; none of the archived rows leak through.
    assert.equal(rows.length, 3, `expected 3 active rows, got ${rows.length}`);
    assert.ok(rows.every((r) => r.status === "active"));
  } finally {
    db.close();
  }
});
