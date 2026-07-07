/**
 * SQLite worker: runs the WASM engine + OPFS databases off the main thread,
 * loads the embedding model, and captures per-operation metrics.
 */
// The public entry point: boots the wasm + (given `anki`) loads the model. It
// statically imports the loader internally, so the wasm URL is rewritten by the
// bundler in Vite dev + build.
import initSqliteAnki from "@sqlite-anki/wasm";
import * as Comlink from "comlink";
import DEMO_SQL from "./demo/demodb-schema.sql?raw";
import {
  ZERO_METRICS,
  type AnkiWorkerApi,
  type ColumnInfo,
  type ImportAnalysis,
  type ImportColumn,
  type ImportDrops,
  type ImportPlan,
  type ImportTable,
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

/**
 * Pulls inline `--` comments out of a stored CREATE statement: a comment on the
 * CREATE line is the table description; a comment trailing a column line is that
 * column's description. (SQLite preserves the CREATE text, comments included.)
 */
function parseSqlDescriptions(sql: string): {
  table?: string;
  cols: Map<string, string>;
} {
  const cols = new Map<string, string>();
  let table: string | undefined;
  (sql || "").split("\n").forEach((line, i) => {
    const ci = line.indexOf("--");
    if (ci < 0) return;
    const comment = line.slice(ci + 2).trim();
    if (!comment) return;
    if (i === 0) {
      table = comment; // comment on the CREATE / AS line
      return;
    }
    const m = line.slice(0, ci).match(/["'`[]?([A-Za-z_][A-Za-z0-9_]*)/);
    if (m) cols.set(m[1], comment);
  });
  return { table, cols };
}

/** Extracts which columns are `TEXT VECTOR` from a `USING anki(...)` statement. */
function vectorColumns(sql: string): Set<string> {
  const out = new Set<string>();
  const m = /using\s+anki\s*\(([\s\S]*)\)/i.exec(sql);
  if (!m) return out;
  // Strip `--` line comments first: the demo schema annotates columns inline,
  // and a trailing comment would otherwise bleed into the next comma-split part
  // and steal its column name.
  const body = m[1].replace(/--[^\n]*/g, "");
  for (const part of body.split(",")) {
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
    const anki = model && (model.model || model.modelUrl) ? (model as any) : undefined;
    const s = await initSqliteAnki(anki ? { anki } : undefined);
    this.sqlite3 = s;
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
        if (handle.kind === "file" && name.endsWith(".db")) names.push(`/${name}`);
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
    await this.ensureNotes(path);
    return this.schema(path);
  }

  async dropDatabase(path: string): Promise<void> {
    this.dbs.get(path)?.close();
    this.dbs.delete(path);
    try {
      const root = await (navigator as any).storage.getDirectory();
      await root.removeEntry(path.replace(/^\//, ""));
      await root.removeEntry(notesName(path)).catch(() => {});
      await root.removeEntry(queryName(path)).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  async populateDemo(
    path: string,
    onProgress: (done: number, total: number) => void,
  ): Promise<TableInfo[]> {
    // Overwrite: close + delete any existing database and its sidecars.
    await this.dropDatabase(path);
    this.sqlite3?.wasm?.exports?.anki_embed_log_reset?.(); // profile just this run

    const s = this.require();
    const db = this.opfsAvailable
      ? new s.oo1.OpfsDb(path)
      : new s.oo1.DB(path, "ct");
    this.dbs.set(path, db);

    // Setup (DDL + cheap data) runs as one blob; the vector-table rows run one
    // at a time so we can report embedding progress.
    const [setup, vectors = ""] = DEMO_SQL.split("--==VECTORS==--");
    db.exec(setup);
    const lines = vectors.split("\n").filter((l) => l.trim().length > 0);
    const total = lines.length;
    let done = 0;
    onProgress(0, total);
    for (const line of lines) {
      db.exec(line);
      done++;
      if (done % 2 === 0 || done === total) onProgress(done, total);
    }

    await writeSidecar(notesName(path), demoNotes());
    await writeSidecar(queryName(path), demoQuery());
    this.dumpEmbedLog();
    return this.schema(path);
  }

  /** Reads the per-embedding profiling log from the wasm. */
  private embedLog(): Array<{ text: string; ms: number; real_tokens: number; pad_tokens: number }> {
    try {
      const wasm = this.sqlite3?.wasm;
      const fn = wasm?.exports?.anki_embed_log;
      return fn ? JSON.parse(wasm.cstrToJs(fn())) : [];
    } catch {
      return [];
    }
  }

  /** Prints the per-embedding timings + a summary to the console. */
  private dumpEmbedLog(): void {
    const log = this.embedLog();
    if (log.length === 0) return;
    const ms = log.map((e) => e.ms).sort((a, b) => a - b);
    const sum = ms.reduce((a, b) => a + b, 0);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))];
    console.log(
      `[anki] embeddings: ${log.length} | avg ${(sum / log.length).toFixed(1)}ms | ` +
        `min ${ms[0].toFixed(1)} | p50 ${pct(50).toFixed(1)} | p95 ${pct(95).toFixed(1)} | ` +
        `max ${ms[ms.length - 1].toFixed(1)} | total ${(sum / 1000).toFixed(1)}s | ` +
        `tokens avg real ${mean(log.map((e) => e.real_tokens)).toFixed(1)} / pad ${mean(log.map((e) => e.pad_tokens)).toFixed(1)}`,
    );
    console.log(JSON.stringify(log));
  }

  async analyzeImport(bytes: Uint8Array): Promise<ImportAnalysis> {
    const s = this.require();
    const tmp = "anki-import-analyze.db";
    await writeOpfsFile(tmp, bytes);
    let db: Db | null = null;
    try {
      db = this.opfsAvailable
        ? new s.oo1.OpfsDb(`/${tmp}`)
        : new s.oo1.DB(`/${tmp}`, "ct");
      const objs = sourceObjects(db);
      const tables: ImportTable[] = objs.map((t) => ({
        name: t.name,
        isView: t.type === "view",
        rowCount: t.type === "view" ? 0 : rowCountOf(db, t.name),
        columns: t.columns,
        drops: t.drops,
      }));
      return { tables };
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
      await removeOpfsEntry(tmp);
    }
  }

  async rebuildImport(
    bytes: Uint8Array,
    targetPath: string,
    plan: ImportPlan,
    onProgress: (done: number, total: number) => void,
  ): Promise<TableInfo[]> {
    const s = this.require();
    const tmp = "anki-import-rebuild.db";
    await writeOpfsFile(tmp, bytes);
    const src: Db = this.opfsAvailable
      ? new s.oo1.OpfsDb(`/${tmp}`)
      : new s.oo1.DB(`/${tmp}`, "ct");
    try {
      const schema = sourceObjects(src);
      const anyPicks = Object.values(plan.tables).some((c) => c && c.length > 0);

      // Nothing selected: persist the uploaded bytes verbatim as the target db.
      if (!anyPicks) {
        await this.dropDatabase(targetPath);
        await writeOpfsFile(targetName(targetPath), bytes);
        await writeSidecar(notesName(targetPath), importNotes(targetPath, plan, schema));
        await writeSidecar(queryName(targetPath), importQuery(plan, schema));
        const dst = this.opfsAvailable
          ? new s.oo1.OpfsDb(targetPath)
          : new s.oo1.DB(targetPath, "ct");
        this.dbs.set(targetPath, dst);
        return this.schema(targetPath);
      }

      this.sqlite3?.wasm?.exports?.anki_embed_log_reset?.(); // profile just this rebuild
      await this.dropDatabase(targetPath);
      const dst: Db = this.opfsAvailable
        ? new s.oo1.OpfsDb(targetPath)
        : new s.oo1.DB(targetPath, "ct");
      this.dbs.set(targetPath, dst);

      // Only vectorized-table rows are slow (they embed); count just those.
      const total = schema
        .filter((t) => t.type === "table" && (plan.tables[t.name]?.length ?? 0) > 0)
        .reduce((n, t) => n + rowCountOf(src, t.name), 0);
      let done = 0;
      onProgress(0, total);

      // Tables first (views may reference them).
      const plainTables = new Set<string>(); // tables copied as plain SQLite tables
      for (const t of schema.filter((t) => t.type === "table")) {
        const picks = new Set(plan.tables[t.name] ?? []);
        const colNames = t.columns.map((c) => c.name);
        const rows = src.selectObjects(`SELECT * FROM ${quote(t.name)}`) as Row[];
        if (picks.size > 0) {
          // Escape reserved-prefix source columns (the vtab reserves `anki_`). The
          // anki column uses the renamed name; data is still read from the old name.
          const rn = plan.renames?.[t.name] ?? {};
          const target = (c: string) => rn[c] ?? c;
          // Carry the column constraints the shadow can enforce: NOT NULL, single-col
          // UNIQUE/PK, and column-level CHECK. CHECK is skipped when the table has a
          // reserved-name rename (its expression may reference the old name). DEFAULT,
          // table-level, and index/trigger/FK constraints don't come — see limitations.md.
          const checks = Object.keys(rn).length ? new Map<string, string>() : columnChecks(t.sql);
          const decl = t.columns
            .map((c) => {
              const parts = [quote(target(c.name))];
              if (c.type) parts.push(c.type);
              if (c.notNull) parts.push("NOT NULL");
              if (c.unique) parts.push("UNIQUE");
              const chk = checks.get(c.name);
              if (chk) parts.push(chk);
              if (picks.has(c.name)) parts.push("VECTOR");
              return parts.join(" ");
            })
            .join(", ");
          dst.exec(`CREATE VIRTUAL TABLE ${quote(t.name)} USING anki(${decl})`);
          const dstNames = colNames.map(target);
          for (const row of rows) {
            insertObjectRow(dst, t.name, colNames, row, dstNames);
            done++;
            if (done % 2 === 0 || done === total) onProgress(done, total);
          }
        } else {
          dst.exec(t.sql); // original CREATE TABLE — constraints preserved
          plainTables.add(t.name);
          dst.exec("BEGIN");
          for (const row of rows) insertObjectRow(dst, t.name, colNames, row);
          dst.exec("COMMIT");
        }
      }

      // Replay CREATE INDEX for plain-copied tables (after data, so each index is
      // built once). Vectorized tables became anki virtual tables, which SQLite
      // won't let you index, so their source indexes are necessarily dropped.
      // Auto-indexes from PK/UNIQUE have sql=NULL and already rode along with the
      // CREATE TABLE, so filtering on `sql IS NOT NULL` skips them.
      const indexes = src.selectObjects(
        `SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL`,
      ) as Array<{ tbl_name: string; sql: string }>;
      for (const ix of indexes) {
        if (!plainTables.has(ix.tbl_name)) continue;
        try {
          dst.exec(ix.sql);
        } catch {
          /* skip an index we can't recreate */
        }
      }

      // Views after their tables exist.
      for (const v of schema.filter((t) => t.type === "view")) {
        try {
          dst.exec(v.sql);
        } catch {
          /* skip views we can't recreate (e.g. referencing dropped objects) */
        }
      }

      // Replay CREATE TRIGGER last — after all data, tables, and views exist, so a
      // trigger neither fires on the copied rows nor references a missing target.
      // Triggers on plain tables and views (INSTEAD OF) are replayed; SQLite forbids
      // triggers on virtual tables, so triggers on vectorized tables are dropped.
      const triggerTargets = new Set<string>([
        ...plainTables,
        ...schema.filter((t) => t.type === "view").map((t) => t.name),
      ]);
      const triggers = src.selectObjects(
        `SELECT tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL`,
      ) as Array<{ tbl_name: string; sql: string }>;
      for (const tr of triggers) {
        if (!triggerTargets.has(tr.tbl_name)) continue;
        try {
          dst.exec(tr.sql);
        } catch {
          /* skip a trigger we can't recreate */
        }
      }

      await writeSidecar(notesName(targetPath), importNotes(targetPath, plan, schema));
      await writeSidecar(queryName(targetPath), importQuery(plan, schema));
      this.dumpEmbedLog();
      return this.schema(targetPath);
    } finally {
      try {
        src.close();
      } catch {
        /* ignore */
      }
      await removeOpfsEntry(tmp);
    }
  }

  async readNotes(path: string): Promise<string> {
    return readSidecar(notesName(path));
  }

  async writeNotes(path: string, content: string): Promise<void> {
    return writeSidecar(notesName(path), content);
  }

  async readQuery(path: string): Promise<string> {
    return readSidecar(queryName(path));
  }

  async writeQuery(path: string, content: string): Promise<void> {
    return writeSidecar(queryName(path), content);
  }

  private async ensureNotes(path: string): Promise<void> {
    try {
      const root = await (navigator as any).storage.getDirectory();
      await root.getFileHandle(notesName(path));
    } catch {
      await writeSidecar(notesName(path), defaultNotes(path));
    }
  }

  async schema(path: string): Promise<TableInfo[]> {
    const db = this.db(path);
    const tables = db.selectObjects(
      `SELECT name, sql, type FROM sqlite_master
       WHERE type IN ('table', 'view')
         AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'anki_%'
         AND name NOT LIKE '%_anki'
       ORDER BY name`,
    ) as Array<{ name: string; sql: string; type: string }>;

    return tables.map((t) => {
      const isAnki = /using\s+anki/i.test(t.sql ?? "");
      const vec = isAnki ? vectorColumns(t.sql) : new Set<string>();
      const desc = parseSqlDescriptions(t.sql ?? "");
      const cols = db.selectObjects(
        `PRAGMA table_info(${quote(t.name)})`,
      ) as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
        dflt_value: unknown;
      }>;
      const columns: ColumnInfo[] = cols.map((c) => ({
        name: c.name,
        type: c.type || (vec.has(c.name) ? "TEXT VECTOR" : ""),
        notnull: c.notnull === 1,
        pk: c.pk === 1,
        hasDefault: c.dflt_value != null,
        isVector: vec.has(c.name),
        description: desc.cols.get(c.name),
      }));
      return {
        name: t.name,
        sql: t.sql ?? "",
        isVirtual: isAnki,
        isAnki,
        columns,
        description: desc.table,
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

/** Reads a sidecar file's text; "" if it doesn't exist. */
async function readSidecar(name: string): Promise<string> {
  try {
    const root = await (navigator as any).storage.getDirectory();
    const h = await root.getFileHandle(name);
    return await (await h.getFile()).text();
  } catch {
    return "";
  }
}

/** Writes (creating if needed) a sidecar file. */
async function writeSidecar(name: string, content: string): Promise<void> {
  const root = await (navigator as any).storage.getDirectory();
  const h = await root.getFileHandle(name, { create: true });
  const w = await h.createWritable();
  await w.write(content);
  await w.close();
}

/** A table/view read from an imported file, with its original DDL and columns. */
interface SourceObject {
  name: string;
  sql: string;
  type: string; // 'table' | 'view'
  columns: ImportColumn[];
  drops: ImportDrops;
}

const NO_DROPS: ImportDrops = {
  indexes: 0,
  triggers: 0,
  foreignKeys: 0,
  hasCheck: false,
  defaults: [],
  multiColUnique: 0,
};

/**
 * Schema objects a table would lose if vectorized (it becomes an `anki` vtab):
 * explicit indexes, triggers, foreign keys, a `CHECK` constraint, `DEFAULT`s, and
 * multi-column `UNIQUE`/`PK`. Drives the ImportDialog warning; see docs/limitations.md.
 */
function tableDrops(
  db: Db,
  table: string,
  sql: string,
  info: Array<{ name: string; dflt_value: unknown }>,
): ImportDrops {
  const count = (q: string): number =>
    Number(
      db.selectValue(q, [table]) as number | bigint | null | undefined,
    ) || 0;
  const indexes = count(
    `SELECT count(*) FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`,
  );
  const triggers = count(
    `SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name=?`,
  );
  const fkRows = db.selectObjects(
    `PRAGMA foreign_key_list(${quote(table)})`,
  ) as Array<{ id: number }>;
  const foreignKeys = new Set(fkRows.map((r) => r.id)).size;
  const defaults = info.filter((c) => c.dflt_value != null).map((c) => String(c.name));
  let multiColUnique = 0;
  for (const ix of db.selectObjects(`PRAGMA index_list(${quote(table)})`) as Array<{
    name: string;
    unique: number;
  }>) {
    if (Number(ix.unique) !== 1) continue;
    const parts = db.selectObjects(`PRAGMA index_info(${quote(ix.name)})`);
    if (parts.length > 1) multiColUnique++;
  }
  return { indexes, triggers, foreignKeys, hasCheck: hasTableLevelCheck(sql), defaults, multiColUnique };
}

/** Whether a declared column type has TEXT affinity — a vectorize candidate. */
function isTextLike(type: string): boolean {
  return type === "" || /char|clob|text/i.test(type);
}

// --- Minimal CREATE TABLE parsing (for CHECK, which no PRAGMA exposes) ---

/**
 * If `s[i]` opens a quoted string/identifier (`'` `"` `` ` `` or `[`), returns the index
 * just past its closing delimiter (handling doubled-char escapes like `''`); otherwise
 * returns `i` unchanged. The shared primitive that makes the scanners below quote-safe.
 */
function skipQuoted(s: string, i: number): number {
  const c = s[i];
  const close = c === "[" ? "]" : c === "'" || c === '"' || c === "`" ? c : "";
  if (!close) return i;
  i++;
  while (i < s.length) {
    if (s[i] === close) {
      if (close !== "]" && s[i + 1] === close) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return i;
}

/** The text inside the outermost `(...)` of a CREATE TABLE statement, or `""`. */
function tableBody(sql: string): string {
  let i = 0,
    depth = 0,
    start = -1;
  while (i < sql.length) {
    const j = skipQuoted(sql, i);
    if (j !== i) {
      i = j;
      continue;
    }
    if (sql[i] === "(") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (sql[i] === ")") {
      depth--;
      if (depth === 0 && start >= 0) return sql.slice(start, i);
    }
    i++;
  }
  return "";
}

/** Splits a table body into top-level defs on commas at paren-depth 0 (quote-safe). */
function splitDefs(body: string): string[] {
  const defs: string[] = [];
  let i = 0,
    depth = 0,
    last = 0;
  while (i < body.length) {
    const j = skipQuoted(body, i);
    if (j !== i) {
      i = j;
      continue;
    }
    const ch = body[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      defs.push(body.slice(last, i));
      last = i + 1;
    }
    i++;
  }
  defs.push(body.slice(last));
  return defs;
}

/** The first identifier of a column def, unquoted (`""` if none). */
function firstIdent(def: string): string {
  const s = def.replace(/^\s+/, "");
  const c = s[0];
  if (c === '"' || c === "`" || c === "[") {
    const close = c === "[" ? "]" : c;
    let out = "";
    let i = 1;
    while (i < s.length) {
      if (s[i] === close) {
        if (close !== "]" && s[i + 1] === close) {
          out += close;
          i += 2;
          continue;
        }
        break;
      }
      out += s[i];
      i++;
    }
    return out;
  }
  return s.match(/^[A-Za-z_][A-Za-z0-9_$]*/)?.[0] ?? "";
}

/** True if a top-level def is a table-level constraint (not a column definition). */
function isTableConstraint(def: string): boolean {
  return /^\s*(constraint|primary|unique|check|foreign)\b/i.test(def);
}

/**
 * Column-name → its column-level `CHECK(...)` clause(s), parsed from a CREATE TABLE
 * statement. Table-level CHECKs are excluded (they can't be attributed to one column,
 * and the `anki(col …)` DSL is per-column). Keys are unquoted, to match `table_info`.
 */
function columnChecks(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const def of splitDefs(tableBody(sql))) {
    if (isTableConstraint(def) || !def.trim()) continue;
    const name = firstIdent(def);
    if (!name) continue;
    const checks: string[] = [];
    let i = 0;
    while (i < def.length) {
      const j = skipQuoted(def, i);
      if (j !== i) {
        i = j;
        continue;
      }
      // `CHECK` at a word boundary, followed by a balanced (...) group.
      if (
        /^check/i.test(def.slice(i, i + 5)) &&
        !/[A-Za-z0-9_]/.test(def[i - 1] ?? " ")
      ) {
        let k = i + 5;
        while (k < def.length && /\s/.test(def[k])) k++;
        if (def[k] === "(") {
          let depth = 0,
            m = k;
          while (m < def.length) {
            const n = skipQuoted(def, m);
            if (n !== m) {
              m = n;
              continue;
            }
            if (def[m] === "(") depth++;
            else if (def[m] === ")" && --depth === 0) {
              m++;
              break;
            }
            m++;
          }
          checks.push(`CHECK${def.slice(k, m)}`);
          i = m;
          continue;
        }
      }
      i++;
    }
    if (checks.length) out.set(name, checks.join(" "));
  }
  return out;
}

/**
 * True if the table has a **table-level** CHECK — one not attached to a single column
 * (bare `CHECK(...)` or `CONSTRAINT <name> CHECK(...)` in the column list). Column-level
 * CHECKs are carried; table-level ones can't be (the anki DSL is per-column), so only
 * these should be reported as dropped.
 */
function hasTableLevelCheck(sql: string): boolean {
  const namedConstraint =
    /^constraint\s+(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[A-Za-z_]\w*)\s+/i;
  return splitDefs(tableBody(sql)).some((d) =>
    /^check\b/i.test(d.trim().replace(namedConstraint, "")),
  );
}

/**
 * Column names carrying a **single-column** uniqueness guarantee on a table:
 * a single-column PRIMARY KEY (incl. `INTEGER PRIMARY KEY`, which has no index),
 * or any single-column unique index (a `UNIQUE` constraint or `CREATE UNIQUE INDEX`).
 * These carry onto a vectorized table as a `UNIQUE` column; multi-column ones can't
 * (the `anki(col …)` DSL is per-column).
 */
function uniqueColumns(
  db: Db,
  table: string,
  info: Array<{ name: string; pk: number }>,
): Set<string> {
  const uniq = new Set<string>();
  const pkCols = info.filter((c) => Number(c.pk) > 0);
  if (pkCols.length === 1) uniq.add(String(pkCols[0].name));
  const idxList = db.selectObjects(`PRAGMA index_list(${quote(table)})`) as Array<{
    name: string;
    unique: number;
    partial?: number;
  }>;
  for (const ix of idxList) {
    if (Number(ix.unique) !== 1 || Number(ix.partial) === 1) continue;
    const parts = db.selectObjects(
      `PRAGMA index_info(${quote(ix.name)})`,
    ) as Array<{ name: string | null }>;
    if (parts.length === 1 && parts[0].name) uniq.add(String(parts[0].name));
  }
  return uniq;
}

/** Reads the user tables/views (skipping sqlite-anki internals) with columns. */
function sourceObjects(db: Db): SourceObject[] {
  const objs = db.selectObjects(
    `SELECT name, sql, type FROM sqlite_master
     WHERE type IN ('table', 'view')
       AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'anki_%'
       AND name NOT LIKE '%_anki'
     ORDER BY type, name`,
  ) as Array<{ name: string; sql: string; type: string }>;
  return objs.map((o) => {
    const info = db.selectObjects(`PRAGMA table_info(${quote(o.name)})`) as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
      dflt_value: unknown;
    }>;
    const isTable = o.type === "table";
    const uniq = isTable ? uniqueColumns(db, String(o.name), info) : new Set<string>();
    const columns: ImportColumn[] = info.map((c) => {
      const type = String(c.type ?? "");
      const name = String(c.name);
      return {
        name,
        type,
        textLike: isTextLike(type),
        isBlob: /blob/i.test(type),
        reserved: /^anki_/i.test(name),
        notNull: Number(c.notnull) === 1,
        unique: uniq.has(name),
      };
    });
    return {
      name: String(o.name),
      sql: String(o.sql ?? ""),
      type: String(o.type),
      columns,
      drops: isTable ? tableDrops(db, String(o.name), String(o.sql ?? ""), info) : NO_DROPS,
    };
  });
}

/** `SELECT count(*)` for a table, as a number. */
function rowCountOf(db: Db, table: string): number {
  return Number(db.selectValue(`SELECT count(*) FROM ${quote(table)}`)) || 0;
}

/**
 * Inserts one object row into `table`. Values are read from `row` by `srcNames`;
 * they're written to columns `dstNames` (defaults to `srcNames`) — the two differ
 * only when a vectorized table renamed a reserved-prefix column.
 */
function insertObjectRow(
  db: Db,
  table: string,
  srcNames: string[],
  row: Row,
  dstNames: string[] = srcNames,
): void {
  const cols = dstNames.map(quote).join(", ");
  const ph = srcNames.map(() => "?").join(", ");
  db.exec({
    sql: `INSERT INTO ${quote(table)} (${cols}) VALUES (${ph})`,
    bind: srcNames.map((c) => (row[c] ?? null) as SqlValue),
  });
}

/** OPFS-root entry name for a database path: `/foo.db` → `foo.db`. */
function targetName(dbPath: string): string {
  return dbPath.replace(/^\//, "");
}

/** Writes raw bytes to an OPFS-root file (creating it), overwriting any content. */
async function writeOpfsFile(name: string, bytes: Uint8Array): Promise<void> {
  const root = await (navigator as any).storage.getDirectory();
  const h = await root.getFileHandle(name, { create: true });
  const w = await h.createWritable();
  await w.write(bytes);
  await w.close();
}

/** Best-effort removal of an OPFS-root entry. */
async function removeOpfsEntry(name: string): Promise<void> {
  try {
    const root = await (navigator as any).storage.getDirectory();
    await root.removeEntry(name);
  } catch {
    /* ignore */
  }
}

/** Seeds the imported database's notes sidecar: user notes + a schema summary. */
function importNotes(
  dbPath: string,
  plan: ImportPlan,
  schema: SourceObject[],
): string {
  const name = dbPath.replace(/^\//, "").replace(/\.db$/, "");
  const date = new Date().toISOString().slice(0, 10);
  const rows = schema.map((t) => {
    const picks = plan.tables[t.name] ?? [];
    const kind = t.type === "view" ? "view" : picks.length ? "anki" : "table";
    return `| \`${t.name}\` | ${kind} | ${picks.length ? picks.join(", ") : "—"} |`;
  });
  return `# ${name}

_Imported ${date} with sqlite-anki._

${plan.notes.trim() ? `${plan.notes.trim()}\n\n` : ""}## Tables

| Table | Kind | Vector columns |
| --- | --- | --- |
${rows.join("\n")}

> Rebuilt from an uploaded SQLite file. Plain-copied tables keep their original
> schema, indexes, and triggers; vectorized tables became \`anki\` virtual tables,
> which keep \`NOT NULL\`, single-column \`UNIQUE\`/\`PK\`, and column \`CHECK\` but drop
> indexes, triggers, foreign keys, \`DEFAULT\`, and table-level constraints (see
> docs/limitations.md).
`;
}

/** Generates a sample `MATCH` query per vectorized column into the SQL scratchpad. */
function importQuery(plan: ImportPlan, schema: SourceObject[]): string {
  const parts: string[] = [
    "-- Sample semantic-search queries for your imported database.",
    "-- Replace the quoted text with what you want to find, then Run.",
    "",
  ];
  let any = false;
  for (const t of schema) {
    for (const col of plan.tables[t.name] ?? []) {
      any = true;
      parts.push(
        `-- ${t.name}: search "${col}" by meaning`,
        `SELECT *, round(${quote(`${col}_score`)}, 3) AS score`,
        `FROM ${quote(t.name)}`,
        `WHERE ${quote(col)} MATCH 'your search text'`,
        `ORDER BY score DESC`,
        `LIMIT 10;`,
        "",
      );
    }
  }
  if (!any) {
    parts.push("SELECT name FROM sqlite_master WHERE type IN ('table','view');");
  }
  return parts.join("\n");
}

/** Sidecar notes filename for a database path: `/demo.db` → `demo.notes.md`. */
function notesName(dbPath: string): string {
  return `${dbPath.replace(/^\//, "").replace(/\.db$/, "")}.notes.md`;
}

/** Sidecar SQL scratchpad filename: `/demo.db` → `demo.sql`. */
function queryName(dbPath: string): string {
  return `${dbPath.replace(/^\//, "").replace(/\.db$/, "")}.sql`;
}

function demoQuery(): string {
  return `-- Semantic search, ranked by similarity
SELECT title, round(customer_notes_score, 3) AS score
FROM opportunities
WHERE customer_notes MATCH 'enterprise rollout'
ORDER BY score DESC LIMIT 10;

-- Exact vs approximate (MATCH DSL suffix). Select one line and Run selection.
SELECT title FROM opportunities WHERE customer_notes MATCH 'budget approval/exact';
SELECT title FROM opportunities WHERE customer_notes MATCH 'budget approval/hnsw:512';

-- Hybrid: relational filter + semantic match, with a JOIN
SELECT a.name, o.title, o.stage
FROM opportunities o JOIN accounts a ON a.id = o.account_id
WHERE o.stage = 'Negotiation' AND o.customer_notes MATCH 'budget approved';

-- Support tickets: meaning beats keywords
SELECT subject, resolution
FROM support_tickets
WHERE problem MATCH 'users cannot login after sso migration';

-- Knowledge base
SELECT title, category FROM knowledge_articles
WHERE body MATCH 'how to migrate enterprise customers to the cloud';

-- Multiple semantic columns in one query (AND), with per-column scores
SELECT title,
       round(summary_score, 3)        AS summary_score,
       round(customer_notes_score, 3) AS notes_score
FROM opportunities
WHERE summary MATCH 'manufacturing expansion'
  AND customer_notes MATCH 'budget approved'
ORDER BY summary_score DESC;
`;
}

function defaultNotes(dbPath: string): string {
  const name = dbPath.replace(/^\//, "").replace(/\.db$/, "");
  const date = new Date().toISOString().slice(0, 10);
  return `# ${name}

_Created ${date}. Markdown — autosaves as you type._

## Purpose

What is this database for?

## Tables

- Document tables, columns, and what each holds.

## Handy queries

\`\`\`sql
SELECT name FROM sqlite_master WHERE type IN ('table','view');
\`\`\`
`;
}

function demoNotes(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `# Demo: CRM + Knowledge Base

_Created ${date}. A realistic sqlite-anki playground (~870 rows)._

Standard SQLite tables alongside **anki virtual tables** with multiple
\`TEXT VECTOR\` columns — semantic search behaves like a native SQL capability.

| Table | Kind | Vector columns |
| --- | --- | --- |
| \`accounts\` | table | — |
| \`contacts\` | table | — |
| \`interactions\` | table | — |
| \`opportunities\` | anki | summary, customer_notes, next_steps |
| \`support_tickets\` | anki | problem, resolution, internal_notes |
| \`knowledge_articles\` | anki | abstract, body, troubleshooting |
| \`pipeline\` | view | accounts ⋈ opportunities |

The same examples are pre-loaded in the **SQL** tab — tip: select one statement
and use **Run selection**. Watch the **status bar** for embedding / search
timings on every query.

## Example queries

Semantic search, ranked by similarity:

\`\`\`sql
SELECT title, round(customer_notes_score, 3) AS score
FROM opportunities
WHERE customer_notes MATCH 'enterprise rollout'
ORDER BY score DESC LIMIT 10;
\`\`\`

Pick the strategy with the **MATCH DSL** — exact vs approximate:

\`\`\`sql
SELECT title FROM opportunities WHERE customer_notes MATCH 'budget approval/exact';
SELECT title FROM opportunities WHERE customer_notes MATCH 'budget approval/hnsw:512';
\`\`\`

Hybrid — relational filter **and** semantic match, with a JOIN:

\`\`\`sql
SELECT a.name, o.title, o.stage
FROM opportunities o JOIN accounts a ON a.id = o.account_id
WHERE o.stage = 'Negotiation' AND o.customer_notes MATCH 'budget approved';
\`\`\`

Support tickets — meaning beats keywords:

\`\`\`sql
SELECT subject, resolution
FROM support_tickets
WHERE problem MATCH 'users cannot login after sso migration';
\`\`\`

Knowledge base:

\`\`\`sql
SELECT title, category FROM knowledge_articles
WHERE body MATCH 'how to migrate enterprise customers to the cloud';
\`\`\`

Multiple semantic columns in one query — \`MATCH\` several vector columns (AND'd)
and read each column's score from its \`<col>_score\` column:

\`\`\`sql
SELECT title,
       round(summary_score, 3)        AS summary_score,
       round(customer_notes_score, 3) AS notes_score
FROM opportunities
WHERE summary MATCH 'manufacturing expansion'
  AND customer_notes MATCH 'budget approved'
ORDER BY summary_score DESC;
\`\`\`
`;
}

Comlink.expose(new AnkiWorker());
