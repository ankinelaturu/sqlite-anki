// Shared test harness for the sqlite-anki WASM build.
//
// Runs against the node loader emitted by `pnpm build:wasm`
// (packages/wasm/dist/sqlite3-node.mjs + sqlite3.wasm) and loads the dev model
// from models/all-MiniLM-L6-v2/ by passing bytes to the extension — exactly how
// the browser glue's `modelBytes` path works. Requires:
//   1. scripts/download-model.sh   (model files present)
//   2. pnpm build:wasm             (dist + node loader present)

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", ".."); // packages/wasm/test -> repo root
const dist = join(here, "..", "dist");
const modelDir = join(root, "models", "all-MiniLM-L6-v2");

export const MODEL_ID = "all-MiniLM-L6-v2";
export const MODEL_DIM = 384;

function requireFile(path, hint) {
  if (!existsSync(path)) {
    throw new Error(`missing ${path}\n  -> ${hint}`);
  }
  return path;
}

/** Initializes a fresh wasm module instance (no model loaded). */
export async function loadModule() {
  const wasmPath = requireFile(join(dist, "sqlite-anki.wasm"), "run: pnpm build:wasm");
  const loaderPath = requireFile(
    join(dist, "sqlite-anki_node.mjs"),
    "run: pnpm build:wasm"
  );
  const wasmBinary = readFileSync(wasmPath);
  const { default: init } = await import(loaderPath);
  return init({ wasmBinary, printErr: () => {} });
}

/** Reads the dev model + tokenizer bytes from models/. */
export function modelBytes() {
  return {
    modelBytes: new Uint8Array(
      readFileSync(requireFile(join(modelDir, "model.onnx"), "run: scripts/download-model.sh"))
    ),
    tokenizerBytes: new Uint8Array(
      readFileSync(requireFile(join(modelDir, "tokenizer.json"), "run: scripts/download-model.sh"))
    ),
    dim: MODEL_DIM,
    modelId: MODEL_ID,
  };
}

/**
 * Loads a model into an initialized module via the exported `anki_load_model`
 * (mirrors the browser glue's byte-passing path). Throws on failure.
 */
export function loadModel(sqlite3, spec = modelBytes()) {
  const w = sqlite3.wasm;
  const idBytes = new TextEncoder().encode(spec.modelId);
  const mp = w.allocFromTypedArray(spec.modelBytes);
  const tp = w.allocFromTypedArray(spec.tokenizerBytes);
  const ip = w.allocFromTypedArray(idBytes);
  try {
    const rc = w.exports.anki_load_model(
      mp,
      spec.modelBytes.length,
      tp,
      spec.tokenizerBytes.length,
      spec.dim,
      ip,
      idBytes.length
    );
    if (rc !== 0) {
      throw new Error("anki_load_model returned non-zero");
    }
  } finally {
    w.dealloc(mp);
    w.dealloc(tp);
    w.dealloc(ip);
  }
}

/** Fresh module instance with the dev model already loaded. */
export async function withModel() {
  const sqlite3 = await loadModule();
  loadModel(sqlite3);
  return sqlite3;
}
