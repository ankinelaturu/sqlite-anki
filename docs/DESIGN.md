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
17. [Package layout and workspace](#17-package-layout-and-workspace)
18. [Explorer test app](#18-explorer-test-app)
19. [Persistence (OPFS)](#19-persistence-opfs)
20. [Technology stack](#20-technology-stack)
21. [Implementation roadmap](#21-implementation-roadmap)
22. [Tradeoffs and decisions](#22-tradeoffs-and-decisions)
23. [Future work](#23-future-work)
24. [References](#24-references)

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
7. Performs inference in **Rust** (ONNX via **Tract**) — **no JavaScript callbacks during SQL execution**.
8. Persists databases in the browser via **OPFS** (official SQLite WASM OPFS VFS).

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

### Parameterized `MATCH`

Bound parameters must work in real applications:

```sql
SELECT customer_name
FROM customers
WHERE notes MATCH ?;
```

The virtual table module receives the query text from `xFilter` whether it comes from a string literal or a bound parameter.

### Multiple `TEXT VECTOR` columns

A single virtual table may declare multiple semantic columns. Each gets its own HNSW index.

```sql
CREATE VIRTUAL TABLE docs USING anki(
  title  TEXT VECTOR,
  body   TEXT VECTOR,
  author TEXT
);

SELECT title
FROM docs
WHERE title MATCH 'quarterly results'
  AND body MATCH 'revenue growth';
```

| Rule | Behavior |
|------|----------|
| Indexes | One HNSW index per `TEXT VECTOR` column |
| `WHERE title MATCH 'x'` | Searches the title index only |
| `WHERE body MATCH 'y'` | Searches the body index only |
| Both in one query | Two independent searches; combined with `AND` |
| `similarity(title)` | Score against the `title` column's `MATCH` query |
| `similarity(body)` | Score against the `body` column's `MATCH` query |

### `NULL` and empty text

| Value | Embedding | `MATCH` | `similarity(column)` |
|-------|-----------|---------|----------------------|
| `NULL` | None stored | Row excluded | `NULL` |
| `''` (empty string) | None stored | Row excluded | `NULL` |

Non-empty text is embedded on insert/update. Setting a column to `NULL` or `''` removes its vector from storage and the HNSW index.

### `similarity()` without `MATCH`

If `similarity(column)` appears without a `MATCH` on the same column in the query, it returns `NULL`.

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

- `TEXT VECTOR` → semantic column; text stored, embedding managed internally; one HNSW index per column.
- Other types → stored and returned as normal virtual table columns.
- Multiple `TEXT VECTOR` columns per table are **required** in v1.

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
If value is NULL or '' → remove vector + HNSW entry; skip embedding
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

### Chosen crate: `hnsw_rs`

v1 uses **[hnsw_rs](https://crates.io/crates/hnsw_rs)** — pure Rust HNSW with a straightforward `wasm32-unknown-unknown` story. [usearch](https://crates.io/crates/usearch) is excellent on native/desktop but its C++ core makes browser WASM integration harder; it is not used in v1.

One `hnsw_rs` index is maintained per `TEXT VECTOR` column per virtual table. Indexes are serialized to the database backing store and rebuilt on load if needed.

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

### Stack (chosen)

| Component | Crate / artifact | Role |
|-----------|------------------|------|
| Extension API | `sqlite3_ext` / `ext-sqlite3-rs` | Virtual table module, SQL functions |
| ONNX inference | **[Tract](https://github.com/sonos/tract)** (`tract-onnx`) | Pure Rust; single WASM module with SQLite |
| Tokenization | **tokenizers** | HuggingFace-compatible `tokenizer.json` |
| HNSW | **hnsw_rs** | Per-column approximate nearest-neighbor index |
| Model | **quantized `model.onnx`** | Pinned in `models/all-MiniLM-L6-v2/` |

Tract is chosen over ONNX Runtime (`ort`) because it compiles cleanly to `wasm32-unknown-unknown` without a separate Emscripten C++ WASM module or JS bridge.

### ONNX artifact

Ship a **quantized** ONNX export of `sentence-transformers/all-MiniLM-L6-v2` in the repo:

```
models/all-MiniLM-L6-v2/
  model.onnx        # INT8 or dynamic-quantized (~20–25 MB)
  tokenizer.json
  config.json       # pooling=mean, dim=384
```

Pin the exact ONNX file in version control. Add a golden test: fixed input string → expected embedding (hash or first N floats) to catch model drift across builds.

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

### Strategy B — Extension reads model from OPFS

Extension loads model files from OPFS via a custom path. Deferred to v2 (v1 bundles the model in WASM).

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
// OPFS-backed persistence (official SQLite WASM OPFS VFS)
const db = new sqlite3.oo1.OpfsDb('/customers.db');

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

## 17. Package layout and workspace

Monorepo: **Rust workspace** (extension) + **pnpm workspace** (TypeScript packages and apps).

```
sqlite-anki/
├── Cargo.toml                    # Rust workspace root
├── package.json                  # pnpm workspace root
├── pnpm-workspace.yaml
├── crates/
│   ├── anki-core/                # vtab module, Tract embedder, hnsw_rs
│   └── anki-wasm-minilm/         # include_bytes! model; links into SQLite WASM
├── wasm/
│   ├── sqlite3_wasm_extra_init.c
│   └── README.md                 # build instructions (Makefile when wired)
├── models/
│   └── all-MiniLM-L6-v2/         # ONNX + tokenizer (not committed until pinned)
├── packages/
│   ├── wasm-minilm/              # @sqlite-anki/wasm-minilm — sqlite3.js + .wasm
│   └── db-client/                # @sqlite-anki/db-client — worker + schema + CRUD
├── apps/
│   └── explorer/                 # @sqlite-anki/explorer — SPA test harness
├── scripts/
│   └── build-wasm.sh
├── docs/
│   └── DESIGN.md
└── README.md
```

| Path | Role |
|------|------|
| `crates/` | Rust sqlite-anki extension (no UI) |
| `packages/wasm-minilm/` | WASM bundle consumed by apps; stub uses `@sqlite.org/sqlite-wasm` until custom build |
| `packages/db-client/` | Typed TS API: OPFS worker, schema introspection, CRUD, semantic search |
| `apps/explorer/` | Two-panel SPA for manual testing |
| `scripts/build-wasm.sh` | Builds custom WASM and copies into `packages/wasm-minilm/dist/` |

---

## 18. Explorer test app

`apps/explorer` is the **integration test harness** for sqlite-anki in the browser.

### Layout

```
┌────────────────────────────────────────────────────────────┐
│  sqlite-anki Explorer                                       │
├──────────────────┬─────────────────────────────────────────┤
│  Schema tree     │  Data grid + toolbar                     │
│  (tables/cols)   │  (CRUD, semantic search for VECTOR cols) │
└──────────────────┴─────────────────────────────────────────┘
```

### Left panel — schema explorer

- Tree of tables from `sqlite_master` (user tables only).
- Children: columns from `PRAGMA table_info`, with **TEXT VECTOR** badges.
- Selecting a table loads its data in the right panel.

### Right panel — data grid

| Feature | SQL |
|---------|-----|
| List rows | `SELECT rowid, * FROM table LIMIT …` |
| Inline edit | `UPDATE … SET col = ? WHERE rowid = ?` |
| Add row | `INSERT INTO …` |
| Delete row | `DELETE FROM … WHERE rowid = ?` |

When a `TEXT VECTOR` column is present, a **semantic search bar** runs:

```sql
SELECT rowid, * FROM t
WHERE col MATCH ?
ORDER BY similarity(col) DESC
LIMIT 20;
```

(requires sqlite-anki extension in the WASM build)

### Architecture

```
apps/explorer  →  packages/db-client  →  Web Worker  →  sqlite3.wasm (OPFS)
```

- Vite dev server sets **COOP/COEP** headers required for OPFS.
- Worker uses `@sqlite-anki/wasm-minilm` (custom build when available).

### Commands

```bash
pnpm install
pnpm dev          # explorer at http://localhost:5173
pnpm build:wasm   # custom sqlite-anki WASM (when toolchain ready)
```

---

## 19. Persistence (OPFS)

v1 requires **browser database persistence**. Use the official SQLite WASM **OPFS VFS** so data (virtual table rows, vector storage, serialized HNSW) survives page reloads.

```javascript
import sqlite3Init from '@sqlite-anki/all-MiniLM-L6-v2';

const sqlite3 = await sqlite3Init();
const db = new sqlite3.oo1.OpfsDb('/my-app.db');
```

| Storage | v1 |
|---------|-----|
| Database file | OPFS via `OpfsDb` |
| Embedding model | Pre-bundled in WASM (`include_bytes!`) |
| Model files on OPFS | Deferred to v2 (dynamic model selection) |

The v0 spike may use `:memory:` only. v1 ships with OPFS as the default persistence story.

---

## 20. Technology stack

Locked-in choices for implementation:

| Layer | Choice | Why |
|-------|--------|-----|
| Language | Rust | WASM extension + inference in one module |
| SQLite | Official WASM (Emscripten) | OPFS, workers, long-term support |
| Extension API | `sqlite3_ext` | Virtual table module |
| ONNX runtime | **Tract** | Pure Rust; `wasm32-unknown-unknown` |
| Tokenizer | **tokenizers** | `tokenizer.json` from HuggingFace |
| ANN index | **hnsw_rs** | Pure Rust; avoids C++/WASM friction |
| Default model | Quantized **all-MiniLM-L6-v2** ONNX | 384d; ~20–25 MB; good browser default |
| Model delivery | Pre-bundled per WASM package | No install step |
| DB persistence | **OPFS** | Browser durability |

---

## 21. Implementation roadmap

### v0 spike — prove WASM stack (throwaway prototype)

Validate the risky parts before building the full virtual table:

1. Rust `wasm32` crate with `include_bytes!("model.onnx")` + `tokenizer.json`
2. Tract: embed one fixed string → 384-dim vector
3. hnsw_rs: insert a few vectors → query top-5
4. Optional: link into minimal SQLite WASM build

### v0.1 — minimal virtual table

- `:memory:` database only
- One `TEXT VECTOR` column
- `INSERT` + literal `MATCH`
- No OPFS, no parameterized queries yet

### Explorer app (parallel track)

- Schema tree + CRUD grid on stock SQLite WASM (current)
- Wire semantic search when custom `anki` WASM is available
- Seed demo `CREATE VIRTUAL TABLE … USING anki(…)` from UI

### v1 — shippable release

- `CREATE VIRTUAL TABLE ... USING anki(...)`
- Multiple `TEXT VECTOR` columns (one HNSW index each)
- Parameterized `MATCH` (`MATCH ?`)
- `NULL` / `''` rules
- OPFS persistence (`OpfsDb`)
- Pre-bundled `@sqlite-anki/all-MiniLM-L6-v2` npm package
- Golden embedding test (pinned ONNX)

---

## 22. Tradeoffs and decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | Rust | WASM-friendly; Tract + hnsw_rs in one module |
| SQLite distribution | Official WASM | OPFS, workers, long-term support |
| Extension loading | Static link | Only option in browser |
| User DDL (v1) | `CREATE VIRTUAL TABLE ... USING anki` | Planner-integrated `MATCH` + HNSW |
| Search syntax | `MATCH` + `similarity()` | Familiar FTS-like ergonomics |
| Parameterized `MATCH` | Required in v1 | Real apps use bound parameters |
| Multiple vector columns | Required in v1 | One HNSW index per column |
| `NULL` / `''` | No embedding; excluded from `MATCH` | Clear semantics |
| Default threshold | Similarity ≥ 0.5 | Built into `MATCH`; override in `WHERE` |
| ANN candidate cap | 256 (fixed internal) | Good recall for browser-scale data |
| Result count | SQL `LIMIT` | Standard, user-controlled |
| Configuration | No PRAGMAs | Extensions cannot add PRAGMAs without custom VFS |
| ONNX runtime | Tract | Pure Rust WASM |
| HNSW | hnsw_rs | Pure Rust WASM |
| v1 model delivery | Pre-bundled per WASM | Simplest; no install step |
| DB persistence | OPFS | Required for browser v1 |
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

## 23. Future work

- [ ] Normal `CREATE TABLE` with `TEXT VECTOR` (auto-shadow + hooks) for nicer DX
- [ ] Dynamic model selection and OPFS model file cache
- [ ] Per-column model override in column definitions
- [ ] Native (non-WASM) loadable extension for desktop SQLite
- [ ] Quantized embedding storage (float16) to reduce disk use
- [ ] `anki_explain(query)` — embedding time, HNSW stats, candidate count
- [ ] Optional custom PRAGMA syntax via JS wrapper sugar (not raw extension)
- [ ] Evaluate usearch on native desktop builds

---

## 24. References

| Resource | URL |
|----------|-----|
| Official SQLite WASM | https://sqlite.org/wasm |
| SQLite WASM build guide | https://sqlite.org/wasm/doc/trunk/building.md |
| SQLite virtual table module | https://www.sqlite.org/vtab.html |
| sqlite-vec WASM | https://alexgarcia.xyz/sqlite-vec/wasm.html |
| sqlite-rust-wasm | https://github.com/tantaman/sqlite-rust-wasm |
| Tract (Rust ONNX) | https://github.com/sonos/tract |
| hnsw_rs | https://crates.io/crates/hnsw_rs |
| all-MiniLM-L6-v2 | https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2 |

---

*Last updated: June 2025*
