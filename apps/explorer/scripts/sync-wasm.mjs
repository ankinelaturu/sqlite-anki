// Copies the built sqlite-anki wasm artifacts into the explorer's public/ so
// they are served from the origin root in BOTH `vite dev` and `vite build`
// (the Emscripten loader resolves the .wasm / OPFS proxy as its siblings).
// Run automatically by the `dev` and `build` scripts.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "../../../packages/wasm/dist");
const pub = join(here, "../public");

const files = [
  "sqlite3-bundler-friendly.mjs",
  "sqlite3.wasm",
  "sqlite3-opfs-async-proxy.js",
];

mkdirSync(pub, { recursive: true });

let missing = false;
for (const f of files) {
  const src = join(dist, f);
  if (!existsSync(src)) {
    console.error(`sync-wasm: missing ${src} — run \`pnpm build:wasm\` first.`);
    missing = true;
    continue;
  }
  copyFileSync(src, join(pub, f));
}

if (missing) process.exit(1);
console.log(`sync-wasm: copied ${files.length} artifacts to public/`);
