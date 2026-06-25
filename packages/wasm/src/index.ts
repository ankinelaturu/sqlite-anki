/**
 * Initializes the sqlite-anki SQLite WASM module and, optionally, loads an
 * embedding model at init time.
 *
 * The model is NOT bundled in the wasm. When you pass an `anki` option, this
 * glue fetches the ONNX model + tokenizer (by registry id, custom URLs, or raw
 * bytes) and hands them to the extension via the exported `anki_load_model`.
 * The app never touches `fetch`, the wasm heap, or `anki_load_model`.
 *
 * See `docs/dynamic-model-loading.md`.
 *
 * Uses a custom `dist/` build when present (after `pnpm build:wasm`); otherwise
 * falls back to upstream `@sqlite.org/sqlite-wasm` (which has no `anki`).
 */
import type { default as UpstreamInit } from "@sqlite.org/sqlite-wasm";

export type Sqlite3Module = Awaited<ReturnType<typeof UpstreamInit>>;

/** A model the glue knows how to fetch by id. */
export interface AnkiModelSpec {
  modelUrl: string;
  tokenizerUrl: string;
  /** Embedding dimension — must match the model's output. */
  dim: number;
  /** Optional integrity pin for the model bytes. */
  sha256?: string;
}

/** Built-in model registry. Extend it or pass custom URLs/bytes instead. */
export const ANKI_MODEL_REGISTRY: Record<string, AnkiModelSpec> = {
  "all-MiniLM-L6-v2": {
    modelUrl:
      "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx",
    tokenizerUrl:
      "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json",
    dim: 384,
  },
};

export interface AnkiOption {
  /** Registry id (resolves URLs + dim). */
  model?: string;
  /** Custom model URLs (override or replace the registry). */
  modelUrl?: string;
  tokenizerUrl?: string;
  dim?: number;
  /** Logical id recorded for the model-mismatch guard. Defaults to `model`. */
  modelId?: string;
  /** Offline escape hatch: pass bytes directly instead of fetching. */
  modelBytes?: Uint8Array;
  tokenizerBytes?: Uint8Array;
  /** Reserved. Default `"error"`; `"reindex"` is not implemented yet. */
  onMismatch?: "error" | "reindex";
}

export interface Sqlite3InitOptions {
  anki?: AnkiOption;
  /**
   * URL of the Emscripten loader (`sqlite3-bundler-friendly.mjs`). When set, the
   * loader is imported from here at runtime and the `.wasm` / OPFS proxy resolve
   * as its siblings — letting an app serve the wasm dist from a stable path
   * (e.g. `public/`) so Vite dev and prod behave the same. Defaults to the
   * bundled `../dist/` copy.
   */
  wasmModuleUrl?: string;
}

let customInit: (() => Promise<Sqlite3Module>) | null | undefined;

async function loadCustomInit(
  moduleUrl?: string,
): Promise<(() => Promise<Sqlite3Module>) | null> {
  if (customInit !== undefined) {
    return customInit;
  }
  try {
    // Generated Emscripten output — no type declarations ship with it.
    const mod = moduleUrl
      ? await import(/* @vite-ignore */ moduleUrl)
      : // @ts-expect-error untyped generated .mjs
        await import("../dist/sqlite3-bundler-friendly.mjs");
    customInit = mod.default as () => Promise<Sqlite3Module>;
    return customInit;
  } catch {
    customInit = null;
    return null;
  }
}

interface ResolvedSpec {
  modelUrl?: string;
  tokenizerUrl?: string;
  dim: number;
  modelId: string;
  modelBytes?: Uint8Array;
  tokenizerBytes?: Uint8Array;
}

