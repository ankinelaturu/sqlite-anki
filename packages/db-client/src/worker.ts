/**
 * SQLite worker: runs the WASM engine and OPFS database off the main thread.
 */
import initSqliteAnki from "@sqlite-anki/wasm";
import * as Comlink from "comlink";
import type {
  AnkiDatabaseApi,
  ColumnInfo,
  QueryResult,
  Row,
  SqlValue,
  TableInfo,
} from "./types";

type Sqlite3 = Awaited<ReturnType<typeof initSqliteAnki>>;
type Db = InstanceType<Sqlite3["oo1"]["DB"]> | InstanceType<Sqlite3["oo1"]["OpfsDb"]>;

/** Escapes a SQLite identifier (table/column name). */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Returns true when the declared column type is a TEXT VECTOR (or contains VECTOR). */
function isVectorType(declaredType: string): boolean {
  return declaredType.toUpperCase().includes("VECTOR");
}

/**
 * Database worker implementation — one instance per worker global.
 * All methods assume `open()` was called successfully first.
 */
class AnkiDatabaseWorker implements AnkiDatabaseApi {
  private sqlite3: Sqlite3 | null = null;
  private db: Db | null = null;

  /** Opens (or creates) the OPFS-backed database at `dbPath`. */
  async open(dbPath: string): Promise<{ opfs: boolean; version: string }> {
    this.sqlite3 = await initSqliteAnki();
    const sqlite3 = this.sqlite3;

    if ("opfs" in sqlite3 && sqlite3.opfs) {
      this.db = new sqlite3.oo1.OpfsDb(dbPath);
    } else {
      this.db = new sqlite3.oo1.DB(dbPath, "ct");
    }

    return {
      opfs: "opfs" in sqlite3 && Boolean(sqlite3.opfs),
      version: sqlite3.version.libVersion,
    };
  }

  /** Lists user tables from `sqlite_master`. */
  async listTables(): Promise<TableInfo[]> {
    const db = this.requireDb();
    const rows = db.selectObjects(
      `SELECT name, sql, type FROM sqlite_master
       WHERE type IN ('table', 'virtual table')
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE 'anki_%'
       ORDER BY name`,
    ) as Array<{ name: string; sql: string; type: string }>;

    return rows.map((r) => ({
      name: r.name,
      sql: r.sql ?? "",
      isVirtual: r.type === "virtual table",
    }));
  }

  /** Returns column metadata for `table` via `PRAGMA table_info`. */
  async getColumns(table: string): Promise<ColumnInfo[]> {
    const db = this.requireDb();
    const rows = db.selectObjects(
      `PRAGMA table_info(${quoteIdent(table)})`,
    ) as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;

    return rows.map((r) => ({
      cid: r.cid,
      name: r.name,
      type: r.type,
      notnull: r.notnull === 1,
      dflt_value: r.dflt_value,
      pk: r.pk === 1,
      isVector: isVectorType(r.type),
    }));
  }

  /** Fetches a page of rows including `rowid`. */
  async fetchRows(
    table: string,
    limit: number,
    offset: number,
  ): Promise<QueryResult> {
    const db = this.requireDb();
    const columns = (await this.getColumns(table)).map((c) => c.name);
    const colList = ["rowid", ...columns.map(quoteIdent)].join(", ");
    const sql = `SELECT ${colList} FROM ${quoteIdent(table)} LIMIT ? OFFSET ?`;

    const rows = db.selectObjects(sql, [limit, offset]) as Row[];
    return {
      columns: ["rowid", ...columns],
      rows,
    };
  }

  /** Inserts one row; returns SQLite `rowid`. */
  async insertRow(
    table: string,
    values: Record<string, SqlValue>,
  ): Promise<number> {
    const db = this.requireDb();
    const keys = Object.keys(values);
    if (keys.length === 0) {
      throw new Error("insertRow: no columns provided");
    }

    const cols = keys.map(quoteIdent).join(", ");
    const placeholders = keys.map(() => "?").join(", ");
    const sql = `INSERT INTO ${quoteIdent(table)} (${cols}) VALUES (${placeholders})`;

    db.exec({ sql, bind: keys.map((k) => values[k]) });
    const [{ rowid }] = db.selectObjects("SELECT last_insert_rowid() AS rowid") as [
      { rowid: number },
    ];
    return rowid;
  }

  /** Updates a single cell by `rowid`. */
  async updateCell(
    table: string,
    rowid: number,
    column: string,
    value: SqlValue,
  ): Promise<void> {
    const db = this.requireDb();
    const sql = `UPDATE ${quoteIdent(table)} SET ${quoteIdent(column)} = ? WHERE rowid = ?`;
    db.exec({ sql, bind: [value, rowid] });
  }

  /** Deletes one row by `rowid`. */
  async deleteRow(table: string, rowid: number): Promise<void> {
    const db = this.requireDb();
    db.exec({ sql: `DELETE FROM ${quoteIdent(table)} WHERE rowid = ?`, bind: [rowid] });
  }

  /**
   * Semantic search on a TEXT VECTOR column.
   * Requires sqlite-anki extension (`MATCH` / `similarity()`).
   */
  async semanticSearch(
    table: string,
    column: string,
    query: string,
    limit: number,
    minSimilarity = 0.5,
  ): Promise<QueryResult> {
    const db = this.requireDb();
    const columns = (await this.getColumns(table)).map((c) => c.name);
    const colList = ["rowid", ...columns.map(quoteIdent)].join(", ");

    const sql = `SELECT ${colList}, similarity(${quoteIdent(column)}) AS _similarity
      FROM ${quoteIdent(table)}
      WHERE ${quoteIdent(column)} MATCH ?
        AND similarity(${quoteIdent(column)}) > ?
      ORDER BY _similarity DESC
      LIMIT ?`;

    try {
      const rows = db.selectObjects(sql, [query, minSimilarity, limit]) as Row[];
      return {
        columns: ["rowid", ...columns, "_similarity"],
        rows,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Semantic search failed (is sqlite-anki loaded?): ${message}`,
      );
    }
  }

  /** Runs arbitrary SQL with optional bound parameters. */
  async exec(sql: string, params: SqlValue[] = []): Promise<void> {
    this.requireDb().exec({ sql, bind: params });
  }

  /**
   * Creates sample data for the explorer.
   * Tries `anki` virtual table first; falls back to a regular table.
   */
  async seedDemo(): Promise<void> {
    const db = this.requireDb();

    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS customers USING anki(
        customer_name TEXT,
        notes TEXT VECTOR
      )`);
    } catch {
      db.exec(`CREATE TABLE IF NOT EXISTS customers (
        customer_name TEXT NOT NULL,
        notes TEXT
      )`);
    }

    const count = db.selectValue(
      "SELECT COUNT(*) FROM customers",
    ) as number;

    if (count === 0) {
      db.exec({
        sql: `INSERT INTO customers (customer_name, notes) VALUES (?, ?), (?, ?)`,
        bind: [
          "Acme Corp",
          "Discussed renewal — potential upsell opportunity in Q3",
          "Beta LLC",
          "Support ticket about billing, no sales interest",
        ],
      });
    }
  }

  private requireDb(): Db {
    if (!this.db) {
      throw new Error("Database not open — call open() first");
    }
    return this.db;
  }
}

Comlink.expose(new AnkiDatabaseWorker());
