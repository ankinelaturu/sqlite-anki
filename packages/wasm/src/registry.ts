/**
 * Built-in model registry — pure data, no wasm/engine imports, so the main
 * thread can list models without pulling the (large) loader into its bundle.
 */

/** A model the glue knows how to fetch by id. */
export interface AnkiModelSpec {
  modelUrl: string;
  tokenizerUrl: string;
  /** The model's home/landing page (not the file download) — for UIs. */
  homeUrl?: string;
  /** Embedding dimension — must match the model's output. */
  dim: number;
  /** Max input sequence length in tokens; longer text is truncated. */
  maxTokens?: number;
  /** Optional integrity pin for the model bytes. */
  sha256?: string;
  /** Approximate model download size in MB (for UIs). */
  sizeMb?: number;
  /** One-line human description (for UIs). */
  description?: string;
}

/**
 * Builds a registry entry from a HuggingFace repo with an `onnx/` export.
 * `file` selects the ONNX export (default fp32 `model.onnx`; pass
 * `onnx/model_fp16.onnx` for the half-precision variant).
 */
function hf(
  repo: string,
  dim: number,
  maxTokens: number,
  sizeMb: number,
  description: string,
  file = "onnx/model.onnx",
): AnkiModelSpec {
  const base = `https://huggingface.co/${repo}/resolve/main`;
  return {
    modelUrl: `${base}/${file}`,
    tokenizerUrl: `${base}/tokenizer.json`,
    homeUrl: `https://huggingface.co/${repo}`,
    dim,
    maxTokens,
    sizeMb,
    description,
  };
}

/**
 * Built-in model registry. Extend it or pass custom URLs/bytes instead.
 *
 * All entries are **mean-pooling** sentence-transformers (matching the
 * embedder's pooling) served from the reliable `Xenova/*` mirrors — fp32 by
 * default, plus an fp16 half-precision variant of the baseline (same graph, half
 * the download; the engine runs it because fp16 uses the same float ops as fp32).
 * Int8-quantized exports are intentionally omitted: they rewrite matmuls into
 * integer ops (`MatMulInteger`) the Tract engine doesn't implement.
 * Mixed dimensions (384 vs 768) are intentional — vectors are only comparable
 * within one model, so a database is tied to the model that built it (and each
 * fp32/fp16 id is a distinct model for the mismatch guard).
 *
 * `maxTokens` is each model's configured max sequence length (sentence-transformers
 * `max_seq_length`); text beyond it is truncated before embedding.
 */
export const ANKI_MODEL_REGISTRY: Record<string, AnkiModelSpec> = {
  "all-MiniLM-L6-v2": hf(
    "Xenova/all-MiniLM-L6-v2",
    384,
    256,
    90,
    "Fast, general-purpose baseline. The best default for English semantic search.",
  ),
  "all-MiniLM-L6-v2-fp16": hf(
    "Xenova/all-MiniLM-L6-v2",
    384,
    256,
    45,
    "Half-precision (fp16) baseline — ~half the download, results effectively identical to fp32. Pick this when first-load size matters most.",
    "onnx/model_fp16.onnx",
  ),
  "all-MiniLM-L12-v2": hf(
    "Xenova/all-MiniLM-L12-v2",
    384,
    256,
    133,
    "Deeper MiniLM — a little more accurate than L6, slightly slower.",
  ),
  "all-mpnet-base-v2": hf(
    "Xenova/all-mpnet-base-v2",
    768,
    384,
    435,
    "Highest general quality (768-dimensional). Best results, largest download.",
  ),
  "multi-qa-MiniLM-L6-cos-v1": hf(
    "Xenova/multi-qa-MiniLM-L6-cos-v1",
    384,
    512,
    90,
    "Tuned for question→passage retrieval and semantic search over documents.",
  ),
  "paraphrase-multilingual-MiniLM-L12-v2": hf(
    "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    384,
    128,
    470,
    "Multilingual (50+ languages) — search and match across different languages.",
  ),
  "gte-small": hf(
    "Xenova/gte-small",
    384,
    512,
    133,
    "Strong modern general-text embeddings with competitive retrieval quality.",
  ),
};
