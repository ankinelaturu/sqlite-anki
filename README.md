# sqlite-anki

Semantic text search for SQLite in the browser (WebAssembly).

Store text in `TEXT VECTOR` columns, search with `MATCH`, filter and sort with `similarity()`. Embeddings are generated automatically in Rust — no JavaScript on the query hot path.

## Documentation

See **[docs/DESIGN.md](./docs/DESIGN.md)** for the full design specification.

## Quick example

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
ORDER BY similarity(notes) DESC
LIMIT 10;
```

```javascript
import sqlite3Init from '@sqlite-anki/all-MiniLM-L6-v2';

const sqlite3 = await sqlite3Init();
const db = new sqlite3.oo1.DB();
```

## Key decisions (v1)

| Topic | Decision |
|-------|----------|
| Table DDL | `CREATE VIRTUAL TABLE ... USING anki(...)` |
| Default `MATCH` threshold | Cosine similarity ≥ **0.5** (override with `similarity(col) > X`) |
| ANN candidate cap | Fixed **256** internally; use SQL `LIMIT` for result count |
| Configuration | No custom PRAGMAs |
| Model | Pre-bundled per WASM package (e.g. `all-MiniLM-L6-v2`) |

## Status

Design phase — implementation not yet started.
