import type { ReactNode } from "react";
import type { InitResult, Metrics } from "@/db";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The Architecture panel's content: a static reference to how sqlite-anki is
 * put together, with the runtime facts and per-operation costs bound to the
 * live wasm module when one is loaded.
 *
 * Colour discipline: `primary` is the only accent and it means one thing —
 * *this is the model / embedding path*. Everything else uses neutral theme
 * tokens so the panel tracks all five themes. Nothing here uses `dark:`
 * variants: the app themes via `[data-theme]`, not a `.dark` class.
 */

/** Section ids, shared with the workspace's jump-to nav. */
export const SECTIONS = [
  { id: "runtime", label: "Runtime" },
  { id: "stack", label: "The stack" },
  { id: "query", label: "Life of a query" },
  { id: "storage", label: "What's on disk" },
  { id: "model", label: "Model loading" },
  { id: "sql", label: "SQL surface" },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];

const mono = "font-mono text-[0.78rem]";

function Section({
  id,
  title,
  lede,
  children,
}: {
  id: SectionId;
  title: string;
  lede?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={`arch-${id}`} className="flex scroll-mt-4 flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h2 className="border-b pb-2 text-lg font-semibold tracking-tight">{title}</h2>
        {lede && <p className="max-w-[68ch] text-sm text-muted-foreground">{lede}</p>}
      </div>
      {children}
    </section>
  );
}

