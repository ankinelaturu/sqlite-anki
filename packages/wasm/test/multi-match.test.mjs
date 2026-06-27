/**
 * Multiple MATCH columns in one query: `a MATCH x AND b MATCH y` (AND'd), with
 * per-column similarity() scores, optionally combined with a relational filter.
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
  db.exec(`CREATE VIRTUAL TABLE opp USING anki(
    title TEXT, stage TEXT, summary TEXT VECTOR, customer_notes TEXT VECTOR);`);
  const rows = [
    ["A", "Negotiation", "manufacturing plant expansion", "budget approved by finance"],
    ["B", "Negotiation", "cloud migration project", "still waiting on budget approval"],
    ["C", "Discovery", "new factory production lines", "the deal budget was signed off"],
    ["D", "Closed", "office relocation", "no budget discussion yet"],
  ];
  const ins = db.prepare("INSERT INTO opp(title,stage,summary,customer_notes) VALUES (?,?,?,?)");
  for (const r of rows) ins.bind(r).stepReset();
  ins.finalize();
  return db;
}

test("two MATCH columns AND'd, no longer errors", () => {
  const db = seed();
  try {
    const rows = db.selectObjects(`SELECT title FROM opp
      WHERE summary MATCH 'manufacturing expansion'
        AND customer_notes MATCH 'budget approved'`);
    assert.ok(rows.length > 0, "should return rows, not error");
  } finally {
    db.close();
  }
});

test("similarity() returns the right per-column score", () => {
  const db = seed();
  try {
    const [row] = db.selectObjects(`SELECT title,
        round(similarity(summary), 4) AS s,
        round(similarity(customer_notes), 4) AS n
      FROM opp
      WHERE summary MATCH 'manufacturing expansion'
        AND customer_notes MATCH 'budget approved'
      ORDER BY s DESC LIMIT 1`);
    assert.equal(typeof row.s, "number");
    assert.equal(typeof row.n, "number");
    // The two columns are matched against different queries → different scores.
    assert.notEqual(row.s, row.n);
  } finally {
    db.close();
  }
});

test("relational filter + two MATCHes compose", () => {
  const db = seed();
  try {
    const titles = db
      .selectObjects(`SELECT title FROM opp
        WHERE stage = 'Negotiation'
          AND summary MATCH 'factory growth'
          AND customer_notes MATCH 'budget approved'`)
      .map((r) => r.title);
    // Only Negotiation rows are eligible (A, B); C/D are filtered out by stage.
    assert.ok(titles.every((t) => t === "A" || t === "B"));
  } finally {
    db.close();
  }
});

test("single MATCH still works", () => {
  const db = seed();
  try {
    const rows = db.selectObjects(
      `SELECT title, round(similarity(summary),3) s FROM opp
       WHERE summary MATCH 'cloud migration' ORDER BY s DESC LIMIT 1`,
    );
    assert.equal(rows.length, 1);
    assert.equal(typeof rows[0].s, "number");
  } finally {
    db.close();
  }
});
