/**
 * Transaction safety for the in-memory cache.
 *
 * Writes go straight to the shadow table, so SQLite's pager rolls them back
 * with the connection automatically. The risk is the *cache*: after a rollback
 * the in-memory rows/index could diverge from the (reverted) shadow table. The
 * vtab is enrolled in transaction callbacks (module iVersion 2) and, on
 * `xRollback` / `xRollbackTo`, marks the cache dirty so the next `xFilter`
 * reloads it from the shadow table. These tests assert cache, store, and search
 * all stay consistent across ROLLBACK / COMMIT / SAVEPOINT.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { withModel } from "./harness.mjs";

let sqlite3;
before(async () => {
  sqlite3 = await withModel();
});

const names = (db) =>
  db.selectObjects(`SELECT name FROM customers ORDER BY rowid`).map((r) => r.name);

// A one-row table in autocommit state to start each transaction test from.
function fresh(sqlite3) {
  const db = new sqlite3.oo1.DB(":memory:");
  db.exec(`CREATE VIRTUAL TABLE customers USING anki(name TEXT, notes TEXT VECTOR);`);
  db.exec(`INSERT INTO customers(name,notes) VALUES('Acme','potential upsell opportunity');`);
  return db;
}

// After ROLLBACK the inserted row must vanish from all three views: the cached
// rows, a semantic search (cache reloaded so the index no longer contains it),
// and the shadow table itself.
test("ROLLBACK reverts cache, store, and search", () => {
  const db = fresh(sqlite3);
  try {
    db.exec("BEGIN");
    db.exec(`INSERT INTO customers(name,notes) VALUES('Ghost','should be rolled back')`);
    db.exec("ROLLBACK");
    assert.deepEqual(names(db), ["Acme"]);
    const found = db
      .selectObjects(`SELECT name FROM customers WHERE notes MATCH 'rolled back ghost' ORDER BY similarity(notes) DESC`)
      .map((r) => r.name);
    assert.ok(!found.includes("Ghost"));
    assert.equal(db.selectValue(`SELECT count(*) FROM "main"."customers_data"`), 1);
  } finally {
    db.close();
  }
});

// The happy path: a committed insert stays.
test("COMMIT persists", () => {
  const db = fresh(sqlite3);
  try {
    db.exec("BEGIN");
    db.exec(`INSERT INTO customers(name,notes) VALUES('Beta','billing support')`);
    db.exec("COMMIT");
    assert.deepEqual(names(db), ["Acme", "Beta"]);
  } finally {
    db.close();
  }
});

// Partial rollback via savepoints (ROLLBACK TO ... / RELEASE) must also resync
// the cache — this is what the iVersion-2 xRollbackTo hook is for. The cache row
// count must match the shadow table after the partial rollback.
test("ROLLBACK TO savepoint keeps cache consistent with the store", () => {
  const db = fresh(sqlite3);
  try {
    db.exec("SAVEPOINT sp1");
    db.exec(`INSERT INTO customers(name,notes) VALUES('Ghost','temp')`);
    db.exec("ROLLBACK TO sp1");
    db.exec("RELEASE sp1");
    const cache = names(db);
    const shadow = db.selectValue(`SELECT count(*) FROM "main"."customers_data"`);
    assert.deepEqual(cache, ["Acme"]);
    assert.equal(cache.length, shadow);
  } finally {
    db.close();
  }
});