/** One horizontal layer of the stack. `isModel` marks the embedding path. */
function Band({
  kind,
  name,
  path,
  note,
  mods,
  isModel = false,
}: {
  kind: string;
  name: string;
  path: string;
  note: string;
  mods: { label: string; hint?: string; model?: boolean }[];
  isModel?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid gap-4 rounded-md border bg-card p-4 sm:grid-cols-[11rem_1fr]",
        isModel ? "border-l-2 border-l-primary" : "border-l-2 border-l-border",
      )}
    >
      <div className="flex flex-col gap-1">
        <span className="text-[0.65rem] uppercase tracking-wider text-muted-foreground">{kind}</span>
        <span className="font-semibold leading-tight">{name}</span>
        <span className={cn(mono, "break-words text-muted-foreground")}>{path}</span>
      </div>
      <div className="flex min-w-0 flex-col gap-2.5">
        <p className="text-sm text-muted-foreground">{note}</p>
        <div className="flex flex-wrap gap-1.5">
          {mods.map((m) => (
            <span
              key={m.label}
              className={cn(
                mono,
                "rounded border px-1.5 py-0.5",
                m.model
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-transparent bg-accent/50 text-foreground",
              )}
            >
              {m.label}
              {m.hint && <span className="ml-1 text-muted-foreground">{m.hint}</span>}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The labelled gap between two layers — what actually crosses the boundary. */
function Boundary({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-1.5 pl-6 text-muted-foreground">
      <span className="h-4 w-px bg-border" />
      <span className={cn(mono, "text-[0.72rem]")}>{children}</span>
    </div>
  );
}

/** One ordered step in the query lifecycle, with its measured/live cost. */
function Step({
  n,
  hook,
  text,
  cost,
  isModel = false,
}: {
  n: number;
  hook: string;
  text: ReactNode;
  cost: ReactNode;
  isModel?: boolean;
}) {
  return (
    <div className="grid grid-cols-[1.75rem_1fr_auto] items-baseline gap-3 rounded-md border bg-card px-4 py-3">
      <span className={cn(mono, "tabular-nums text-muted-foreground")}>
        {String(n).padStart(2, "0")}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <span className={cn(mono, "font-semibold", isModel ? "text-primary" : "text-foreground")}>
          {hook}
        </span>
        <span className="text-sm text-muted-foreground">{text}</span>
      </div>
      <span
        className={cn(
          mono,
          "whitespace-nowrap tabular-nums",
          isModel ? "font-semibold text-primary" : "text-muted-foreground",
        )}
      >
        {cost}
      </span>
    </div>
  );
}

function Card({ name, role, items }: { name: string; role: string; items?: string[] }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-card p-4">
      <span className={cn(mono, "break-all font-semibold")}>{name}</span>
      <span className="text-sm text-muted-foreground">{role}</span>
      {items && (
        <ul className="flex list-disc flex-col gap-0.5 pl-4">
          {items.map((i) => (
            <li key={i} className="text-[0.8rem] text-muted-foreground">
              {i}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A caveat callout — always accented, since each one is a real footgun. */
function Note({ tag, children }: { tag: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-3 rounded-md border border-l-2 border-l-primary bg-card px-4 py-3">
      <span className={cn(mono, "pt-0.5 uppercase tracking-wider text-primary")}>{tag}</span>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

/** A live runtime value, or an em-dash when nothing is loaded yet. */
function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border bg-card px-3 py-2.5">
      <span className="text-[0.65rem] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={cn(mono, "truncate text-foreground")}>{value ?? "—"}</span>
    </div>
  );
}

const ms = (n: number) => `${n.toFixed(n < 10 ? 1 : 0)} ms`;

export function ArchitectureView({
  info,
  metrics,
}: {
  info: InitResult | null;
  metrics: Metrics | null;
}) {
  const dash = <span className="text-muted-foreground">—</span>;
  const hasEmbed = metrics != null && metrics.embed_calls > 0;
  const hasSearch = metrics != null && metrics.search_ops > 0;

  // Cumulative counters → per-call averages, which is what the lifecycle wants.
  const avgEmbed = hasEmbed ? ms(metrics.embed_ms / metrics.embed_calls) : dash;
  const avgSearch = hasSearch ? ms(metrics.search_ms / metrics.search_ops) : dash;

  return (
    <div className="flex flex-col gap-10 px-6 py-6">
      {/* ---------------- runtime ---------------- */}
      <Section
        id="runtime"
        title="Runtime"
        lede={
          info
            ? "Live values from the wasm module currently loaded in this tab."
            : "No model loaded yet — open the SQLite panel and load one to populate these. The reference below reads fine without it."
        }
      >
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Extension version" value={info?.version ?? dash} />
          <Fact label="Model" value={info?.modelId ?? dash} />
          <Fact label="Embedding dim" value={info?.dim ?? dash} />
          <Fact label="Truncation limit" value={info?.maxTokens != null ? `${info.maxTokens} tokens` : dash} />
          <Fact label="OPFS" value={info ? (info.opfs ? "available" : "unavailable") : dash} />
          <Fact label="Storage format" value="v7" />
        </div>
        {metrics && (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Fact label="Embed calls" value={metrics.embed_calls} />
            <Fact label="Searches" value={metrics.search_ops} />
            <Fact label="Index rebuilds" value={metrics.index_rebuilds} />
            <Fact label="Rows matched" value={metrics.rows_matched} />
          </div>
        )}
      </Section>

      {/* ---------------- stack ---------------- */}
      <Section
        id="stack"
        title="The stack"
        lede="Five layers, top to bottom. The interesting part is the boundaries — each is a different calling convention, and the labels between bands say what actually crosses."
      >
        <div className="flex flex-col">
          <Band
            kind="Application"
            name="Explorer SPA"
            path="apps/explorer"
            note="React/Vite app. SQLite runs in a Web Worker; the main thread holds a thin Comlink client so queries never block the UI."
            mods={[
              { label: "db/index.ts", hint: "client" },
              { label: "db/worker.ts", hint: "worker" },
              { label: "components/StatusBar.tsx" },
            ]}
          />
          <Boundary>ES module import · sqlite3Init({"{ anki: { model } }"})</Boundary>

          <Band
            kind="JS glue"
            name="@sqlite-anki/wasm"
            path="packages/wasm"
            note="The published entry point. Boots the wasm build, resolves and fetches the model bytes, copies them into the wasm heap, and hands them to the extension. Load time only — never on the query path."
            mods={[
              { label: "src/index.ts" },
              { label: "src/registry.ts", hint: "ANKI_MODEL_REGISTRY", model: true },
            ]}
          />
          <Boundary>WASM exports · anki_load_model · anki_metrics · anki_embed_log</Boundary>

          <Band
            kind="C glue + SQLite"
            name="sqlite3.wasm"
            path="wasm/*.c → ext/wasm"
            note="Custom SQLite wasm build. sqlite3_anki_init is wired into sqlite3_auto_extension, so every connection gets the vtab and SQL functions registered before any SQL runs."
            mods={[
              { label: "anki_extension.c" },
              { label: "sqlite3_wasm_extra_init.c" },
            ]}
          />
          <Boundary>C ABI · extern anki_register_vtab · anki_embedder_load · anki_metrics_json</Boundary>

          <Band
            kind="Static library"
            name="anki-wasm"
            path="crates/anki-wasm"
            note="A near-empty shim whose only job is to force-link the core crate's exports into the wasm so the linker can't strip them. Built for wasm32-unknown-emscripten."
            mods={[{ label: "libanki_wasm.a" }]}
          />
          <Boundary>Rust · every #[no_mangle] FFI export lives below</Boundary>

          <Band
            kind="Core logic"
            name="anki-core"
            path="crates/anki-core"
            isModel
            note="All the logic: the virtual table, the embedding pipeline, the ANN index, and the MATCH dialect. The engine is a compile-time feature — Tract and Candle are mutually exclusive."
            mods={[
              { label: "vtab.rs", hint: "the anki vtab" },
              { label: "embedder/tract.rs", model: true },
              { label: "embedder/candle.rs", model: true },
              { label: "hnsw.rs" },
              { label: "match_query.rs" },
              { label: "loader.rs" },
              { label: "metrics.rs" },
            ]}
          />
        </div>
      </Section>

      {/* ---------------- query lifecycle ---------------- */}
      <Section
        id="query"
        title="Life of a semantic query"
        lede={
          <>
            What happens on <code className="rounded bg-accent/50 px-1 py-0.5 font-mono text-xs">
              WHERE description MATCH &apos;butler in space&apos;
            </code>
            . Costs are this session&apos;s averages from <code className="rounded bg-accent/50 px-1 py-0.5 font-mono text-xs">anki_metrics()</code>, so they
            reflect your machine and data — not a benchmark.
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <Step
            n={1}
            hook="xBestIndex"
            text="SQLite's planner offers the constraints. The module claims the MATCH and any pushable relational filters, and prices the plan."
            cost="plan"
          />
          <Step
            n={2}
            hook="match_query.rs"
            text="The MATCH text is parsed for directives — /exact, /hnsw:N — defaulting to approximate HNSW search."
            cost="parse"
          />
          <Step
            n={3}
            isModel
            hook="embedder · tokenize → ONNX → mean-pool → L2"
            text="The query text becomes a vector. One transformer forward pass, in WASM. A session LRU (cap 256, keyed by query text) skips this entirely on a repeat."
            cost={avgEmbed}
          />
          <Step
            n={4}
            hook="xFilter · hnsw.rs"
            text="Walks the layered HNSW graph for nearest neighbours, or runs exact cosine over the survivors when a relational filter was pushed down."
            cost={avgSearch}
          />
          <Step
            n={5}
            hook="xColumn"
            text="Row values are served from the shadow table by rowid; <col>_score is computed per row at read time and never stored."
            cost="per row"
          />
        </div>

        <Note tag="Cold start">
          The first <span className={mono}>MATCH</span> on a table with no cached graph{" "}
          <strong className="text-foreground">builds the HNSW index inside the search timer</strong>.
          Because <span className={mono}>search_ms</span> includes{" "}
          <span className={mono}>index_rebuild_ms</span>, a cold reading looks like a catastrophically
          slow search when it is really a one-time build
          {metrics && metrics.index_rebuilds > 0 && (
            <>
              {" "}— this session has rebuilt {metrics.index_rebuilds}{" "}
              {metrics.index_rebuilds === 1 ? "index" : "indexes"}, costing{" "}
              {ms(metrics.index_rebuild_ms)} of the {ms(metrics.search_ms)} total search time
            </>
          )}
          .
        </Note>
      </Section>

      {/* ---------------- storage ---------------- */}
      <Section
        id="storage"
        title="What's on disk"
        lede="An anki table is a facade. Real storage lives in parallel shadow tables holding the user's columns verbatim — real names, declared types, collations and constraints — keyed on SQLite's own rowid, with no injected key column."
      >
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <Card
            name="<name>_anki_data"
            role="Rows and their embeddings."
            items={["User columns, stored verbatim", "anki_emb_<col> vector blobs", "Keyed on rowid"]}
          />
          <Card
            name="<name>_anki_hnsw"
            role="Serialized graph topology, so opening a database reads the index instead of rebuilding it."
            items={["Adjacency only — no vectors", "Written in xSync", "Persisted only for pinned rowids"]}
          />
          <Card
            name="anki_meta"
            role="Database-level guards checked on connect."
            items={["storage_format (v7)", "model_id + dim"]}
          />
        </div>
        <Note tag="Pinned">
          A user&apos;s <span className={mono}>INTEGER PRIMARY KEY</span>{" "}
          <strong className="text-foreground">is</strong> the rowid — stable across{" "}
          <span className={mono}>VACUUM</span>, so the graph can be cached safely. Any other schema
          leaves SQLite&apos;s implicit rowid, which <span className={mono}>VACUUM</span> may
          renumber, so that graph is rebuilt in RAM on open rather than trusted from disk.
        </Note>
      </Section>

      {/* ---------------- model loading ---------------- */}
      <Section
        id="model"
        title="The model arrives at runtime"
        lede="The wasm links a full ONNX engine but no weights. The embedding dimension is a property of whatever model gets loaded, not a compile-time constant."
      >
        <div className="flex flex-col gap-2">
          <Step
            n={1}
            isModel
            hook="registry.ts · resolve"
            text="A registry id, a custom URL, or raw bytes. The registry is pure data with no wasm import, so the model picker and the glue share one source of truth."
            cost="load time"
          />
          <Step
            n={2}
            isModel
            hook="fetch → OPFS cache"
            text="Model and tokenizer bytes are fetched once and cached in the Origin Private File System, which needs cross-origin isolation to work."
            cost="once"
          />
          <Step
            n={3}
            isModel
            hook="anki_load_model → Embedder::load"
            text="Bytes are copied into the wasm heap and handed to Rust. One model per module instance — the first load wins — and a mismatch guard records the id and dimension so reopening with a different model fails loudly."
            cost={info?.modelId ? "loaded" : "once"}
          />
        </div>
        <Note tag="Headers">
          OPFS synchronous access handles require the page to be cross-origin isolated:{" "}
          <span className={mono}>Cross-Origin-Opener-Policy: same-origin</span> and{" "}
          <span className={mono}>Cross-Origin-Embedder-Policy: require-corp</span>. Miss them and the
          fast storage path quietly isn&apos;t available.
        </Note>
        <Note tag="Panics">
          The release profile is <span className={mono}>panic = &quot;abort&quot;</span> — unwinding
          across the FFI boundary into SQLite&apos;s C is undefined behaviour, and Emscripten cannot
          lower the unwind. A panic in <span className={mono}>Engine::load</span> takes down{" "}
          <strong className="text-foreground">the entire database instance</strong>, so load and
          inference paths return errors rather than panicking.
        </Note>
      </Section>

      {/* ---------------- sql surface ---------------- */}
      <Section id="sql" title="SQL surface" lede="Everything the extension adds to the language.">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <Card name="TEXT VECTOR" role="A column declared in CREATE VIRTUAL TABLE … USING anki(…). Auto-embedded on write." />
          <Card name="col MATCH 'text'" role="Semantic search. Supports /exact and /hnsw:N directives; default similarity threshold 0.5." />
          <Card name="<col>_score" role="Hidden, query-time cosine similarity. Works in SELECT, WHERE, ORDER BY, GROUP BY and inside aggregates." />
          <Card name="anki_hnsw_json / _dot" role="Export a vector column's persisted graph topology for visualization." />
          <Card name="anki_model / anki_dim" role="The loaded model's id and embedding dimension." />
          <Card name="anki_version / similarity" role="Build constant, and cosine similarity between two vectors." />
        </div>
      </Section>

      <footer className="border-t pt-4 text-xs text-muted-foreground">
        <span className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="font-mono">
            anki
          </Badge>
          Structure mirrors the repository: crates/anki-core/src/, crates/anki-wasm/src/lib.rs,
          wasm/anki_extension.c, packages/wasm/src/, apps/explorer/src/db/.
        </span>
      </footer>
    </div>
  );
}
