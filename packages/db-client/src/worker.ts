/**
 * SQLite worker: runs the WASM engine + OPFS databases off the main thread,
 * loads the embedding model, and captures per-operation metrics.
 */
// Statically import the Emscripten loader so the bundler (Vite) transforms it
// and rewrites its sibling `.wasm` / OPFS-proxy URLs — identically in dev and
// build. (Going through the package's dynamic import left those URLs unresolved
// in Vite dev → 404s.) `loadAnkiModel` does the model fetch + registration.
// @ts-expect-error untyped generated .mjs
import sqlite3InitModule from "@sqlite-anki/wasm/loader";
import { loadAnkiModel } from "@sqlite-anki/wasm";
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
    const s = await sqlite3InitModule();
    this.sqlite3 = s;
    if (model && (model.model || model.modelUrl)) {
      await loadAnkiModel(s, model as any);
    }
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

  async seedDemo(path: string): Promise<TableInfo[]> {
    await this.openDatabase(path);
    const db = this.db(path);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS articles USING anki(
      title TEXT, body TEXT VECTOR)`);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS tickets USING anki(
      subject TEXT, status TEXT, message TEXT VECTOR)`);

    if (!db.selectValue("SELECT count(*) FROM articles")) {
      const articles: [string, string][] = [
        ["Vector search in SQLite", "Find rows by meaning instead of exact keywords."],
        ["Getting started with OPFS", "The origin private file system gives browser apps durable local storage."],
        ["Embedding models explained", "A sentence transformer maps text to a vector so similar text sits nearby."],
        ["Why local-first apps", "Keeping data on the device improves privacy and works offline."],
        ["Tokenization basics", "Text is split into tokens before the model can process it."],
      ];
      for (const [title, body] of articles)
        db.exec({ sql: "INSERT INTO articles(title, body) VALUES (?,?)", bind: [title, body] });

      const tickets: [string, string, string][] = [
        ["Cannot log in", "open", "The login button does nothing after I enter my password."],
        ["Billing question", "open", "I was charged twice this month — please refund the duplicate."],
        ["Feature request", "closed", "It would be great to export my notes as markdown."],
        ["Search is slow", "open", "Semantic search takes a few seconds on my large database."],
        ["Thank you", "closed", "Just wanted to say the semantic search works really well."],
      ];
      for (const [subject, status, message] of tickets)
        db.exec({
          sql: "INSERT INTO tickets(subject, status, message) VALUES (?,?,?)",
          bind: [subject, status, message],
        });
    }

    await this.writeNotes(path, demoNotes());
    await this.writeQuery(path, demoQuery());
    return this.schema(path);
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
SELECT title, round(similarity(body), 3) AS score
FROM articles
WHERE body MATCH 'private offline storage'
ORDER BY score DESC;

-- Hybrid: relational filter + semantic match.
-- Tip: select one statement and use "Run selection".
SELECT subject, message
FROM tickets
WHERE status = 'open' AND message MATCH 'refund';
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
  return `# Sample database

_Created ${date}. A guided tour of sqlite-anki._

This database is pre-seeded with two **anki virtual tables** that have
\`TEXT VECTOR\` columns (semantically searchable):

| Table | Columns | Notes |
| --- | --- | --- |
| \`articles\` | \`title\`, \`body\` (vector) | short docs to search by meaning |
| \`tickets\` | \`subject\`, \`status\`, \`message\` (vector) | \`status\` enables hybrid filtering |

## Try it

Semantic search (open the \`articles\` tab and use the search box, or run):

\`\`\`sql
SELECT title, round(similarity(body), 3) AS score
FROM articles WHERE body MATCH 'private offline storage'
ORDER BY score DESC;
\`\`\`

Hybrid — relational filter **and** semantic match:

\`\`\`sql
SELECT subject, message FROM tickets
WHERE status = 'open' AND message MATCH 'refund';
\`\`\`

Pick the search strategy with the DSL suffix:

\`\`\`sql
SELECT subject FROM tickets WHERE message MATCH 'slow/exact';
\`\`\`

Watch the **status bar** for embedding / search / persist timings on every query.
`;
}

Comlink.expose(new AnkiWorker());