function resolveSpec(a: AnkiOption): ResolvedSpec {
  if (a.modelBytes && a.tokenizerBytes) {
    return {
      dim: a.dim ?? 0,
      modelId: a.modelId ?? a.model ?? "custom",
      modelBytes: a.modelBytes,
      tokenizerBytes: a.tokenizerBytes,
    };
  }
  if (a.model && ANKI_MODEL_REGISTRY[a.model]) {
    const s = ANKI_MODEL_REGISTRY[a.model];
    return {
      modelUrl: a.modelUrl ?? s.modelUrl,
      tokenizerUrl: a.tokenizerUrl ?? s.tokenizerUrl,
      dim: a.dim ?? s.dim,
      modelId: a.modelId ?? a.model,
    };
  }
  if (a.modelUrl && a.tokenizerUrl && a.dim) {
    return {
      modelUrl: a.modelUrl,
      tokenizerUrl: a.tokenizerUrl,
      dim: a.dim,
      modelId: a.modelId ?? a.model ?? "custom",
    };
  }
  throw new Error(
    "anki: provide { model } from the registry, { modelUrl, tokenizerUrl, dim }, or { modelBytes, tokenizerBytes, dim }"
  );
}

async function fetchBytes(url: string, what: string): Promise<Uint8Array> {
  // HTTP cache handles repeat loads; OPFS caching is a future improvement.
  const r = await fetch(url, { credentials: "omit" });
  if (!r.ok) {
    throw new Error(`anki: failed to fetch ${what} (${r.status}) from ${url}`);
  }
  return new Uint8Array(await r.arrayBuffer());
}

/**
 * Fetches (or uses provided) model + tokenizer bytes and loads them into the
 * extension. Called automatically by {@link initSqliteAnki} when an `anki`
 * option is given; exported for advanced/manual use.
 */
export async function loadAnkiModel(
  sqlite3: Sqlite3Module,
  a: AnkiOption
): Promise<void> {
  if (a.onMismatch === "reindex") {
    throw new Error("anki: onMismatch 'reindex' is not implemented yet");
  }
  const spec = resolveSpec(a);

  let modelBytes = spec.modelBytes;
  let tokenizerBytes = spec.tokenizerBytes;
  if (!modelBytes || !tokenizerBytes) {
    [modelBytes, tokenizerBytes] = await Promise.all([
      fetchBytes(spec.modelUrl!, "model"),
      fetchBytes(spec.tokenizerUrl!, "tokenizer"),
    ]);
  }
  if (!spec.dim) {
    throw new Error("anki: `dim` is required for custom models");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wasm = (sqlite3 as any).wasm;
  if (!wasm?.exports?.anki_load_model) {
    throw new Error(
      "anki: this build has no anki_load_model — use the custom @sqlite-anki/wasm build, not upstream @sqlite.org/sqlite-wasm"
    );
  }

  const idBytes = new TextEncoder().encode(spec.modelId);
  const mp = wasm.allocFromTypedArray(modelBytes);
  const tp = wasm.allocFromTypedArray(tokenizerBytes);
  const ip = wasm.allocFromTypedArray(idBytes);
  try {
    const rc = wasm.exports.anki_load_model(
      mp,
      modelBytes.length,
      tp,
      tokenizerBytes.length,
      spec.dim,
      ip,
      idBytes.length
    );
    if (rc !== 0) {
      throw new Error("anki: model load failed (anki_load_model returned non-zero)");
    }
  } finally {
    wasm.dealloc(mp);
    wasm.dealloc(tp);
    wasm.dealloc(ip);
  }
}

/**
 * Loads and initializes `sqlite3.wasm` (with sqlite-anki when the custom build
 * is present) and, if `opts.anki` is given, loads the embedding model.
 */
export default async function initSqliteAnki(
  opts?: Sqlite3InitOptions
): Promise<Sqlite3Module> {
  const custom = await loadCustomInit(opts?.wasmModuleUrl);
  const sqlite3 = custom
    ? await custom()
    : await (await import("@sqlite.org/sqlite-wasm")).default();

  if (opts?.anki) {
    await loadAnkiModel(sqlite3, opts.anki);
  }
  return sqlite3;
}

/** Alias matching the documented API name. */
export const sqlite3Init = initSqliteAnki;

export { default as sqlite3InitModule } from "@sqlite.org/sqlite-wasm";
