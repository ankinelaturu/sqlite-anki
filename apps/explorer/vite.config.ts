import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

const codemirror = [
  "@codemirror/autocomplete",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/state",
  "@codemirror/view",
  "@codemirror/lang-sql",
  "@codemirror/lang-javascript",
  "@codemirror/lang-markdown",
  "codemirror",
];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
    // One CodeMirror instance — duplicate @codemirror/state breaks language + highlighting.
    dedupe: codemirror,
  },
  server: { headers },
  preview: { headers },
  worker: { format: "es" },
  optimizeDeps: {
    exclude: ["@sqlite-anki/wasm"],
    include: codemirror,
  },
});
