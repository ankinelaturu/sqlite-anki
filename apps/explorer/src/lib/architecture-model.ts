/**
 * The data behind the Architecture Map — blocks, their geometry, and the
 * journeys that thread through them.
 *
 * Kept as pure data (no React, no DOM) so the layout can be tuned without
 * touching the renderer. Coordinates are in a fixed 1240x1020 diagram space;
 * the view transform handles zoom/pan on top.
 */

/** Visual family of a block — drives its accent colour. */
export type BlockKind = "app" | "glue" | "sqlite" | "lib" | "rust" | "model" | "store";

/** A layer slab: the big container band for a tier of the stack. */
export interface Slab {
  id: string;
  kind: BlockKind;
  title: string;
  sub: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A module inside a slab (or a standalone side block). */
export interface Block {
  id: string;
  kind: BlockKind;
  label: string;
  /** Second line, revealed at medium zoom. */
  sub?: string;
  /** Source path shown in the inspector. */
  path?: string;
  /** What it does — inspector body. */
  role: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A labelled boundary between two slabs — what crosses, and how. */
export interface BoundaryLabel {
  id: string;
  y: number;
  text: string;
}

/** One hop of a journey: a block, plus what happens there. */
export interface Hop {
  block: string;
  /** Hook / function responsible, shown on the wire at high zoom. */
  hook?: string;
  /**
   * Which live metric governs the dwell time when the journey is played.
   * `embed` and `search` read real per-call averages; the rest are nominal.
   */
  cost?: "embed" | "search" | "fast" | "io";
  /** Note surfaced in the inspector while this hop is active. */
  note?: string;
}

/** A named path through the architecture. */
export interface Journey {
  id: "read" | "write" | "boot";
  label: string;
  blurb: string;
  hops: Hop[];
}

/* ------------------------------------------------------------------ */
/* geometry                                                            */
/* ------------------------------------------------------------------ */

export const DIAGRAM_W = 1240;
export const DIAGRAM_H = 1020;

const COL_X = 90;
const COL_W = 640;
const SIDE_X = 790;
const SIDE_W = 360;

/**
 * Vertical room a slab reserves for its title + sub before the first block row.
 * The renderer draws the title at y+24 and the sub at y+42, so anything less
 * than this and the sub-label is struck through by the blocks.
 */
export const SLAB_HEADER = 56;

export const SLABS: Slab[] = [
  { id: "s_app", kind: "app", title: "Application", sub: "apps/explorer", x: COL_X, y: 90, w: COL_W, h: 124 },
  { id: "s_glue", kind: "glue", title: "JS glue", sub: "packages/wasm", x: COL_X, y: 250, w: COL_W, h: 122 },
  { id: "s_wasm", kind: "sqlite", title: "sqlite3.wasm", sub: "SQLite core + wasm/*.c", x: COL_X, y: 400, w: COL_W, h: 164 },
  { id: "s_lib", kind: "lib", title: "Static library", sub: "crates/anki-wasm", x: COL_X, y: 590, w: COL_W, h: 114 },
  { id: "s_core", kind: "rust", title: "anki-core", sub: "crates/anki-core · Rust", x: COL_X, y: 720, w: COL_W, h: 196 },
  { id: "s_model", kind: "model", title: "Model source", sub: "fetched at runtime", x: SIDE_X, y: 90, w: SIDE_W, h: 168 },
  { id: "s_store", kind: "store", title: "Shadow storage", sub: "format v7", x: SIDE_X, y: 720, w: SIDE_W, h: 226 },
];

export const BLOCKS: Block[] = [
  /* ---- application ---- */
  {
    id: "b_client", kind: "app", label: "db/index.ts", sub: "main-thread client",
    path: "apps/explorer/src/db/index.ts",
    role: "Comlink facade over the worker. Lazily starts it and hands back a typed remote — the UI never touches wasm directly.",
    x: 115, y: 146, w: 180, h: 52,
  },
  {
    id: "b_worker", kind: "app", label: "db/worker.ts", sub: "Web Worker",
    path: "apps/explorer/src/db/worker.ts",
    role: "Runs SQLite off the main thread so a slow embed never blocks the UI.",
    x: 315, y: 146, w: 180, h: 52,
  },
  {
    id: "b_status", kind: "app", label: "StatusBar", sub: "per-op metrics",
    path: "apps/explorer/src/components/StatusBar.tsx",
    role: "Diffs anki_metrics() before/after each statement to show that operation's embed / search / persist split.",
    x: 515, y: 146, w: 180, h: 52,
  },

  /* ---- js glue ---- */
  {
    id: "b_init", kind: "glue", label: "src/index.ts", sub: "boot + model load",
    path: "packages/wasm/src/index.ts",
    role: "The published entry point. Boots the wasm module, fetches model + tokenizer bytes, copies them into the wasm heap and calls anki_load_model.",
    x: 115, y: 306, w: 250, h: 52,
  },
  {
    id: "b_registry", kind: "model", label: "src/registry.ts", sub: "ANKI_MODEL_REGISTRY",
    path: "packages/wasm/src/registry.ts",
    role: "Pure data with no wasm import, so the model picker and the glue resolve URLs from one source of truth.",
    x: 385, y: 306, w: 310, h: 52,
  },

  /* ---- sqlite3.wasm ---- */
  {
    id: "b_sqlite", kind: "sqlite", label: "SQLite core", sub: "VDBE · B-tree · planner",
    path: "vendor/sqlite",
    role: "Stock SQLite, compiled to wasm. It owns parsing, planning and execution — the extension only supplies a virtual-table module.",
    x: 115, y: 456, w: 250, h: 52,
  },
  {
    id: "b_ext", kind: "sqlite", label: "anki_extension.c", sub: "registers vtab + funcs",
    path: "wasm/anki_extension.c",
    role: "C glue. Declares the Rust externs, registers the module and SQL functions, and exposes anki_load_model / anki_metrics to JS via EMSCRIPTEN_KEEPALIVE.",
    x: 385, y: 456, w: 310, h: 52,
  },
  {
    id: "b_auto", kind: "sqlite", label: "sqlite3_auto_extension → sqlite3_anki_init",
    path: "wasm/sqlite3_wasm_extra_init.c",
    role: "Wires the init hook so every new connection gets the anki module registered before any SQL runs.",
    x: 115, y: 518, w: 580, h: 32,
  },

  /* ---- staticlib ---- */
  {
    id: "b_static", kind: "lib", label: "libanki_wasm.a", sub: "force-links the exports",
    path: "crates/anki-wasm/src/lib.rs",
    role: "A near-empty shim. Its only job is to reference anki-core's #[no_mangle] exports so the linker can't strip them out of the wasm.",
    x: 115, y: 646, w: 580, h: 44,
  },

  /* ---- rust core ---- */
  {
    id: "b_vtab", kind: "rust", label: "vtab.rs", sub: "the anki vtab",
    path: "crates/anki-core/src/vtab.rs",
    role: "Every virtual-table callback: xBestIndex planning, xFilter execution, xUpdate writes, xColumn reads, xSync persistence.",
    x: 115, y: 776, w: 180, h: 52,
  },
  {
    id: "b_match", kind: "rust", label: "match_query.rs", sub: "MATCH dialect",
    path: "crates/anki-core/src/match_query.rs",
    role: "Parses the MATCH text for /exact and /hnsw:N directives. Default mode is approximate HNSW.",
    x: 315, y: 776, w: 180, h: 52,
  },
  {
    id: "b_metrics", kind: "rust", label: "metrics.rs", sub: "counters",
    path: "crates/anki-core/src/metrics.rs",
    role: "Cumulative counters since module load. Note search_ms *includes* index_rebuild_ms — a cold first MATCH therefore looks like a very slow search.",
    x: 515, y: 776, w: 180, h: 52,
  },
  {
    id: "b_embed", kind: "model", label: "embedder/", sub: "tokenize → ONNX → pool → L2",
    path: "crates/anki-core/src/embedder/",
    role: "The model itself. One forward pass per text, padding disabled so short inputs stay cheap. Tract and Candle are mutually exclusive compile-time features.",
    x: 115, y: 838, w: 290, h: 62,
  },
  {
    id: "b_hnsw", kind: "rust", label: "hnsw.rs", sub: "layered graph search",
    path: "crates/anki-core/src/hnsw.rs",
    role: "In-tree HNSW — no external crate, because the mature ones assume threads and mmap. Build, search, and incremental add/remove.",
    x: 415, y: 838, w: 280, h: 62,
  },

  /* ---- model source ---- */
  {
    id: "b_source", kind: "model", label: "registry id / URL / bytes",
    path: "packages/wasm/src/registry.ts",
    role: "The wasm links a full ONNX engine but no weights. Which model you get is decided at runtime.",
    x: 810, y: 146, w: 320, h: 44,
  },
  {
    id: "b_opfs", kind: "model", label: "OPFS cache", sub: "needs COOP/COEP",
    path: "apps/explorer/src/lib/opfs.ts",
    role: "Model bytes are cached in the Origin Private File System so the download happens once. Synchronous access handles require cross-origin isolation.",
    x: 810, y: 200, w: 320, h: 44,
  },

  /* ---- storage ---- */
  {
    id: "b_data", kind: "store", label: "<t>_anki_data", sub: "rows + anki_emb_<col>",
    role: "The user's columns stored verbatim — real names, types, collations, constraints — keyed on SQLite's own rowid, with embeddings alongside as blobs.",
    x: 810, y: 776, w: 320, h: 48,
  },
  {
    id: "b_graph", kind: "store", label: "<t>_anki_hnsw", sub: "serialized topology",
    role: "The graph's adjacency only — vectors are rehydrated from the row blobs. Written in xSync, and only for tables whose rowid is pinned by an INTEGER PRIMARY KEY.",
    x: 810, y: 832, w: 320, h: 48,
  },
  {
    id: "b_meta", kind: "store", label: "anki_meta", sub: "storage_format · model_id · dim",
    role: "Database-level guards checked on connect. A format or model mismatch fails the open loudly rather than corrupting silently.",
    x: 810, y: 888, w: 320, h: 44,
  },
];

export const BOUNDARIES: BoundaryLabel[] = [
  { id: "bd1", y: 230, text: "ES module import · sqlite3Init({ anki: { model } })" },
  { id: "bd2", y: 380, text: "wasm exports · anki_load_model · anki_metrics" },
  { id: "bd3", y: 570, text: "C ABI · extern anki_register_vtab · anki_embedder_load" },
  { id: "bd4", y: 712, text: "Rust · every #[no_mangle] export lives below" },
];

/** Static wires drawn behind everything — the shape of the system at rest. */
export const WIRES: [string, string][] = [
  ["b_client", "b_worker"],
  ["b_worker", "b_init"],
  ["b_init", "b_ext"],
  ["b_ext", "b_static"],
  ["b_static", "b_vtab"],
  ["b_sqlite", "b_ext"],
  ["b_vtab", "b_match"],
  ["b_vtab", "b_embed"],
  ["b_vtab", "b_hnsw"],
  ["b_vtab", "b_data"],
  ["b_hnsw", "b_graph"],
  ["b_vtab", "b_meta"],
  ["b_source", "b_opfs"],
  ["b_opfs", "b_init"],
  ["b_registry", "b_source"],
  ["b_vtab", "b_metrics"],
];

export const JOURNEYS: Journey[] = [
  {
    id: "read",
    label: "Read",
    blurb: "SELECT … WHERE notes MATCH 'refund request'",
    hops: [
      { block: "b_client", hook: "query()", cost: "fast", note: "The app issues plain SQL." },
      { block: "b_worker", hook: "postMessage", cost: "fast" },
      { block: "b_init", hook: "exec", cost: "fast" },
      { block: "b_ext", hook: "sqlite3_step", cost: "fast" },
      { block: "b_vtab", hook: "xBestIndex", cost: "fast", note: "The planner offers constraints; the module claims the MATCH and any pushable filters." },
      { block: "b_match", hook: "parse", cost: "fast", note: "Checks for /exact or /hnsw:N. Default is approximate." },
      { block: "b_embed", hook: "embed(query)", cost: "embed", note: "One transformer forward pass. This is where a semantic query spends almost all of its time." },
      { block: "b_hnsw", hook: "xFilter · search", cost: "search", note: "Walks the layered graph. An order of magnitude cheaper than the embed above it." },
      { block: "b_data", hook: "row lookup", cost: "io", note: "Row values come from the shadow table by rowid." },
      { block: "b_vtab", hook: "xColumn", cost: "fast", note: "<col>_score is computed here per row and never stored." },
      { block: "b_client", hook: "rows", cost: "fast", note: "Ranked rows arrive as ordinary SQL results." },
    ],
  },
  {
    id: "write",
    label: "Write",
    blurb: "INSERT INTO docs(body) VALUES ('…')",
    hops: [
      { block: "b_client", hook: "exec()", cost: "fast" },
      { block: "b_worker", hook: "postMessage", cost: "fast" },
      { block: "b_ext", hook: "sqlite3_step", cost: "fast" },
      { block: "b_vtab", hook: "xUpdate", cost: "fast", note: "The write hook owns the whole row." },
      { block: "b_embed", hook: "embed(text)", cost: "embed", note: "Each TEXT VECTOR column is embedded on the way in — this is why bulk loads are slow." },
      { block: "b_data", hook: "store row + blob", cost: "io" },
      { block: "b_hnsw", hook: "Hnsw::add", cost: "search", note: "Spliced into the live graph (~O(log N)) rather than dirtying the whole index." },
      { block: "b_graph", hook: "xSync", cost: "io", note: "Topology is persisted at commit, for pinned tables only." },
    ],
  },
  {
    id: "boot",
    label: "Boot",
    blurb: "sqlite3Init({ anki: { model } })",
    hops: [
      { block: "b_registry", hook: "resolve", cost: "fast", note: "A registry id, a custom URL, or raw bytes." },
      { block: "b_source", hook: "fetch", cost: "io" },
      { block: "b_opfs", hook: "cache", cost: "io", note: "Downloaded once, then served from OPFS." },
      { block: "b_init", hook: "copy → heap", cost: "io" },
      { block: "b_ext", hook: "anki_load_model", cost: "fast" },
      { block: "b_embed", hook: "Embedder::load", cost: "embed", note: "First load wins — one model per module instance. A panic here aborts the whole database." },
      { block: "b_meta", hook: "guard", cost: "fast", note: "model_id + dim are recorded so a mismatched reopen fails loudly." },
    ],
  },
];

/** Fast lookup by id. */
export const BLOCK_BY_ID: Record<string, Block> = Object.fromEntries(
  BLOCKS.map((b) => [b.id, b]),
);

/** Centre point of a block, for wire routing. */
export function centre(b: Block): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}
