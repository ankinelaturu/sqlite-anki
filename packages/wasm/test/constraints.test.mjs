/**
 * Column constraints on a greenfield `anki` table.
 *
 * The declared column type flows straight into the real shadow table, so
 * column-level constraints (UNIQUE / CHECK / NOT NULL / DEFAULT) are enforced by
 * SQLite on writes, which all route through the shadow via xUpdate. persist_row
 * upserts on the `anki_id` PK only, so the UPDATE path still works while a
 * user-declared UNIQUE conflict is rejected (not silently replaced).
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { withModel } from "./harness.mjs";

let sqlite3;
before(async () => {
  sqlite3 = await withModel();
});

test("UNIQUE rejects a duplicate (not silently replaced)", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE t USING anki(sku TEXT UNIQUE, body TEXT VECTOR);`);
    db.exec(`INSERT INTO t(sku, body) VALUES ('A', 'first doc');`);
    assert.throws(
      () => db.exec(`INSERT INTO t(sku, body) VALUES ('A', 'second doc');`),
      /constraint/i,
    );
    // The original row is intact — the dup did not replace it.
    assert.equal(db.selectValue(`SELECT count(*) FROM t`), 1);
    assert.equal(db.selectValue(`SELECT body FROM t WHERE sku='A'`), "first doc");
  } finally {
    db.close();
  }
});

test("UPDATE path still works under UNIQUE (upsert targets anki_id)", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE t USING anki(sku TEXT UNIQUE, body TEXT VECTOR);`);
    db.exec(`INSERT INTO t(sku, body) VALUES ('A', 'x'), ('B', 'y');`);
    // Updating a row (same rowid) is fine.
    db.exec(`UPDATE t SET body='updated' WHERE sku='A';`);
    assert.equal(db.selectValue(`SELECT body FROM t WHERE sku='A'`), "updated");
    assert.equal(db.selectValue(`SELECT count(*) FROM t`), 2);
    // Updating a row's sku to collide with another row is rejected.
    assert.throws(() => db.exec(`UPDATE t SET sku='B' WHERE sku='A';`), /constraint/i);
  } finally {
    db.close();
  }
});

test("CHECK and NOT NULL are enforced", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(
      `CREATE VIRTUAL TABLE t USING anki(price INTEGER CHECK(price > 0), title TEXT NOT NULL, body TEXT VECTOR);`,
    );
    assert.throws(() => db.exec(`INSERT INTO t(price,title,body) VALUES(-1,'x','y')`), /constraint/i);
    assert.throws(() => db.exec(`INSERT INTO t(price,title,body) VALUES(5,NULL,'y')`), /constraint/i);
    db.exec(`INSERT INTO t(price,title,body) VALUES(5,'ok','a cloud database')`);
    assert.equal(db.selectValue(`SELECT count(*) FROM t`), 1);
  } finally {
    db.close();
  }
});

// DEFAULT is NOT applied — a virtual-table limitation. SQLite ignores a vtab's
// declared column defaults, and xUpdate can't tell an omitted column from an
// explicit NULL, so an omitted column with a DEFAULT comes back NULL. Documented
// here so the behaviour is explicit (see also index/trigger/FK, which vtabs also
// can't have).
// The vtab honors the SQL conflict clause via sqlite3_vtab_on_conflict: OR REPLACE
// replaces the conflicting row, OR IGNORE skips, plain INSERT rejects. The cache is
// resynced (marked dirty) after REPLACE/IGNORE, which delete/skip behind the vtab.
test("conflict clauses are honored (REPLACE / IGNORE / default ABORT)", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE t USING anki(sku TEXT UNIQUE, body TEXT VECTOR);`);
    db.exec(`INSERT INTO t(sku, body) VALUES ('A', 'a managed cloud database');`);

    // OR IGNORE: the duplicate is silently skipped; the original stays.
    db.exec(`INSERT OR IGNORE INTO t(sku, body) VALUES ('A', 'ignored text');`);
    assert.equal(db.selectValue(`SELECT count(*) FROM t`), 1);
    assert.equal(db.selectValue(`SELECT body FROM t WHERE sku='A'`), "a managed cloud database");

    // OR REPLACE: the duplicate replaces the row; cache resyncs so MATCH sees new text.
    db.exec(`INSERT OR REPLACE INTO t(sku, body) VALUES ('A', 'a boat on the open ocean');`);
    assert.equal(db.selectValue(`SELECT count(*) FROM t`), 1);
    assert.equal(db.selectValue(`SELECT body FROM t WHERE sku='A'`), "a boat on the open ocean");
    assert.equal(db.selectValue(`SELECT sku FROM t WHERE body MATCH 'sailing the sea'`), "A");

    // plain INSERT (default ABORT) still rejects.
    assert.throws(() => db.exec(`INSERT INTO t(sku,body) VALUES('A','x')`), /constraint/i);
    assert.equal(db.selectValue(`SELECT count(*) FROM t`), 1);
  } finally {
    db.close();
  }
});

test("DEFAULT is not applied on a vtab (documented limitation)", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE t USING anki(status TEXT DEFAULT 'active', body TEXT VECTOR);`);
    db.exec(`INSERT INTO t(body) VALUES ('a doc about the cloud');`);
    assert.equal(db.selectValue(`SELECT status FROM t`), null);
  } finally {
    db.close();
  }
});

// A single user `INTEGER PRIMARY KEY` column *becomes* the shadow rowid (no injected
// `anki_id`), so `rowid == id`, autoincrement works, and CREATE succeeds. (Every demo
// table declares `id INTEGER PRIMARY KEY` — this is the path that unbroke the demo.)
test("a single INTEGER PRIMARY KEY column becomes the rowid", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE t USING anki(id INTEGER PRIMARY KEY, title TEXT, body TEXT VECTOR);`);
    const ddl = db.selectValue(`SELECT sql FROM sqlite_master WHERE name='t_anki_data'`);
    assert.ok(!/anki_id/.test(ddl), "the user's id is the rowid — no injected anki_id");

    db.exec(`INSERT INTO t(id,title,body) VALUES (10,'a','first deal'),(20,'b','second deal');`);
    const rows = db.selectObjects(`SELECT id, rowid FROM t ORDER BY id`);
    assert.deepEqual(
      rows.map((r) => [r.id, r.rowid]),
      [[10, 10], [20, 20]],
      "rowid == id",
    );
    // A bare INSERT auto-assigns, like a normal INTEGER PRIMARY KEY.
    db.exec(`INSERT INTO t(title,body) VALUES ('c','third deal')`);
    assert.equal(db.selectValue(`SELECT id FROM t WHERE title='c'`), 21);
    // Duplicate id rejected; update/delete/search all work alongside the PK.
    assert.throws(() => db.exec(`INSERT INTO t(id,title,body) VALUES (10,'x','y')`), /constraint/i);
    db.exec(`UPDATE t SET title='a2' WHERE id=10`);
    assert.equal(db.selectValue(`SELECT title FROM t WHERE id=10`), "a2");
    db.exec(`DELETE FROM t WHERE id=20`);
    assert.equal(db.selectValue(`SELECT count(*) FROM t`), 2);
    assert.equal(
      db.selectObjects(`SELECT id FROM t WHERE body MATCH 'first deal' ORDER BY body_score DESC`)[0].id,
      10,
      "search returns the row's id (== rowid)",
    );
  } finally {
    db.close();
  }
});

// A non-integer PRIMARY KEY can't be a rowid, so it still maps to shadow UNIQUE
// (and the vtab injects its own anki_id rowid).
test("a TEXT PRIMARY KEY maps to shadow UNIQUE (injected rowid)", () => {
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE t USING anki(code TEXT PRIMARY KEY, body TEXT VECTOR);`);
    assert.ok(/anki_id/.test(db.selectValue(`SELECT sql FROM sqlite_master WHERE name='t_anki_data'`)));
    db.exec(`INSERT INTO t(code,body) VALUES ('A','hello');`);
    assert.throws(() => db.exec(`INSERT INTO t(code,body) VALUES ('A','again')`), /constraint/i);
  } finally {
    db.close();
  }
});
