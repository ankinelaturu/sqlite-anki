/**
 * Initializes the SQLite WASM module.
 *
 * Today this re-exports `@sqlite.org/sqlite-wasm` until `pnpm build:wasm`
 * produces a custom `sqlite3.wasm` with the sqlite-anki extension linked in.
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

export type Sqlite3Module = Awaited<ReturnType<typeof sqlite3InitModule>>;

/** Loads and initializes `sqlite3.wasm` (with sqlite-anki when custom build is present). */
export default function initSqliteAnki(): Promise<Sqlite3Module> {
  return sqlite3InitModule();
}

export { sqlite3InitModule };
