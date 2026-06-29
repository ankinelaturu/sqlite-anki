/**
 * `<col>_score`: the per-vector-column similarity exposed as a hidden, query-time
 * column. It carries the current row's cosine for an active MATCH on that column,
 * and — being ordinary row data — works in SELECT / WHERE / ORDER BY / GROUP BY
 * AND inside aggregates (the thing a per-row function can't do). NULL when the
 * column has no MATCH in the query; hidden from `SELECT *`.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { withModel } from "./harness.mjs";

let sqlite3;
before(async () => {
  sqlite3 = await withModel();
});

function seed() {
  const db = new sqlite3.oo1.DB(":memory:");
  db.exec(`CREATE VIRTUAL TABLE docs USING anki(status TEXT, body TEXT VECTOR);`);
  db.exec(`INSERT INTO docs(status, body) VALUES
    ('active',   'billing and invoice support request'),
    ('active',   'quarterly revenue and billing summary'),
    ('archived', 'marketing campaign ideas for spring');`);
  return db;
}

test("col_score works in SELECT and ORDER BY (per-row)", () => {
  const db = seed();
  try {
    const rows = db.selectObjects(
      `SELECT body, body_score FROM docs WHERE body MATCH 'billing support' ORDER BY body_score DESC`,
    );
    assert.ok(rows.length >= 1);
    assert.equal(typeof rows[0].body_score, "number");
    assert.ok(rows[0].body_score > 0);
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].body_score >= rows[i].body_score, "ordered by score desc");
    }
  } finally {
    db.close();
  }
});

test("col_score works directly inside an aggregate (no CTE needed)", () => {
  const db = seed();
  try {
    const [{ avg, best, n }] = db.selectObjects(
      `SELECT AVG(body_score) AS avg, MAX(body_score) AS best, COUNT(*) AS n
       FROM docs WHERE body MATCH 'billing support'`,
    );
    assert.ok(n >= 1);
    assert.equal(typeof avg, "number");
    assert.ok(best > 0, "aggregate over the score column returns a real number, not NULL");
  } finally {
    db.close();
  }
});

test("col_score works with GROUP BY (best match per group)", () => {
  const db = seed();
  try {
    const rows = db.selectObjects(
      `SELECT status, MAX(body_score) AS best
       FROM docs WHERE body MATCH 'billing support'
       GROUP BY status ORDER BY best DESC`,
    );
    assert.ok(rows.length >= 1);
    assert.equal(typeof rows[0].best, "number");
  } finally {
    db.close();
  }
});

test("col_score is NULL without a MATCH on that column", () => {
  const db = seed();
  try {
    const rows = db.selectObjects(`SELECT body_score FROM docs LIMIT 3`);
    assert.ok(rows.length === 3);
    assert.ok(rows.every((r) => r.body_score === null), "no MATCH → score is NULL");
  } finally {
    db.close();
  }
});

test("col_score is hidden — excluded from SELECT *", () => {
  const db = seed();
  try {
    const rows = db.selectObjects(`SELECT * FROM docs WHERE body MATCH 'billing support' LIMIT 1`);
    assert.ok(rows.length >= 1);
    assert.ok(!("body_score" in rows[0]), "body_score must not appear in SELECT *");
    assert.ok("status" in rows[0] && "body" in rows[0], "user columns are present");
  } finally {
    db.close();
  }
});

test("each vector column has its own independent _score", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE docs USING anki(summary TEXT VECTOR, body TEXT VECTOR);`);
    db.exec(`INSERT INTO docs(summary, body) VALUES ('a billing problem', 'marketing campaign ideas');`);
    const [row] = db.selectObjects(
      `SELECT summary_score, body_score FROM docs WHERE summary MATCH 'billing issue'`,
    );
    assert.equal(typeof row.summary_score, "number", "summary was matched → has a score");
    assert.equal(row.body_score, null, "body was not matched → NULL");
  } finally {
    db.close();
  }
});
