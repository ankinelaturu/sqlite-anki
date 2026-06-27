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

/** Builds a registry entry from a HuggingFace repo with an `onnx/` export. */
function hf(
  repo: string,
  dim: number,
  maxTokens: number,
  sizeMb: number,
  description: string,
): AnkiModelSpec {
  const base = `https://huggingface.co/${repo}/resolve/main`;
  return {
    modelUrl: `${base}/onnx/model.onnx`,
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
 * embedder's pooling) served as fp32 ONNX from the reliable `Xenova/*` mirrors.
 * Mixed dimensions (384 vs 768) are intentional — vectors are only comparable
 * within one model, so a database is tied to the model that built it.
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
