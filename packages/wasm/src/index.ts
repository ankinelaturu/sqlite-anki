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
 * `sqlite3Init` is THE public entry point: it boots the custom `dist/` build and
 * (given `opts.anki`) loads the model. The loader is imported statically so the
 * bundler rewrites its sibling `sqlite-anki.wasm` / OPFS-proxy URLs (works in Vite
 * dev + build); it's pulled in only here, not by the model registry, so a main
 * thread that only reads `@sqlite-anki/wasm/registry` stays free of the wasm.
 */
import type { default as UpstreamInit } from "@sqlite.org/sqlite-wasm";
// @ts-ignore untyped generated .mjs
import sqlite3WasmInit from "../dist/sqlite-anki_bundler-friendly.mjs";
import { ANKI_MODEL_REGISTRY, type AnkiModelSpec } from "./registry";

export type Sqlite3Module = Awaited<ReturnType<typeof UpstreamInit>>;
export { ANKI_MODEL_REGISTRY };
export type { AnkiModelSpec };

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

/** OPFS subdirectory where fetched model/tokenizer bytes are cached. */
const MODEL_CACHE_DIR = "anki-models";

/** Stable cache filename for a URL (sanitized, no collisions across our URLs). */
function cacheFileName(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** The OPFS cache directory, or null when OPFS is unavailable. */
async function modelCacheDir(): Promise<any> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const root = await (navigator as any)?.storage?.getDirectory?.();
    return root ? await root.getDirectoryHandle(MODEL_CACHE_DIR, { create: true }) : null;
  } catch {
    return null;
  }
}

/**
 * Fetches bytes, caching them in OPFS so the (large) model isn't re-downloaded
 * on later sessions — only the first load hits the network. Falls back to a
 * plain fetch when OPFS is unavailable.
 */
async function fetchBytes(url: string, what: string): Promise<Uint8Array> {
  const name = cacheFileName(url);
  const dir = await modelCacheDir();

  if (dir) {
    try {
      const file = await (await dir.getFileHandle(name)).getFile();
      if (file.size > 0) return new Uint8Array(await file.arrayBuffer());
    } catch {
      /* not cached yet */
    }
  }

  const r = await fetch(url, { credentials: "omit" });
  if (!r.ok) {
    throw new Error(`anki: failed to fetch ${what} (${r.status}) from ${url}`);
  }
  const bytes = new Uint8Array(await r.arrayBuffer());

  if (dir) {
    try {
      const h = await dir.getFileHandle(name, { create: true });
      const w = await h.createWritable();
      await w.write(bytes);
      await w.close();
    } catch {
      /* best-effort cache; ignore write failures */
    }
  }
  return bytes;
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
 * Boots the custom `sqlite-anki.wasm` (with the sqlite-anki extension) and, when
 * `opts.anki` is given, loads the embedding model. This is the entry point apps
 * should call.
 */
export default async function initSqliteAnki(
  opts?: Sqlite3InitOptions
): Promise<Sqlite3Module> {
  const sqlite3 = (await sqlite3WasmInit()) as Sqlite3Module;
  if (opts?.anki) {
    await loadAnkiModel(sqlite3, opts.anki);
  }
  return sqlite3;
}

/** Alias matching the documented API name. */
export const sqlite3Init = initSqliteAnki;
