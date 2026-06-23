# sqlite-anki Documentation

**sqlite-anki** is a SQLite extension that adds semantic text search to databases running in the browser via WebAssembly. It stores text and embeddings together, and supports natural SQL patterns like `WHERE notes MATCH 'some query'`.

## Documents

| Document | Description |
|----------|-------------|
| [DESIGN.md](./DESIGN.md) | Full design specification — architecture, SQL API, models, WASM build, and tradeoffs |

## Quick summary

- **Tables:** `CREATE VIRTUAL TABLE ... USING anki(...)` (v1)
- **Column type:** `TEXT VECTOR` — stores text; embeddings generated on insert/update
- **Search:** `WHERE column MATCH 'query'` — semantic matching (default similarity ≥ 0.5)
- **Scoring:** `similarity(column)` — computed at query time (not a stored column)
- **Indexing:** HNSW with a fixed internal candidate cap of **256**; use SQL `LIMIT` for result count
- **Runtime:** Rust extension statically linked into [official SQLite WASM](https://sqlite.org/wasm)
- **v1 model strategy:** Pre-bundle one model per WASM build (e.g. `@sqlite-anki/all-MiniLM-L6-v2`)

## Example

```sql
CREATE VIRTUAL TABLE customers USING anki(
  customer_name TEXT,
  notes TEXT VECTOR
);

INSERT INTO customers (customer_name, notes)
VALUES ('Acme Corp', 'Discussed renewal — potential upsell opportunity in Q3');

SELECT customer_name
FROM customers
WHERE notes MATCH 'potential opportunity'
  AND similarity(notes) > 0.6
ORDER BY similarity(notes) DESC
LIMIT 10;
```

```javascript
import sqlite3Init from '@sqlite-anki/all-MiniLM-L6-v2';

const sqlite3 = await sqlite3Init();
const db = new sqlite3.oo1.DB();
// SQL above works immediately — no model install step in v1
```
