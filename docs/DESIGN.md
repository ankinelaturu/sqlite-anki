# sqlite-anki — Design Specification

This document captures the full design for **sqlite-anki**: a SQLite extension that adds semantic text search for browser deployments using official SQLite WASM.

---

## Table of contents

1. [Goals](#1-goals)
2. [User-facing SQL API](#2-user-facing-sql-api)
3. [Defaults and query semantics](#3-defaults-and-query-semantics)
4. [Architecture overview](#4-architecture-overview)
5. [Virtual table module](#5-virtual-table-module)
6. [Storage model](#6-storage-model)
7. [Write path](#7-write-path)
8. [Read path and query execution](#8-read-path-and-query-execution)
9. [HNSW indexing](#9-hnsw-indexing)
10. [Embedding and inference](#10-embedding-and-inference)
11. [Model loading strategies](#11-model-loading-strategies)
12. [v1 approach: pre-bundled WASM per model](#12-v1-approach-pre-bundled-wasm-per-model)
13. [Rust and SQLite WASM build](#13-rust-and-sqlite-wasm-build)
14. [JavaScript integration](#14-javascript-integration)
15. [Sync, async, and workers](#15-sync-async-and-workers)
16. [Model changes and reindexing](#16-model-changes-and-reindexing)
17. [Package layout (proposed)](#17-package-layout-proposed)
18. [Tradeoffs and decisions](#18-tradeoffs-and-decisions)
19. [Future work](#19-future-work)
20. [References](#20-references)

---

## 1. Goals

### What we are building

A SQLite extension called **sqlite-anki** that:

1. Provides an `anki` virtual table module with `TEXT VECTOR` columns.
2. Automatically generates and stores embeddings when text is inserted or updated.
3. Supports semantic search via `WHERE column MATCH 'query text'`.
4. Exposes `similarity(column)` for per-query threshold overrides, filtering, and ordering.
5. Uses HNSW for approximate nearest-neighbor (ANN) search.
6. Runs entirely inside WebAssembly in the browser using the **official SQLite WASM** build.
7. Performs inference in **Rust** (ONNX via Tract or similar) — **no JavaScript callbacks during SQL execution**.

### What we are not building (initially)

- Keyword full-text search (FTS5). `MATCH` here means **semantic** matching.
- Normal `CREATE TABLE` with automatic embedding (deferred to v2).
- Custom PRAGMA statements (`PRAGMA anki_*`).
- Dynamically loadable `.wasm` extensions at runtime (not supported in browser WASM).
- Xenova / transformers.js for inference (those are JavaScript libraries).

### Design principles

| Principle | Rationale |
|-----------|-----------|
| `CREATE VIRTUAL TABLE ... USING anki` for v1 | Lets the extension own `MATCH`, planner integration, and HNSW |
| Native inference in WASM | Predictable performance; no JS bridge on hot path |
| Static link into SQLite WASM | Only viable delivery model in browsers |
| Sensible built-in defaults | Default similarity ≥ 0.5; internal ANN cap 256; no user config surface |

---

## 2. User-facing SQL API

### Virtual table: `USING anki`

v1 tables are created with the `anki` virtual table module:

```sql
CREATE VIRTUAL TABLE customers USING anki(
  customer_name TEXT,
  notes TEXT VECTOR
);
```

`TEXT VECTOR` declares a semantic text column. The extension stores the plain text and manages embeddings internally. Users never insert or read raw embedding BLOBs.

Regular `TEXT`, `INTEGER`, and other column types are supported alongside `TEXT VECTOR` columns in the same virtual table.

### Semantic search: `MATCH`

```sql
SELECT customer_name
FROM customers
WHERE notes MATCH 'potential opportunity';
```

`MATCH` performs **semantic** matching:

1. The query string is embedded.
2. HNSW retrieves up to **256** nearest candidates (fixed internal cap).
3. Rows with cosine similarity **≥ 0.5** are returned (default threshold).

To require a higher bar, add an explicit filter:

```sql
WHERE notes MATCH 'potential opportunity'
  AND similarity(notes) > 0.7
```

### `similarity(column)` — not a stored column

There is **no `score` column** on the table. `similarity(notes)` is a SQL **function** provided by the extension. It returns the cosine similarity (0.0–1.0) between that row's stored embedding and the current `MATCH` query embedding.

It is only meaningful in queries that include a `MATCH` on the same column.

```sql
SELECT customer_name, similarity(notes)
FROM customers
WHERE notes MATCH 'potential opportunity'
  AND similarity(notes) > 0.7
ORDER BY similarity(notes) DESC
LIMIT 10;
```

`AS score` in a `SELECT` list is optional aliasing — not a table column.

| Function | Behavior |
|----------|----------|
| `similarity(column)` | Cosine similarity for the row against the active `MATCH` query |
| With `MATCH` | Both use the same query embedding and HNSW candidate set |

`MATCH` alone does **not** guarantee result order. Use `ORDER BY similarity(column) DESC` for best-first results.

### `LIMIT`

Use standard SQL `LIMIT` to cap how many rows are returned:

```sql
SELECT customer_name
FROM customers
WHERE notes MATCH 'potential opportunity'
ORDER BY similarity(notes) DESC
LIMIT 10;
```

`LIMIT` controls the **final result count**. It is separate from the internal HNSW candidate cap (256).

### Introspection (optional)

```sql
SELECT anki_model();    -- e.g. 'all-MiniLM-L6-v2' (read-only in v1)
SELECT anki_dim();      -- e.g. 384
SELECT anki_version();  -- extension version
```

### Full example

```sql
CREATE VIRTUAL TABLE customers USING anki(
  customer_name TEXT,
  notes TEXT VECTOR
);

INSERT INTO customers (customer_name, notes) VALUES
  ('Acme Corp', 'Discussed renewal — potential upsell opportunity in Q3'),
  ('Beta LLC',  'Support ticket about billing, no sales interest');

SELECT customer_name
FROM customers
WHERE notes MATCH 'potential opportunity'
  AND similarity(notes) > 0.6
ORDER BY similarity(notes) DESC
LIMIT 10;
```

---

## 3. Defaults and query semantics

There are **no custom PRAGMAs** in v1. SQLite extensions cannot register arbitrary `PRAGMA` statements without a custom VFS; we do not use that approach.

All defaults are **built into query semantics**:

| Default | Value | How to override |
|---------|-------|-----------------|
| `MATCH` similarity threshold | **≥ 0.5** (cosine similarity) | `AND similarity(column) > X` in `WHERE` |
| HNSW candidate cap | **256** (fixed, internal) | Not user-configurable in v1 |
| Result count | Unlimited | SQL `LIMIT N` |
| Result order | Undefined | `ORDER BY similarity(column) DESC` |

### Query pipeline

```
query text
  → embed once → query vector
  → HNSW: nearest 256 candidates
  → filter: similarity >= 0.5 (or stricter per-query threshold)
  → ORDER BY similarity(column) DESC  (if requested)
  → SQL LIMIT  (if present)
```

If both the default threshold and an explicit filter apply, the **stricter** condition wins (e.g. `MATCH` at 0.5 plus `similarity(notes) > 0.7` → only rows above 0.7).

---

## 4. Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│  User SQL                                                        │
│  CREATE VIRTUAL TABLE ... USING anki(...)                        │
│  INSERT / UPDATE / DELETE                                        │
│  WHERE notes MATCH '...' AND similarity(notes) > 0.6             │
│  ORDER BY similarity(notes) DESC LIMIT 10                        │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  sqlite-anki extension (Rust, inside sqlite3.wasm)               │
│                                                                  │
│  ┌──────────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ anki vtab module │  │ Embedder     │  │ xBestIndex/xFilter│  │
│  │ xCreate/xInsert  │→ │ tokenizer +  │  │ MATCH constraint  │  │
│  │ xUpdate/xDelete  │  │ ONNX/Tract   │  │ similarity()      │  │
│  └────────┬─────────┘  └──────────────┘  └─────────┬─────────┘  │
│           │                                         │            │
│           ▼                                         ▼            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Per-table vector storage + HNSW index (module-internal)   │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

The `anki` virtual table module owns the full lifecycle: DDL, writes, vector storage, HNSW, and planner-driven `MATCH` queries.

---

## 5. Virtual table module

### Why virtual tables for v1

SQLite integrates custom search semantics (including `MATCH`) through **virtual table modules**. The module receives `MATCH` constraints via `xBestIndex` / `xFilter` and can drive row production from the HNSW index directly.

A normal `CREATE TABLE` with scalar `match()` functions would evaluate row-by-row and would not integrate with the query planner. That pattern is deferred to v2.

This matches how FTS5, sqlite-vec, and similar extensions work.

### Module responsibilities

| Callback | Role |
|----------|------|
| `xCreate` / `xConnect` | Parse column definitions; initialize per-table state |
| `xDisconnect` / `xDestroy` | Tear down per-table state |
| `xOpen` / `xClose` | Cursor lifecycle |
| `xFilter` / `xNext` / `xColumn` | Row production for `MATCH` queries |
| `xBestIndex` | Accept `MATCH` constraints; plan HNSW-driven scans |
| `xUpdate` | Handle `INSERT`, `UPDATE`, `DELETE`; trigger embedding on `TEXT VECTOR` changes |
| `xFindFunction` | Resolve `similarity(column)` for the vtab |

### Column types in `CREATE VIRTUAL TABLE`

```sql
CREATE VIRTUAL TABLE docs USING anki(
  title TEXT,
  body TEXT VECTOR,
  published INTEGER
);
```

- `TEXT VECTOR` → semantic column; text stored, embedding managed internally.
- Other types → stored and returned as normal virtual table columns.

---

## 6. Storage model

### User-visible schema

```sql
CREATE VIRTUAL TABLE customers USING anki(
  customer_name TEXT,
  notes TEXT VECTOR
);
```

`SELECT notes FROM customers` returns the plain text. Embeddings are not exposed as columns.

### Internal storage (per virtual table)

Each `anki` virtual table maintains internal storage for vectors and the HNSW index. Exact representation is an implementation detail; conceptually:

```sql
-- Conceptual per-vtab backing (not user-visible)
anki_vtab_<name>_vectors (
  rowid      INTEGER PRIMARY KEY,
  col_index  INTEGER,          -- which TEXT VECTOR column
  text       TEXT,
  embedding  BLOB,             -- float32[dim]
  updated_at INTEGER
);

anki_vtab_<name>_hnsw (
  col_index  INTEGER PRIMARY KEY,
  data       BLOB              -- serialized HNSW per vector column
);
```

### Database metadata (`anki_meta`)

```sql
anki_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
```

| Key | Example | Purpose |
|-----|---------|---------|
| `model_id` | `all-MiniLM-L6-v2` | Model baked into this WASM build |
| `embed_dim` | `384` | Vector dimension |
| `build_id` | `all-MiniLM-L6-v2@0.1.0` | WASM package version |

---

## 7. Write path

### Flow

```
INSERT / UPDATE on anki virtual table
        │
        ▼
xUpdate receives new column values
        │
        ▼
For each changed TEXT VECTOR column:
        │
        ▼
Tokenize (Rust tokenizers crate)
        │
        ▼
ONNX inference (Tract) → float32[dim]
        │
        ▼
Store text + embedding in internal vector storage
        │
        ▼
Insert / update vector in HNSW index
        │
        ▼
Persist serialized HNSW on commit
```

### Deletes

`DELETE` via `xUpdate` removes the row's vector entries and HNSW nodes.

---

## 8. Read path and query execution

### Flow

```
WHERE notes MATCH 'potential opportunity'
        │
        ▼
xBestIndex: SQLITE_INDEX_CONSTRAINT_MATCH on notes column
        │
        ▼
xFilter: receive query text; embed once
        │
        ▼
HNSW search → up to 256 candidate rowids
        │
        ▼
Filter: cosine similarity >= 0.5 (or per-query override)
        │
        ▼
xNext / xColumn: emit matching rows
        │
        ▼
similarity(notes) returns score for current row
        │
        ▼
SQLite applies ORDER BY / LIMIT
```

Because the virtual table module owns `MATCH`, HNSW drives row production directly — no per-row table scan and no query-scoped cache workaround.

---

## 9. HNSW indexing

### Why HNSW

Exact brute-force similarity is O(n) per query. HNSW (Hierarchical Navigable Small World) provides fast approximate nearest-neighbor search, suitable for interactive browser use.

### Rust crate options

| Crate | Notes |
|-------|-------|
| [usearch](https://crates.io/crates/usearch) | Mature HNSW; used by sqlite-vector-rs |
| [hnsw_rs](https://crates.io/crates/hnsw_rs) | Pure Rust HNSW |
| [vector-lite](https://crates.io/crates/vector-lite) | Compact; WASM support |

### Fixed internal parameters (v1)

These are **implementation constants**, not user configuration:

| Parameter | v1 value | Notes |
|-----------|----------|-------|
| HNSW candidate cap | **256** | Max neighbors retrieved per `MATCH` query |
| Default similarity threshold | **0.5** | Applied by `MATCH` unless overridden |
| HNSW `M` | 16 | Graph connectivity (tunable in code) |
| HNSW `ef_search` | 64 | Search quality (tunable in code) |

### `LIMIT` vs internal candidate cap

| Concept | Controlled by | Purpose |
|---------|---------------|---------|
| Internal candidate cap (256) | Fixed in extension | How many neighbors HNSW retrieves before threshold filtering |
| SQL `LIMIT` | User in query | Max rows returned after filtering and ordering |

Example: HNSW may retrieve 256 candidates, 40 pass the ≥ 0.5 threshold, `LIMIT 10` returns the top 10 by `ORDER BY similarity(notes) DESC`.

---

## 10. Embedding and inference

### Stack

| Component | Role |
|-----------|------|
| **Rust** | Extension implementation language |
| **Tract** (or `ort` + Emscripten) | ONNX inference inside WASM |
| **tokenizers** crate | HuggingFace-compatible tokenization |
| **ONNX model** | Pre-converted sentence embedding model |
| **tokenizer.json** | Bundled alongside ONNX |

### Default model: `all-MiniLM-L6-v2`

| Property | Value |
|----------|-------|
| Dimensions | 384 |
| Size (quantized ONNX) | ~23 MB |
| Quality / speed | Good default for browser |
| HuggingFace ID | `sentence-transformers/all-MiniLM-L6-v2` |

The `Xenova/all-MiniLM-L6-v2` prefix is an npm packaging convention. At the Rust/native layer we use the same underlying ONNX weights, not the Xenova JavaScript runtime.

### Supported model requirements

A model must:

1. Be available as **ONNX** (pre-converted or shipped pre-converted).
2. Use a **HuggingFace tokenizer** (`tokenizer.json`).
3. Produce a **fixed-size sentence embedding** (e.g. mean-pooled BERT output).

### Inference during SQL (no JavaScript)

```
INSERT INTO customers (notes) VALUES ('hello');
  → xUpdate → Rust tokenize + ONNX infer → store embedding

WHERE notes MATCH 'hello';
  → xFilter → embed query in Rust → HNSW search
  → no JS involved
```

---

## 11. Model loading strategies

There are three strategies. **v1 uses Strategy C.**

### Strategy A — App passes bytes once (bootstrap)

The app fetches ONNX + tokenizer and passes bytes to the extension once at init. Not used in v1.

### Strategy B — Extension reads from OPFS

Extension loads model files from OPFS via the SQLite VFS. Deferred to v2.

### Strategy C — Pre-bundled per WASM build (v1)

Ship one WASM artifact per model. ONNX + tokenizer are embedded at compile time via `include_bytes!`. No model install step. User picks the model by choosing the npm package.

See [§12](#12-v1-approach-pre-bundled-wasm-per-model).

---

## 12. v1 approach: pre-bundled WASM per model

### Rationale

- One npm import → pure SQL immediately
- No model install or byte-passing
- Deterministic embeddings per package version
- Easier golden-vector testing

### Artifacts

| Artifact | Contents |
|----------|----------|
| `sqlite-anki-all-MiniLM-L6-v2.wasm` | SQLite + extension + MiniLM ONNX + tokenizer |
| `sqlite-anki-all-MiniLM-L6-v2.js` | Emscripten loader / official SQLite JS API |

### npm packages

```
@sqlite-anki/all-MiniLM-L6-v2     ← default, recommended
@sqlite-anki/bge-small-en-v1.5   ← optional, larger
```

```javascript
import sqlite3Init from '@sqlite-anki/all-MiniLM-L6-v2';
const sqlite3 = await sqlite3Init();
const db = new sqlite3.oo1.DB();
```

### Introspection

```sql
SELECT anki_model();   -- read-only: 'all-MiniLM-L6-v2'
SELECT anki_dim();     -- read-only: 384
```

---

## 13. Rust and SQLite WASM build

### Browser WASM: no dynamic loading

Extensions must be **statically linked** at compile time via `sqlite3_wasm_extra_init.c` + `sqlite3_auto_extension()`.

### Extension init

```c
int sqlite3_wasm_extra_init(const char *z) {
    return sqlite3_auto_extension((void(*)(void))sqlite3_anki_init);
}
```

```rust
#[no_mangle]
pub extern "C" fn sqlite3_anki_init(
    db: *mut sqlite3,
    pz_err_msg: *mut *mut c_char,
    p_api: *const sqlite3_api_routines,
) -> c_int {
    // 1. Register anki virtual table module
    // 2. Register similarity(), anki_model(), anki_dim(), anki_version()
    // 3. Initialize bundled embedder (lazy)
    SQLITE_OK
}
```

---

## 14. JavaScript integration

### v1 usage (zero setup)

```javascript
import sqlite3Init from '@sqlite-anki/all-MiniLM-L6-v2';

const sqlite3 = await sqlite3Init();
const db = new sqlite3.oo1.DB(':memory:');

db.exec(`
  CREATE VIRTUAL TABLE customers USING anki(
    customer_name TEXT,
    notes TEXT VECTOR
  );
`);

db.exec(`INSERT INTO customers (customer_name, notes) VALUES
  ('Acme', 'potential upsell opportunity in Q3')`);

const rows = db.selectObjects(`
  SELECT customer_name, similarity(notes)
  FROM customers
  WHERE notes MATCH 'potential opportunity'
  ORDER BY similarity(notes) DESC
  LIMIT 10
`);

console.log(rows);
db.close();
```

### Worker recommendation

Run SQLite in a **Web Worker**. Embedding inference blocks the thread.

---

## 15. Sync, async, and workers

| Phase | Blocking? | Where |
|-------|-----------|-------|
| WASM + model load (v1 bundled) | One-time ONNX parse | Worker recommended |
| `INSERT` with new text | Yes — tokenize + infer | Worker |
| `MATCH` query | Yes — embed query + HNSW | Worker |

Pre-bundled models eliminate network fetch. All inference is synchronous inside WASM.

---

## 16. Model changes and reindexing

### Within one v1 WASM build

Model is fixed. Reindexing is only needed after extension upgrade or corrupted index data:

```sql
SELECT anki_reindex('customers');
```

### Switching npm packages (different model)

Embeddings are incompatible. Detect `build_id` mismatch in `anki_meta` and require reindex or reject `MATCH`.

---

## 17. Package layout (proposed)

```
sqlite-anki/
├── crates/
│   ├── anki-core/              # Rust: vtab module, embedder, HNSW, SQL functions
│   ├── anki-wasm-minilm/       # include_bytes! for MiniLM; links into SQLite WASM
│   └── anki-wasm-bge/          # optional second model build
├── wasm/
│   ├── sqlite3_wasm_extra_init.c
│   └── Makefile
├── models/
│   └── all-MiniLM-L6-v2/
│       ├── model.onnx
│       ├── tokenizer.json
│       └── config.json
└── docs/
    ├── README.md
    └── DESIGN.md
```

---

## 18. Tradeoffs and decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | Rust | WASM-friendly; ONNX via Tract |
| SQLite distribution | Official WASM | OPFS, workers, long-term support |
| Extension loading | Static link | Only option in browser |
| User DDL (v1) | `CREATE VIRTUAL TABLE ... USING anki` | Planner-integrated `MATCH` + HNSW |
| Search syntax | `MATCH` + `similarity()` | Familiar FTS-like ergonomics |
| Default threshold | Similarity ≥ 0.5 | Built into `MATCH`; override in `WHERE` |
| ANN candidate cap | 256 (fixed internal) | Good recall for browser-scale data |
| Result count | SQL `LIMIT` | Standard, user-controlled |
| Configuration | No PRAGMAs | Extensions cannot add PRAGMAs without custom VFS |
| ANN algorithm | HNSW | Fast enough for interactive browser queries |
| v1 model delivery | Pre-bundled per WASM | Simplest; no install step |
| Inference runtime | Rust/Tract, not Xenova | No JS on hot path |
| Threading | Worker | Sync inference blocks; keep off main thread |

### Known limitations

| Limitation | Notes |
|------------|-------|
| Requires `CREATE VIRTUAL TABLE` in v1 | Normal `CREATE TABLE` deferred to v2 |
| Large WASM downloads | ~25–40 MB for MiniLM variant |
| No cross-model embedding comparison | Switching packages requires reindex |
| Fixed internal ANN cap | 256 candidates; not tunable by users in v1 |
| Model support | Sentence-transformer ONNX models only (initially) |

---

## 19. Future work

- [ ] Normal `CREATE TABLE` with `TEXT VECTOR` (auto-shadow + hooks) for nicer DX
- [ ] Dynamic model selection and OPFS model cache
- [ ] Per-column model override in column definitions
- [ ] Native (non-WASM) loadable extension for desktop SQLite
- [ ] Quantized embedding storage (float16) to reduce disk use
- [ ] `anki_explain(query)` — embedding time, HNSW stats, candidate count
- [ ] Optional custom PRAGMA syntax via JS wrapper sugar (not raw extension)

---

## 20. References

| Resource | URL |
|----------|-----|
| Official SQLite WASM | https://sqlite.org/wasm |
| SQLite WASM build guide | https://sqlite.org/wasm/doc/trunk/building.md |
| SQLite virtual table module | https://www.sqlite.org/vtab.html |
| sqlite-vec WASM | https://alexgarcia.xyz/sqlite-vec/wasm.html |
| sqlite-rust-wasm | https://github.com/tantaman/sqlite-rust-wasm |
| Tract (Rust ONNX) | https://github.com/sonos/tract |
| all-MiniLM-L6-v2 | https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2 |
| usearch (HNSW) | https://github.com/unum-cloud/usearch |

---

*Last updated: June 2025*
