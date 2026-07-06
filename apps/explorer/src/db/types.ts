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
  /** Column has a DEFAULT value (`dflt_value` in `PRAGMA table_info`). */
  hasDefault: boolean;
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

/** A column of an imported source table (from `PRAGMA table_info`). */
export interface ImportColumn {
  name: string;
  type: string;
  /** Declared type has TEXT affinity (empty/TEXT/CHAR/CLOB) — offered to vectorize. */
  textLike: boolean;
  /** Declared type has BLOB affinity — informational (BLOBs round-trip either way). */
  isBlob: boolean;
  /** Name uses the reserved `anki_` prefix — must be renamed before vectorizing. */
  reserved: boolean;
}

/** One table or view discovered in an uploaded SQLite file. */
export interface ImportTable {
  name: string;
  isView: boolean;
  rowCount: number;
  columns: ImportColumn[];
}

/** Result of inspecting an uploaded SQLite file's schema. */
export interface ImportAnalysis {
  tables: ImportTable[];
}

/** What to build from an import: per-table vector-column picks + freeform notes. */
export interface ImportPlan {
  /** Table name → column names to make `TEXT VECTOR`. Absent/empty = plain copy. */
  tables: Record<string, string[]>;
  /**
   * Per-vectorized-table column renames: `{ table: { oldName: newName } }`. Used to
   * escape source columns whose names use the reserved `anki_` prefix (a vectorized
   * table becomes an `anki` vtab, which reserves that prefix). Plain-copied tables are
   * never renamed.
   */
  renames: Record<string, Record<string, string>>;
  /** Freeform notes to seed the rebuilt database's `.notes.md` sidecar. */
  notes: string;
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
  /**
   * Inspects an uploaded SQLite file's bytes (without persisting it): lists its
   * tables/views, their columns, and row counts, flagging text-like columns as
   * vectorize candidates. Used to drive the Import & Vectorize dialog.
   */
  analyzeImport(bytes: Uint8Array): Promise<ImportAnalysis>;
  /**
   * Rebuilds an uploaded SQLite file into a new sqlite-anki database at `targetPath`,
   * overwriting any existing database/sidecars there. Tables with picked columns
   * become `anki` virtual tables (picked columns are `TEXT VECTOR`, embedded on
   * insert); other tables/views are copied verbatim. If no column is picked
   * anywhere, the file is persisted unchanged. Reports embedding progress via
   * `onProgress` (wrap with `proxy()`), counting rows of vectorized tables only.
   */
  rebuildImport(
    bytes: Uint8Array,
    targetPath: string,
    plan: ImportPlan,
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
