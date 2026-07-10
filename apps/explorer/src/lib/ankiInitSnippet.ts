import { ANKI_MODEL_REGISTRY } from "@sqlite-anki/wasm/registry";

/** TypeScript init snippet shown on the model gate (public `@sqlite-anki/wasm` API). */
export function ankiInitSnippet(modelId: string): string {
  const dim = ANKI_MODEL_REGISTRY[modelId]?.dim ?? 384;
  return `import sqlite3Init from "@sqlite-anki/wasm";

// Boot SQLite (WASM) and load an embedding model. The model is fetched once
// from HuggingFace and cached in OPFS — it is NOT bundled into the wasm.
const sqlite3 = await sqlite3Init({
  anki: {
    model: "${modelId}", // pre-defined model id
    // OR custom properties
    // modelUrl: "https://example.com/model.onnx",
    // tokenizerUrl: "https://example.com/tokenizer.json",
    // dim: ${dim},
    // modelId: "${modelId}",
  },
});

// Open a persistent, OPFS-backed database (or ":memory:" for an ephemeral one).
const db = new sqlite3.oo1.OpfsDb("/app.db");

// A \`TEXT VECTOR\` column is embedded automatically on every write.
db.exec(\`
  CREATE VIRTUAL TABLE IF NOT EXISTS docs USING anki(
    title TEXT,
    body  TEXT VECTOR
  );
\`);
`;
}
