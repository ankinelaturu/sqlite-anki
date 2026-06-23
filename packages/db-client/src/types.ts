/** Column metadata from `PRAGMA table_info`. */
export interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: boolean;
  dflt_value: string | null;
  pk: boolean;
  /** True when declared type includes `VECTOR` (e.g. `TEXT VECTOR`). */
  isVector: boolean;
}

/** User table from `sqlite_master`. */
export interface TableInfo {
  name: string;
  sql: string;
  isVirtual: boolean;
}

/** Single row as column name → value (includes `rowid` when selected). */
export type Row = Record<string, unknown>;

/** SQLite values allowed in bound parameters. */
export type SqlValue = string | number | bigint | null | Uint8Array;

/** Result of `fetchRows` / `semanticSearch`. */
export interface QueryResult {
  columns: string[];
  rows: Row[];
}

/** Remote database API exposed from the OPFS worker via Comlink. */
export interface AnkiDatabaseApi {
  open(dbPath: string): Promise<{ opfs: boolean; version: string }>;
  listTables(): Promise<TableInfo[]>;
  getColumns(table: string): Promise<ColumnInfo[]>;
  fetchRows(table: string, limit: number, offset: number): Promise<QueryResult>;
  insertRow(table: string, values: Record<string, SqlValue>): Promise<number>;
  updateCell(
    table: string,
    rowid: number,
    column: string,
    value: SqlValue,
  ): Promise<void>;
  deleteRow(table: string, rowid: number): Promise<void>;
  semanticSearch(
    table: string,
    column: string,
    query: string,
    limit: number,
    minSimilarity?: number,
  ): Promise<QueryResult>;
  exec(sql: string, params?: SqlValue[]): Promise<void>;
  seedDemo(): Promise<void>;
}
