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
         AND name NOT LIKE '%_data'
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
SELECT title, round(similarity(customer_notes), 3) AS score
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
       round(similarity(summary), 3)        AS summary_score,
       round(similarity(customer_notes), 3) AS notes_score
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
SELECT title, round(similarity(customer_notes), 3) AS score
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
and read each column's score with \`similarity()\`:

\`\`\`sql
SELECT title,
       round(similarity(summary), 3)        AS summary_score,
       round(similarity(customer_notes), 3) AS notes_score
FROM opportunities
WHERE summary MATCH 'manufacturing expansion'
  AND customer_notes MATCH 'budget approved'
ORDER BY summary_score DESC;
\`\`\`
`;
}

Comlink.expose(new AnkiWorker());
