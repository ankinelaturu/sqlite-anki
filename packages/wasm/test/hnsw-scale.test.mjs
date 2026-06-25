/**
 * HNSW behaviour at scale — regression guard for the graph-disconnection bug.
 *
 * Background: the first HNSW implementation pruned each node's neighbours to the
 * "closest M" naively, which could sever the only edge into a node and leave it
 * unreachable from the entry point. The symptom was nasty and silent: at small
 * row counts everything worked (the graph was effectively complete), but past a
 * few dozen rows the *exact* nearest neighbour could go missing from results
 * entirely. The fix was the standard neighbour-selection heuristic (keep diverse
 * neighbours, with a keep-pruned fallback).
 *
 * This test plants a distinctive TARGET row among filler rows and queries with
 * TARGET's own text. The exact match (cosine ~1.0) MUST come back first at every
 * row count — if it doesn't, the graph has disconnected again.
 *
 * It's the slowest test in the suite (it embeds ~310 rows across the three
 * sizes); the row counts straddle the boundary where the old bug appeared
 * (~60).
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { withModel } from "./harness.mjs";

let sqlite3;
before(async () => {
  sqlite3 = await withModel();
});

test("exact-match query is retrieved first across row counts", () => {
  for (const n of [10, 60, 240]) {
    const db = new sqlite3.oo1.DB(":memory:");
    try {
      db.exec(`CREATE VIRTUAL TABLE docs USING anki(title TEXT, body TEXT VECTOR);`);
      const ins = db.prepare(`INSERT INTO docs(title, body) VALUES(?, ?)`);
      // n near-identical filler rows...
      for (let i = 0; i < n; i++) {
        ins.bind([`doc${i}`, `filler sentence number ${i} about unrelated topics`]).stepReset();
      }
      // ...plus one distinctive target.
      const target = "quarterly financial report showing strong revenue growth and profit";
      ins.bind(["TARGET", target]).stepReset();
      ins.finalize();

      // Querying with the target's own text: the exact match must rank #1.
      const top = db
        .selectObjects(
          `SELECT title FROM docs WHERE body MATCH $q ORDER BY similarity(body) DESC LIMIT 1`,
          { $q: target }
        )[0].title;
      assert.equal(top, "TARGET", `n=${n + 1}: exact match not retrieved first`);
    } finally {
      db.close();
    }
  }
});
