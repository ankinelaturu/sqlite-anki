/**
 * `similarity()` inside an aggregate.
 *
 * `similarity(col)` returns the current row's cached cosine via a process-global
 * cursor pointer (set as the vtab emits each row). That works per output row, but
 * an aggregate accumulates in a step detached from the cursor, so the score comes
 * back NULL. See docs/query-planning.md.
 *
 * - The MATERIALIZED-CTE workaround is a real regression test (passes today).
 * - The direct `AVG(similarity(...))` case is the target for the fix; it's marked
 *   `todo` so it runs and documents the desired behavior without failing CI.
 *   When the fix lands (score surfaced as row data, FTS5 `rank` style), drop the
 *   `todo` option and it becomes a normal passing test.
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

// Works today: materialize the per-row scores, then aggregate a plain column.
test("aggregate similarity() via a MATERIALIZED CTE", () => {
  const db = seed();
  try {
    const [{ avg, n }] = db.selectObjects(`
      WITH m AS MATERIALIZED (
        SELECT similarity(body) AS score FROM docs WHERE body MATCH 'billing support'
      )
      SELECT AVG(score) AS avg, COUNT(*) AS n FROM m;
    `);
    assert.ok(n >= 1, "at least one row matched");
    assert.equal(typeof avg, "number");
    assert.ok(avg > 0, "the averaged similarity is a real score, not NULL");
  } finally {
    db.close();
  }
});

// Works today: a plain subquery does NOT help — SQLite flattens it back into the
// broken form, so this also yields NULL. Pin that so the workaround doc stays honest.
test("plain subquery does NOT work around it (flattened → NULL)", () => {
  const db = seed();
  try {
    const [{ avg }] = db.selectObjects(`
      SELECT AVG(score) AS avg
      FROM (SELECT similarity(body) AS score FROM docs WHERE body MATCH 'billing support')
    `);
    assert.equal(avg, null, "plain subquery is flattened, so similarity() is NULL");
  } finally {
    db.close();
  }
});

// TARGET FOR THE FIX (todo): similarity() directly inside AVG() should return the
// real average, not NULL. Fails today; tolerated as todo so CI stays green.
test(
  "similarity() directly inside AVG() returns the score",
  { todo: "returns NULL today — fix pending (surface score as row data)" },
  () => {
    const db = seed();
    try {
      const [{ avg }] = db.selectObjects(
        `SELECT AVG(similarity(body)) AS avg FROM docs WHERE body MATCH 'billing support'`,
      );
      assert.equal(typeof avg, "number", "AVG(similarity(...)) should be a number, not NULL");
      assert.ok(avg > 0);
    } finally {
      db.close();
    }
  },
);
