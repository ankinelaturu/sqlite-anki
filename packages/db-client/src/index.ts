/**
 * Main-thread facade for the sqlite-anki database worker.
 */
import * as Comlink from "comlink";
import type { AnkiDatabaseApi } from "./types";

export type {
  AnkiDatabaseApi,
  ColumnInfo,
  QueryResult,
  Row,
  SqlValue,
  TableInfo,
} from "./types";

const DEFAULT_DB_PATH = "/sqlite-anki-explorer.db";

let worker: Worker | null = null;
let api: Comlink.Remote<AnkiDatabaseApi> | null = null;

export interface ConnectResult {
  api: Comlink.Remote<AnkiDatabaseApi>;
  opfs: boolean;
  version: string;
}

/**
 * Starts the OPFS SQLite worker and opens the database at `dbPath`.
 *
 * @param dbPath - OPFS file path (default `/sqlite-anki-explorer.db`)
 */
export async function connectAnkiDatabase(
  dbPath = DEFAULT_DB_PATH,
): Promise<ConnectResult> {
  if (!api) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    api = Comlink.wrap<AnkiDatabaseApi>(worker);
  }

  const info = await api.open(dbPath);
  return { api, ...info };
}

/** Terminates the worker and clears the cached API handle. */
export function disconnectAnkiDatabase(): void {
  worker?.terminate();
  worker = null;
  api = null;
}
