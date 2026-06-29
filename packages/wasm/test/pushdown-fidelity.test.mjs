/**
 * Pre-filter fidelity: the pushed-down WHERE filter must never drop a row SQLite
 * would keep. xBestIndex claims comparisons with omit=0, so SQLite re-checks the
 * rows we *emit* — but it can't recover rows we wrongly dropped. These guard the
 * two cases a naive compare gets wrong:
 *   - non-BINARY text collations (NOCASE / RTRIM), and
 *   - int↔real comparison past 2^53 (where `x as f64` would round).
 * The unit tests (vtab::prefilter_tests) cover the comparison helpers; these
 * exercise the full path — sqlite3_vtab_collation, the idxStr round-trip, and
 * SQLite's re-check — through real SQL.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { withModel } from "./harness.mjs";

let sqlite3;
before(async () => {
  sqlite3 = await withModel();
});

test("COLLATE NOCASE equality keeps every case variant", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE docs USING anki(status TEXT, body TEXT VECTOR);`);
    db.exec(`INSERT INTO docs(status, body) VALUES
      ('active','a'), ('Active','b'), ('ACTIVE','c'), ('archived','d');`);
    const rows = db.selectObjects(
      `SELECT status FROM docs WHERE status = 'active' COLLATE NOCASE`,
    );
    // A binary pre-filter would drop 'Active' and 'ACTIVE' (and SQLite couldn't
    // recover them); NOCASE pushdown keeps all three.
    assert.equal(rows.length, 3, "all three case variants of 'active' kept");
  } finally {
    db.close();
  }
});

test("COLLATE NOCASE filter combined with MATCH keeps a case-different row", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE docs USING anki(status TEXT, body TEXT VECTOR);`);
    db.exec(`INSERT INTO docs(status, body) VALUES
      ('Active','billing and invoice support request'),
      ('archived','marketing campaign ideas for spring');`);
    const rows = db.selectObjects(
      `SELECT status FROM docs
       WHERE status = 'active' COLLATE NOCASE AND body MATCH 'billing support'
       ORDER BY similarity(body) DESC`,
    );
    assert.ok(rows.length >= 1, "the 'Active' row survived the NOCASE pre-filter");
    assert.ok(rows.every((r) => r.status.toLowerCase() === "active"));
  } finally {
    db.close();
  }
});

test("COLLATE RTRIM ignores trailing spaces in the pre-filter", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE docs USING anki(tag TEXT, body TEXT VECTOR);`);
    db.exec(`INSERT INTO docs(tag, body) VALUES ('hi   ','a'), ('hi','b'), ('hix','c');`);
    const rows = db.selectObjects(
      `SELECT tag FROM docs WHERE tag = 'hi' COLLATE RTRIM`,
    );
    assert.equal(rows.length, 2, "'hi   ' and 'hi' both kept under RTRIM");
  } finally {
    db.close();
  }
});

test("integer column vs real RHS is exact past 2^53", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    // `n` is declared with no type → no affinity, so the real RHS is NOT coerced
    // to an integer and the comparison genuinely exercises the int/real path.
    db.exec(`CREATE VIRTUAL TABLE nums USING anki(n, body TEXT VECTOR);`);
    // 9007199254740993 = 2^53 + 1, written as a SQL literal so SQLite parses it
    // exactly (a JS Number could not represent it). 9007199254740992.0 = 2^53.
    db.exec(`INSERT INTO nums(n, body) VALUES (9007199254740993, 'x'), (1, 'y');`);
    const rows = db.selectObjects(`SELECT n FROM nums WHERE n > 9007199254740992.0`);
    // The naive `n as f64` would round 2^53+1 down to 2^53 and drop the row.
    assert.equal(rows.length, 1, "2^53+1 > 2^53.0 holds and the row is kept");
  } finally {
    db.close();
  }
});
