/**
 * Initializes the SQLite WASM module.
 *
 * Uses a custom `dist/` build when present (after `pnpm build:wasm`);
 * otherwise falls back to upstream `@sqlite.org/sqlite-wasm`.
 */
import type { default as UpstreamInit } from "@sqlite.org/sqlite-wasm";

export type Sqlite3Module = Awaited<ReturnType<typeof UpstreamInit>>;

let customInit: (() => Promise<Sqlite3Module>) | null | undefined;

async function loadCustomInit(): Promise<(() => Promise<Sqlite3Module>) | null> {
  if (customInit !== undefined) {
    return customInit;
  }
  try {
    const mod = await import("../dist/sqlite3-bundler-friendly.mjs");
    customInit = mod.default as () => Promise<Sqlite3Module>;
    return customInit;
  } catch {
    customInit = null;
    return null;
  }
}

/** Loads and initializes `sqlite3.wasm` (with sqlite-anki when custom build is present). */
export default async function initSqliteAnki(): Promise<Sqlite3Module> {
  const custom = await loadCustomInit();
  if (custom) {
    return custom();
  }
  const { default: sqlite3InitModule } = await import("@sqlite.org/sqlite-wasm");
  return sqlite3InitModule();
}

export { default as sqlite3InitModule } from "@sqlite.org/sqlite-wasm";
