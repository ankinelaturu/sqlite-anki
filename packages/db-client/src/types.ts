/** Values allowed in bound parameters. */
export type SqlValue = string | number | bigint | null | Uint8Array;

/** Single row as column name → value. */
export type Row = Record<string, unknown>;

/** A column of a table. `isVector` is detected from the `USING anki(...)` SQL. */
export interface ColumnInfo {
  name: string;
  type: string;
  notnull: boolean;
  pk: boolean;
  isVector: boolean;
  /** Human description from the `_meta_columns` table, if present. */
  description?: string;
}

/** A user table (or anki virtual table). */
export interface TableInfo {
  name: string;
  sql: string;
  isVirtual: boolean;
  isAnki: boolean;
  columns: ColumnInfo[];
  /** Table description parsed from an inline `--` comment, if present. */
  description?: string;
}

/** Cumulative metric counters from `anki_metrics()` (all numbers). */
export interface Metrics {
  embed_ms: number;
  embed_calls: number;
  search_ms: number;
  search_ops: number;
  persist_ms: number;
  index_rebuild_ms: number;
  index_rebuilds: number;
  candidates: number;
  rows_matched: number;
}

/** Result of running SQL, with the per-operation metric delta + wall time. */
export interface QueryResult {
  columns: string[];
  rows: Row[];
  rowsAffected: number;
  elapsedMs: number;
  /** Metric delta attributable to this operation (`anki_metrics` before/after). */
  metrics: Metrics;
}

/** Model selection passed to `sqlite3Init({ anki })`. */
export interface ModelSpec {
  model?: string;
  modelUrl?: string;
  tokenizerUrl?: string;
  dim?: number;
  modelId?: string;
}

export interface InitResult {
  opfs: boolean;
  version: string;
  modelId: string | null;
  dim: number | null;
}

/** Remote database API exposed from the worker via Comlink. */
export interface AnkiWorkerApi {
  init(model: ModelSpec): Promise<InitResult>;
  listDatabases(): Promise<string[]>;
  openDatabase(path: string): Promise<TableInfo[]>;
  dropDatabase(path: string): Promise<void>;
  schema(path: string): Promise<TableInfo[]>;
  query(path: string, sql: string, params?: SqlValue[]): Promise<QueryResult>;
  tableData(
    path: string,
    table: string,
    limit: number,
    offset: number,
  ): Promise<QueryResult>;
  updateCell(
    path: string,
    table: string,
    rowid: number,
    column: string,
    value: SqlValue,
  ): Promise<QueryResult>;
  insertRow(
    path: string,
    table: string,
    values: Record<string, SqlValue>,
  ): Promise<QueryResult>;
  deleteRow(path: string, table: string, rowid: number): Promise<QueryResult>;
  metrics(): Promise<Metrics>;
  /**
   * Builds the demo CRM + knowledge-base database into `path`, overwriting any
   * existing database/sidecars. Reports embedding progress via `onProgress`
   * (wrap it with `proxy()` from this package). Slow — embeds ~400 rows.
   */
  populateDemo(
    path: string,
    onProgress: (done: number, total: number) => void,
  ): Promise<TableInfo[]>;
  /** Reads the database's sidecar notes (`.notes.md`); "" if none. */
  readNotes(path: string): Promise<string>;
  /** Writes the database's sidecar notes. */
  writeNotes(path: string, content: string): Promise<void>;
  /** Reads the database's sidecar SQL scratchpad (`.sql`); "" if none. */
  readQuery(path: string): Promise<string>;
  /** Writes the database's sidecar SQL scratchpad. */
  writeQuery(path: string, content: string): Promise<void>;
}

export const ZERO_METRICS: Metrics = {
  embed_ms: 0,
  embed_calls: 0,
  search_ms: 0,
  search_ops: 0,
  persist_ms: 0,
  index_rebuild_ms: 0,
  index_rebuilds: 0,
  candidates: 0,
  rows_matched: 0,
};
