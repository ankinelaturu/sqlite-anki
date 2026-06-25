/**
 * SQLite worker: runs the WASM engine + OPFS databases off the main thread,
 * loads the embedding model, and captures per-operation metrics.
 */
import initSqliteAnki from "@sqlite-anki/wasm";
import * as Comlink from "comlink";
import {
  ZERO_METRICS,
  type AnkiWorkerApi,
  type ColumnInfo,
  type InitResult,
  type Metrics,
  type ModelSpec,
  type QueryResult,
  type Row,
  type SqlValue,
  type TableInfo,
} from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Sqlite3 = any;
type Db = any;

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Extracts which columns are `TEXT VECTOR` from a `USING anki(...)` statement. */
function vectorColumns(sql: string): Set<string> {
  const out = new Set<string>();
  const m = /using\s+anki\s*\(([\s\S]*)\)/i.exec(sql);
  if (!m) return out;
  for (const part of m[1].split(",")) {
    const tokens = part.trim().split(/\s+/);
    if (tokens.length === 0) continue;
    const name = tokens[0].replace(/["`[\]]/g, "");
    if (tokens.slice(1).some((t) => t.toUpperCase() === "VECTOR")) out.add(name);
  }
  return out;
}

class AnkiWorker implements AnkiWorkerApi {
  private sqlite3: Sqlite3 | null = null;
  private opfsAvailable = false;
  private dbs = new Map<string, Db>();

  async init(model: ModelSpec): Promise<InitResult> {
    this.sqlite3 = await initSqliteAnki(
      model && (model.model || model.modelUrl || model.modelBytes)
        ? { anki: model as any }
        : undefined,
    );
    const s = this.sqlite3;
    this.opfsAvailable = "opfs" in s && Boolean(s.opfs);
    return {
      opfs: this.opfsAvailable,
      version: s.version.libVersion,
      modelId: model.modelId ?? model.model ?? null,
      dim: model.dim ?? null,
    };
  }

  async listDatabases(): Promise<string[]> {
    try {
      const root = await (navigator as any).storage.getDirectory();
      const names: string[] = [];
      for await (const [name, handle] of (root as any).entries()) {
        if (handle.kind === "file" && name.endsWith(".db")) names.push(name);
      }
      return names.sort();
    } catch {
      return [];
    }
  }

  async openDatabase(path: string): Promise<TableInfo[]> {
    const s = this.require();
    if (!this.dbs.has(path)) {
      const db = this.opfsAvailable
        ? new s.oo1.OpfsDb(path)
        : new s.oo1.DB(path, "ct");
      this.dbs.set(path, db);
    }
    return this.schema(path);
  }

  async dropDatabase(path: string): Promise<void> {
    this.dbs.get(path)?.close();
    this.dbs.delete(path);
    try {
      const root = await (navigator as any).storage.getDirectory();
      await root.removeEntry(path.replace(/^\//, ""));
    } catch {
      /* ignore */
    }
  }

  async schema(path: string): Promise<TableInfo[]> {
    const db = this.db(path);
    const tables = db.selectObjects(
      `SELECT name, sql, type FROM sqlite_master
       WHERE type IN ('table', 'view')
         AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'anki_%'
         AND name NOT LIKE '%_data'
       ORDER BY name`,
    ) as Array<{ name: string; sql: string; type: string }>;

    return tables.map((t) => {
      const isAnki = /using\s+anki/i.test(t.sql ?? "");
      const vec = isAnki ? vectorColumns(t.sql) : new Set<string>();
      const cols = db.selectObjects(
        `PRAGMA table_info(${quote(t.name)})`,
      ) as Array<{ name: string; type: string; notnull: number; pk: number }>;
      const columns: ColumnInfo[] = cols.map((c) => ({
        name: c.name,
        type: c.type || (vec.has(c.name) ? "TEXT VECTOR" : ""),
        notnull: c.notnull === 1,
        pk: c.pk === 1,
        isVector: vec.has(c.name),
      }));
      return {
        name: t.name,
        sql: t.sql ?? "",
        isVirtual: isAnki,
        isAnki,
        columns,
      };
    });
  }

  async query(path: string, sql: string, params: SqlValue[] = []): Promise<QueryResult> {
    const db = this.db(path);
    const before = this.readMetrics();
    const t0 = performance.now();
    const rows = db.exec({
      sql,
      bind: params,
      rowMode: "object",
      returnValue: "resultRows",
    }) as Row[];
    const elapsedMs = performance.now() - t0;
    const after = this.readMetrics();
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return {
      columns,
      rows,
      rowsAffected: db.changes(),
      elapsedMs,
      metrics: this.diff(before, after),
    };
  }

  async tableData(
    path: string,
    table: string,
    limit: number,
    offset: number,
  ): Promise<QueryResult> {
    return this.query(
      path,
      `SELECT rowid AS rowid, * FROM ${quote(table)} LIMIT ? OFFSET ?`,
      [limit, offset],
    );
  }

  async updateCell(
    path: string,
    table: string,
    rowid: number,
    column: string,
    value: SqlValue,
  ): Promise<QueryResult> {
    return this.query(
      path,
      `UPDATE ${quote(table)} SET ${quote(column)} = ? WHERE rowid = ?`,
      [value, rowid],
    );
  }

  async insertRow(
    path: string,
    table: string,
    values: Record<string, SqlValue>,
  ): Promise<QueryResult> {
    const keys = Object.keys(values);
    if (keys.length === 0) throw new Error("insertRow: no columns");
    const cols = keys.map(quote).join(", ");
    const ph = keys.map(() => "?").join(", ");
    return this.query(
      path,
      `INSERT INTO ${quote(table)} (${cols}) VALUES (${ph})`,
      keys.map((k) => values[k]),
    );
  }

  async deleteRow(path: string, table: string, rowid: number): Promise<QueryResult> {
    return this.query(path, `DELETE FROM ${quote(table)} WHERE rowid = ?`, [rowid]);
  }

  async metrics(): Promise<Metrics> {
    return this.readMetrics();
  }

  // --- internals ---

  private require(): Sqlite3 {
    if (!this.sqlite3) throw new Error("worker not initialized — call init() first");
    return this.sqlite3;
  }

  private db(path: string): Db {
    const db = this.dbs.get(path);
    if (!db) throw new Error(`database not open: ${path}`);
    return db;
  }

  private readMetrics(): Metrics {
    try {
      const wasm = this.sqlite3?.wasm;
      const fn = wasm?.exports?.anki_metrics;
      if (!fn) return { ...ZERO_METRICS };
      const ptr = fn();
      return { ...ZERO_METRICS, ...JSON.parse(wasm.cstrToJs(ptr)) };
    } catch {
      return { ...ZERO_METRICS };
    }
  }

  private diff(a: Metrics, b: Metrics): Metrics {
    const out = { ...ZERO_METRICS };
    for (const k of Object.keys(out) as (keyof Metrics)[]) {
      out[k] = +(b[k] - a[k]).toFixed(3);
    }
    return out;
  }
}

Comlink.expose(new AnkiWorker());
