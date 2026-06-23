# sqlite-anki — Design Specification

This document captures the full design for **sqlite-anki**: a SQLite extension that adds semantic text search for browser deployments using official SQLite WASM.

---

## Table of contents

1. [Goals](#1-goals)
2. [User-facing SQL API](#2-user-facing-sql-api)
3. [Architecture overview](#3-architecture-overview)
4. [Storage model](#4-storage-model)
5. [Write path](#5-write-path)
6. [Read path and query execution](#6-read-path-and-query-execution)
7. [HNSW indexing](#7-hnsw-indexing)
8. [MATCH on normal tables](#8-match-on-normal-tables)
9. [Configuration (PRAGMAs)](#9-configuration-pragmas)
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

1. Introduces a `TEXT VECTOR` column type for declarative semantic text columns.
2. Automatically generates and stores embeddings when text is inserted or updated.
3. Supports semantic search via `WHERE column MATCH 'query text'`.
4. Exposes `similarity(column)` for score-based filtering and ordering.
5. Uses HNSW for approximate nearest-neighbor (ANN) search.
6. Runs entirely inside WebAssembly in the browser using the **official SQLite WASM** build.
7. Performs inference in **Rust** (ONNX via Tract or similar) — **no JavaScript callbacks during SQL execution**.

### What we are not building (initially)

- Keyword full-text search (FTS5). `MATCH` here means **semantic** matching.
- Dynamically loadable `.wasm` extensions at runtime (not supported in browser WASM).
- Xenova / transformers.js for inference (those are JavaScript libraries).

### Design principles

| Principle | Rationale |
|-----------|-----------|
| Normal `CREATE TABLE` for users | Avoid requiring `CREATE VIRTUAL TABLE ... USING anki` |
| Native inference in WASM | Predictable performance; no JS bridge on hot path |
| Static link into SQLite WASM | Only viable delivery model in browsers |
| Sensible defaults | `anki_similarity`, `anki_top_k` work out of the box |

---

## 2. User-facing SQL API

### Column type: `TEXT VECTOR`

```sql
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  customer_name TEXT,
  notes TEXT VECTOR
);
```

`TEXT VECTOR` is not a native SQLite type. SQLite uses dynamic typing; this is a **type name** with TEXT affinity. The extension discovers columns declared as `TEXT VECTOR` via schema introspection (`sqlite3_table_column_metadata`) and manages embeddings for them automatically.

Users never manage embedding BLOBs directly.

### Semantic search: `MATCH`

```sql
SELECT customer_name
FROM customers
WHERE notes MATCH 'potential opportunity';
```

`MATCH` performs **semantic** matching: the query string is embedded, compared against stored vectors, and rows above the similarity threshold are returned.

`MATCH` alone uses the default similarity threshold from `PRAGMA anki_similarity` (default `0.5`).

### Similarity function

```sql
SELECT customer_name, similarity(notes) AS score
FROM customers
WHERE notes MATCH 'potential opportunity'
  AND similarity(notes) > 0.6
ORDER BY score DESC;
```

| Function | Behavior |
|----------|----------|
| `similarity(column)` | Cosine similarity between the column's stored embedding and the current query embedding (from the active `MATCH` context) |
| Used with `MATCH` | Both operate on the same query embedding and HNSW candidate set |

### Introspection (optional)

```sql
SELECT anki_model();    -- e.g. 'all-MiniLM-L6-v2' (read-only in v1)
SELECT anki_dim();      -- e.g. 384
SELECT anki_version();  -- extension version
```

### Full example

```sql
PRAGMA anki_similarity = 0.5;
PRAGMA anki_top_k = 20;

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  customer_name TEXT,
  notes TEXT VECTOR
);

INSERT INTO customers (customer_name, notes) VALUES
  ('Acme Corp', 'Discussed renewal — potential upsell opportunity in Q3'),
  ('Beta LLC',  'Support ticket about billing, no sales interest');

SELECT customer_name
FROM customers
WHERE notes MATCH 'potential opportunity'
  AND similarity(notes) > 0.6;
```

---

## 3. Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│  User SQL                                                        │
│  CREATE TABLE ... notes TEXT VECTOR                              │
│  INSERT / UPDATE                                                 │
│  WHERE notes MATCH '...' AND similarity(notes) > 0.6             │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  sqlite-anki extension (Rust, inside sqlite3.wasm)               │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ Write hooks  │  │ Embedder     │  │ Query layer            │ │
│  │ preupdate /  │→ │ tokenizer +  │  │ match() + similarity() │ │
│  │ commit       │  │ ONNX/Tract   │  │ + query-scoped ANN     │ │
│  └──────┬───────┘  └──────────────┘  └───────────┬────────────┘ │
│         │                                         │              │
│         ▼                                         ▼              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Shadow storage + HNSW index (internal, not user-facing) │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Layers of "virtual table" machinery

These are easy to conflate:

| Layer | User writes? | Purpose |
|-------|----------------|---------|
| **A. User-facing `CREATE VIRTUAL TABLE`** | Yes | FTS5 / sqlite-vec style — **we avoid this** |
| **B. Normal table + internal shadow storage** | No | Embeddings and HNSW hidden from the user — **we use this** |
| **C. Internal virtual table modules** | No | Optional planner hooks — may be used internally |

**Users create normal tables.** The extension maintains shadow tables and indexes internally.

---

## 4. Storage model

### User-visible schema

```sql
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  customer_name TEXT,
  notes TEXT VECTOR   -- stored as TEXT; embedding managed by extension
);
```

The `notes` column holds plain text visible to standard SQL (`SELECT notes FROM customers` works as expected).

### Internal shadow schema (extension-managed)

The extension auto-creates and maintains tables such as:

```sql
-- Per-database configuration and metadata
anki_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Per (table, column) vector storage
anki_vec_<table>_<column> (
  rowid      INTEGER PRIMARY KEY,  -- maps to user table rowid
  text       TEXT,                 -- copy of text at embed time
  embedding  BLOB,                 -- float32 vector, fixed dim per build
  model_id   TEXT,                 -- which model produced this embedding
  updated_at INTEGER
);

-- Serialized HNSW index per (table, column)
anki_hnsw_<table>_<column> (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  data  BLOB                         -- serialized HNSW graph
);
```

Exact naming is an implementation detail; the key idea is **shadow storage** keyed by `(table, column, rowid)`.

### Metadata keys (`anki_meta`)

| Key | Example | Purpose |
|-----|---------|---------|
| `model_id` | `all-MiniLM-L6-v2` | Model that produced embeddings |
| `embed_dim` | `384` | Vector dimension |
| `build_id` | `all-MiniLM-L6-v2@0.1.0` | WASM build identifier |
| `anki_similarity` | `0.5` | Default similarity threshold |
| `anki_top_k` | `20` | Default HNSW candidate cap |

---

## 5. Write path

### Flow

```
INSERT / UPDATE on TEXT VECTOR column
        │
        ▼
preupdate_hook or commit_hook detects change
        │
        ▼
Read new text value
        │
        ▼
Tokenize (Rust tokenizers crate)
        │
        ▼
ONNX inference (Tract) → float32[dim]
        │
        ▼
Upsert anki_vec_<table>_<column> (rowid, text, embedding)
        │
        ▼
Insert / update vector in HNSW index
        │
        ▼
Persist serialized HNSW to anki_hnsw_* (on commit or periodic)
```

### Column discovery

On extension init and after DDL:

1. Scan `sqlite_schema` for tables and columns.
2. Register columns whose declared type contains `VECTOR` (e.g. `TEXT VECTOR`).
3. Ensure shadow tables and HNSW structures exist for each.

### Deletes

`DELETE` on the user table triggers removal of the corresponding shadow row and HNSW entry via `preupdate_hook` or `commit_hook`.

---

## 6. Read path and query execution

### Flow

```
WHERE notes MATCH 'potential opportunity'
        │
        ▼
Parse constant query text from MATCH right-hand side
        │
        ▼
Embed query once (same embedder as write path)
        │
        ▼
HNSW search → top-k candidate rowids + distances
        │
        ▼
Convert distance → cosine similarity
        │
        ▼
Filter by PRAGMA anki_similarity (default 0.5)
        │
        ▼
Store candidates + scores in per-query / per-connection cache
        │
        ▼
match(notes, '...') → true if rowid in candidate set
similarity(notes)   → cached score for rowid
```

### Query-scoped cache

SQLite's default `match()` function is invoked per row. A naive implementation would compare every row — O(n) and defeats HNSW.

**Solution:** On the first `MATCH` with a constant query string for a given statement:

1. Embed the query **once**.
2. Run HNSW **once** to get top-k candidates.
3. Cache `{ rowid → similarity }` in connection-local or statement-local state.
4. `match()` and `similarity()` read from that cache.

This gives HNSW-first behavior while preserving the `MATCH` / `similarity()` SQL syntax on normal columns.

---

## 7. HNSW indexing

### Why HNSW

Exact brute-force similarity is O(n) per query. HNSW (Hierarchical Navigable Small World) provides fast approximate nearest-neighbor search, suitable for interactive browser use.

### Rust crate options

| Crate | Notes |
|-------|-------|
| [usearch](https://crates.io/crates/usearch) | Mature HNSW; used by sqlite-vector-rs |
| [hnsw_rs](https://crates.io/crates/hnsw_rs) | Pure Rust HNSW |
| [vector-lite](https://crates.io/crates/vector-lite) | Compact; WASM support |

### Configurable parameters (PRAGMAs)

```sql
PRAGMA anki_top_k = 20;           -- HNSW candidate cap before threshold filter
PRAGMA anki_hnsw_m = 16;          -- HNSW M parameter (graph connectivity)
PRAGMA anki_hnsw_ef_search = 64;  -- search quality vs speed tradeoff
```

### Query pipeline

```
query text
    → embed → query vector
    → HNSW top-k (k = anki_top_k)
    → filter: similarity >= anki_similarity
    → return matching rowids
```

If `similarity(notes) > 0.6` is stricter than `anki_similarity`, both filters apply.

---

## 8. MATCH on normal tables

### Can we avoid `CREATE VIRTUAL TABLE`?

**Yes for user DDL.** Users write `CREATE TABLE` with `TEXT VECTOR` columns.

**Internally**, shadow storage and HNSW are still required for efficient search.

### Does `MATCH` work on normal columns?

SQLite documents that the `MATCH` operator is syntactic sugar for the `match()` application-defined function, and **extensions can override `match()`** ([SQLite expression docs](https://www.sqlite.org/lang_expr.html)).

So this is valid on a normal column:

```sql
WHERE notes MATCH 'potential opportunity'
```

### Efficiency caveat

Without a virtual table's `xBestIndex`, SQLite may still iterate rows. The **query-scoped ANN cache** (see §6) is the pragmatic way to get HNSW-first semantics with `MATCH` on normal columns.

### Alternative (internal / advanced)

A table-valued function for explicit ANN-first queries:

```sql
WHERE rowid IN (SELECT rowid FROM anki_search('customers', 'notes', 'query'));
```

This may be added later but is not the primary UX.

---

## 9. Configuration (PRAGMAs)

### v1 PRAGMAs (supported)

| PRAGMA | Default | Description |
|--------|---------|-------------|
| `anki_similarity` | `0.5` | Minimum cosine similarity for `MATCH` results |
| `anki_top_k` | `20` | HNSW candidate count before threshold filtering |
| `anki_hnsw_m` | `16` | HNSW graph parameter |
| `anki_hnsw_ef_search` | `64` | HNSW search breadth |

```sql
PRAGMA anki_similarity = 0.5;
PRAGMA anki_top_k = 20;
```

Values are persisted per database in `anki_meta`.

### Deferred PRAGMA: `anki_model` (v2+)

```sql
PRAGMA anki_model = 'all-MiniLM-L6-v2';
```

Selects which embedding model to use. **Not required in v1** when each WASM build bundles a single fixed model. In v1, `anki_model()` is read-only and reports the baked-in model.

### Read-only introspection

```sql
SELECT anki_model();   -- 'all-MiniLM-L6-v2'
SELECT anki_dim();      -- 384
SELECT anki_version();  -- '0.1.0'
```

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

Models that do **not** work without extra work:

- Raw PyTorch / GGUF checkpoints
- LLMs without a sentence-embedding head
- Models requiring Python-only preprocessing

### Inference during SQL (no JavaScript)

```
INSERT INTO t (notes) VALUES ('hello');
  → extension hook fires
  → Rust tokenize + ONNX infer
  → store embedding
  → no JS involved

WHERE notes MATCH 'hello';
  → embed query in Rust
  → HNSW search
  → no JS involved
```

---

## 11. Model loading strategies

There are three strategies. **v1 uses Strategy C.**

### Strategy A — App passes bytes once (bootstrap)

```javascript
const modelBytes = await fetch('/models/all-MiniLM-L6-v2/model.onnx')
  .then(r => r.arrayBuffer());
const tokenizerJson = await fetch('/models/all-MiniLM-L6-v2/tokenizer.json')
  .then(r => r.text());

sqlite3.anki.loadModel(db, 'all-MiniLM-L6-v2', modelBytes, tokenizerJson);
```

After this one-time call, all SQL runs without JS. The app is a **delivery mechanism**, not part of the inference loop.

### Strategy B — Extension reads from OPFS

With official SQLite WASM + OPFS VFS:

```
PRAGMA anki_model = 'all-MiniLM-L6-v2'
  → extension opens OPFS:/models/all-MiniLM-L6-v2/model.onnx
  → reads bytes via VFS
  → loads ONNX in Rust
```

A one-time `installModelToOpfs()` helper may still be needed to populate OPFS on first visit. After that, the extension loads models without per-query JS.

### Strategy C — Pre-bundled per WASM build (v1 recommended)

Ship one WASM artifact per model:

```
sqlite-anki-all-MiniLM-L6-v2.wasm
sqlite-anki-bge-small-en.wasm
```

Each build embeds ONNX + tokenizer at compile time via `include_bytes!`. **No model install step. No `PRAGMA anki_model`.**

See [§12](#12-v1-approach-pre-bundled-wasm-per-model).

### Browser constraint

WASM cannot arbitrarily download from the network or read the local filesystem without host support. Something must make model bytes available **once**:

| Mechanism | Who fetches |
|-----------|-------------|
| `include_bytes!` in WASM | Nobody — baked in at build time |
| OPFS | Setup helper once; extension reads thereafter |
| `loadModel(bytes)` | App once per session |

**sqlite-anki always parses and runs ONNX itself.** The question is only how bytes enter the WASM sandbox.

---

## 12. v1 approach: pre-bundled WASM per model

### Rationale

Pre-bundling is the simplest v1 UX:

- One npm import → pure SQL immediately
- No `PRAGMA anki_model` machinery
- No OPFS install step
- Deterministic embeddings per package version
- Easier golden-vector testing

### Artifacts

| Artifact | Contents |
|----------|----------|
| `sqlite-anki-all-MiniLM-L6-v2.wasm` | SQLite + extension + MiniLM ONNX + tokenizer |
| `sqlite-anki-all-MiniLM-L6-v2.js` | Emscripten loader / official SQLite JS API |

Approximate sizes:

| Model | Approx WASM size |
|-------|------------------|
| `all-MiniLM-L6-v2` (384d, quantized) | ~25–40 MB |
| `all-mpnet-base-v2` (768d) | ~80–120 MB |

### Rust embedding at build time

```rust
const MODEL_ONNX: &[u8] =
    include_bytes!("models/all-MiniLM-L6-v2/model.onnx");
const TOKENIZER_JSON: &str =
    include_str!("models/all-MiniLM-L6-v2/tokenizer.json");
const EMBED_DIM: usize = 384;
const MODEL_ID: &str = "all-MiniLM-L6-v2";

static EMBEDDER: OnceLock<Embedder> = OnceLock::new();

fn embedder() -> &'static Embedder {
    EMBEDDER.get_or_init(|| {
        Embedder::from_bytes(MODEL_ONNX, TOKENIZER_JSON).expect("bundled model")
    })
}
```

### npm packages

```
@sqlite-anki/all-MiniLM-L6-v2     ← default, recommended
@sqlite-anki/bge-small-en-v1.5   ← optional, larger
```

User picks model at **install/import time**, not SQL time:

```javascript
import sqlite3Init from '@sqlite-anki/all-MiniLM-L6-v2';
const sqlite3 = await sqlite3Init();
const db = new sqlite3.oo1.DB();
```

### What v1 drops

| Feature | v1 |
|---------|-----|
| `PRAGMA anki_model` (writable) | Dropped |
| `installModel()` / OPFS cache | Dropped |
| `anki_load_model(bytes)` C API | Dropped |
| Reindex on model change | N/A (one model per binary) |
| Model registry / HuggingFace runtime | Dropped |

### What v1 keeps

```sql
PRAGMA anki_similarity = 0.5;
PRAGMA anki_top_k = 20;

SELECT anki_model();   -- read-only: 'all-MiniLM-L6-v2'
SELECT anki_dim();     -- read-only: 384
```

### Switching models

Embeddings from `@sqlite-anki/all-MiniLM-L6-v2` are **not comparable** to another package's embeddings. Switching npm packages requires re-embedding all `TEXT VECTOR` columns (re-read text from user tables, regenerate vectors, rebuild HNSW).

Store `build_id` in `anki_meta`; on mismatch with the running WASM build, surface an error or offer `SELECT anki_reindex()`.

---

## 13. Rust and SQLite WASM build

### Why Rust

| Piece | Crate / tool |
|-------|--------------|
| SQLite extension API | `sqlite3_ext`, `ext-sqlite3-rs` |
| ONNX inference | `tract-onnx` |
| Tokenization | `tokenizers` |
| HNSW | `usearch` or `hnsw_rs` |

### Browser WASM: no dynamic loading

The official SQLite WASM build **does not support `dlopen()` / `LOAD EXTENSION`**. Extensions must be **statically linked** at compile time.

From the [SQLite WASM build docs](https://sqlite.org/wasm/doc/trunk/building.md):

1. Place `sqlite3_wasm_extra_init.c` in `ext/wasm/`.
2. Define `sqlite3_wasm_extra_init()` which calls `sqlite3_auto_extension(sqlite3_anki_init)`.
3. Build with Emscripten → `sqlite3.wasm` + `sqlite3.js`.

Reference implementations:

- [sqlite-vec WASM integration](https://alexgarcia.xyz/sqlite-vec/wasm.html)
- [sqlite-rust-wasm](https://github.com/tantaman/sqlite-rust-wasm)
- [wasm_sqlite_with_stats](https://github.com/llimllib/wasm_sqlite_with_stats)

### Extension init

```c
// sqlite3_wasm_extra_init.c
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
    // 1. Register match(), similarity(), anki_* SQL functions
    // 2. Register preupdate/commit hooks
    // 3. Register PRAGMA handlers
    // 4. Initialize bundled embedder (lazy)
    SQLITE_OK
}
```

### Per-model build matrix

```makefile
# Conceptual
make MODEL=all-MiniLM-L6-v2  → jswasm/sqlite-anki-all-MiniLM-L6-v2.wasm
make MODEL=bge-small-en      → jswasm/sqlite-anki-bge-small-en.wasm
```

Each target passes a different `ANKI_MODEL` feature flag or `include_bytes!` path.

### WASM heap memory

Large ONNX models require a custom SQLite WASM build with sufficient initial heap size. The default heap may be too small; tune via Emscripten `INITIAL_MEMORY` / `ALLOW_MEMORY_GROWTH` in the build.

### SIMD

Enable WASM SIMD128 where supported for faster inference and distance calculations.

---

## 14. JavaScript integration

### v1 usage (zero setup)

```javascript
import sqlite3Init from '@sqlite-anki/all-MiniLM-L6-v2';

const sqlite3 = await sqlite3Init();
const db = new sqlite3.oo1.DB(':memory:');

db.exec(`
  CREATE TABLE customers (
    id INTEGER PRIMARY KEY,
    customer_name TEXT,
    notes TEXT VECTOR
  );
`);

db.exec(`INSERT INTO customers (customer_name, notes) VALUES
  ('Acme', 'potential upsell opportunity in Q3')`);

const rows = db.selectObjects(`
  SELECT customer_name, similarity(notes) AS score
  FROM customers
  WHERE notes MATCH 'potential opportunity'
`);

console.log(rows);
db.close();
```

### Worker recommendation

Run SQLite in a **Web Worker** (official WASM supports this). Embedding inference blocks the thread; running in a worker avoids freezing the UI.

```javascript
import { sqlite3Worker1Promiser } from '@sqlite-anki/all-MiniLM-L6-v2/worker';

const promiser = await new Promise(resolve => {
  const p = sqlite3Worker1Promiser({ onready: () => resolve(p) });
});
```

### v2 usage (dynamic models, future)

```javascript
import { initSqliteAnki } from '@sqlite-anki/browser';

const { db } = await initSqliteAnki({
  model: 'all-MiniLM-L6-v2',  // installs to OPFS if needed
});
```

---

## 15. Sync, async, and workers

### The async problem

| Layer | Sync / async |
|-------|--------------|
| SQLite extension APIs | **Synchronous** |
| ONNX inference | **Synchronous** (blocks calling thread) |
| Browser model download | **Asynchronous** |

### Implications

| Phase | Blocking? | Where |
|-------|-----------|-------|
| WASM + model load (v1 bundled) | One-time parse of embedded ONNX | Worker recommended |
| `INSERT` with new text | Yes — tokenize + infer | Worker |
| `MATCH` query | Yes — embed query + HNSW | Worker |
| First-time model download (v2) | Async — before DB use | Main or setup |

### v1 mitigates async concerns

Pre-bundled models eliminate network fetch. The only "slow" operations are ONNX parse (first use) and per-row embed on write — both run synchronously inside WASM in a worker.

---

## 16. Model changes and reindexing

### Within one v1 WASM build

Model is fixed. No runtime model change. Reindexing is only needed after:

- Extension upgrade that changes embedding logic
- Corrupted shadow / HNSW data
- Manual `SELECT anki_reindex()`

### `anki_reindex()` (planned)

```sql
SELECT anki_reindex();                    -- all TEXT VECTOR columns
SELECT anki_reindex('customers', 'notes'); -- one column
```

Re-reads text from user tables, re-embeds, rebuilds HNSW.

### Switching npm packages (different model)

1. Embeddings are incompatible (different dimensions and semantic space).
2. Detect `build_id` mismatch in `anki_meta`.
3. Require `anki_reindex()` or reject `MATCH` until reindex completes.

### v2: `PRAGMA anki_model` change

When dynamic model selection is added:

```
PRAGMA anki_model = 'new-model';
  → validate ONNX loads, dim = N
  → if dim or weights changed: mark all vectors stale
  → drop HNSW indexes
  → set anki_meta.reindex_required = 1
  → user runs SELECT anki_reindex();
```

---

## 17. Package layout (proposed)

```
sqlite-anki/
├── crates/
│   ├── anki-core/              # Rust: embedder, HNSW, hooks, SQL functions
│   ├── anki-wasm-minilm/       # include_bytes! for MiniLM; links into SQLite WASM
│   └── anki-wasm-bge/          # optional second model build
├── wasm/
│   ├── sqlite3_wasm_extra_init.c
│   └── Makefile                # official SQLite ext/wasm integration
├── packages/
│   ├── all-MiniLM-L6-v2/       # npm: prebuilt .js + .wasm
│   └── browser/                # v2: installModel, OPFS helpers
├── models/
│   └── all-MiniLM-L6-v2/
│       ├── model.onnx
│       ├── tokenizer.json
│       └── config.json
└── docs/
    ├── README.md
    └── DESIGN.md               # this file
```

### Crate responsibilities

| Crate | Responsibility |
|-------|----------------|
| `anki-core` | Extension logic: schema scan, hooks, shadow tables, HNSW, `match()`, `similarity()`, PRAGMAs |
| `anki-wasm-minilm` | Thin wrapper: `include_bytes!`, `MODEL_ID`, `EMBED_DIM`, WASM export |
| npm `@sqlite-anki/all-MiniLM-L6-v2` | Ships `sqlite3.js` + `sqlite3.wasm` with anki baked in |

---

## 18. Tradeoffs and decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | Rust | WASM-friendly; ONNX via Tract; shared with native extension later |
| SQLite distribution | Official WASM | OPFS, workers, long-term support |
| Extension loading | Static link | Only option in browser |
| User DDL | Normal `CREATE TABLE` | Better DX than `CREATE VIRTUAL TABLE` |
| Search syntax | `MATCH` + `similarity()` | Familiar FTS-like ergonomics |
| ANN algorithm | HNSW | Fast enough for interactive browser queries |
| v1 model delivery | Pre-bundled per WASM | Simplest; no install step |
| `PRAGMA anki_model` | Deferred to v2 | Not needed when model is compile-time fixed |
| Inference runtime | Rust/Tract, not Xenova | No JS on hot path |
| Threading | Worker | Sync inference blocks; keep off main thread |

### Known limitations

| Limitation | Notes |
|------------|-------|
| Large WASM downloads | ~25–40 MB for MiniLM variant |
| No cross-model embedding comparison | Switching packages requires reindex |
| `MATCH` planner integration | Query-scoped cache, not true index-driven planning |
| Model support | Sentence-transformer ONNX models only (initially) |
| WASM heap | Must be tuned for model size |

---

## 19. Future work

- [ ] Dynamic model selection via `PRAGMA anki_model`
- [ ] OPFS model cache and `installModel()` helper
- [ ] Per-column model override: `notes TEXT VECTOR MODEL '...'`
- [ ] Table-valued function `anki_search(table, column, query)` for explicit ANN-first queries
- [ ] Native (non-WASM) loadable extension for desktop SQLite
- [ ] Quantized embedding storage (float16) to reduce disk use
- [ ] Batch reindex with progress callback
- [ ] `anki_explain(query)` — show embedding time, HNSW stats, candidate count

---

## 20. References

| Resource | URL |
|----------|-----|
| Official SQLite WASM | https://sqlite.org/wasm |
| SQLite WASM build guide | https://sqlite.org/wasm/doc/trunk/building.md |
| SQLite MATCH operator | https://www.sqlite.org/lang_expr.html |
| sqlite-vec WASM | https://alexgarcia.xyz/sqlite-vec/wasm.html |
| sqlite-rust-wasm | https://github.com/tantaman/sqlite-rust-wasm |
| Tract (Rust ONNX) | https://github.com/sonos/tract |
| all-MiniLM-L6-v2 | https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2 |
| usearch (HNSW) | https://github.com/unum-cloud/usearch |

---

*Last updated: June 2025*
