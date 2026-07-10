import {
  sql,
  schemaCompletionSource,
  keywordCompletionSource,
  SQLite,
  type SQLNamespace,
} from "@codemirror/lang-sql";
import {
  autocompletion,
  acceptCompletion,
  completionStatus,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { indentLess, indentMore } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import type { Extension } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import {
  Prec,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutter,
  hoverTooltip,
  keymap,
} from "@codemirror/view";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import type { AnkiWorkerApi, ColumnInfo, Remote, TableInfo } from "@/db";

/** A document span covering one SQL statement (for lint / run-selection). */
export interface StatementSpan {
  from: number;
  to: number;
  text: string;
}

/** What kind of token belongs at the cursor. */
type SqlCompletionContext = "none" | "table" | "column" | "qualified" | "keyword";

/** Pill shown beside a completion label (rendered via `addToOptions`). */
interface SqlPill {
  label: string;
  variant: "table" | "anki" | "table-ref" | "score" | "text" | "int" | "real" | "blob" | "default";
}

/** Completion with optional pill metadata for the autocomplete popup. */
type SqlCompletion = Completion & { pills?: SqlPill[] };

/** Short SQL type label for a pill (drops noisy qualifiers). */
function shortTypeLabel(type: string): string {
  const upper = type.toUpperCase();
  if (upper.includes("VECTOR")) return "VECTOR";
  if (/INT/.test(upper)) return "INT";
  if (/CHAR|TEXT|CLOB/.test(upper)) return "TEXT";
  if (/REAL|FLOA|DOUB/.test(upper)) return "REAL";
  if (/BLOB/.test(upper)) return "BLOB";
  if (/NUM|DEC/.test(upper)) return "NUM";
  return type.split(/\s+/)[0]?.toUpperCase() || type;
}

function typePillVariant(type: string): SqlPill["variant"] {
  const upper = type.toUpperCase();
  if (/VECTOR/.test(upper)) return "score";
  if (/INT/.test(upper)) return "int";
  if (/CHAR|TEXT|CLOB/.test(upper)) return "text";
  if (/REAL|FLOA|DOUB|NUM|DEC/.test(upper)) return "real";
  if (/BLOB/.test(upper)) return "blob";
  return "default";
}

/** Strip default `detail` text and attach pills for schema-sourced options. */
function withPills(option: Completion): SqlCompletion {
  const existing = option as SqlCompletion;
  if (existing.pills?.length) return { ...existing, detail: undefined };

  const pills: SqlPill[] = [];
  if (option.type === "type") {
    const kind = option.detail?.toLowerCase().includes("virtual") ? "anki" : "table";
    pills.push({ label: kind === "anki" ? "anki" : "table", variant: kind });
  } else if (option.type === "property" && option.detail) {
    if (option.detail.includes("score")) {
      pills.push({ label: "score", variant: "score" });
    } else {
      pills.push({ label: shortTypeLabel(option.detail), variant: typePillVariant(option.detail) });
    }
  }

  return pills.length ? { ...option, detail: undefined, pills } : option;
}

function mapResultPills(result: CompletionResult | null): CompletionResult | null {
  if (!result) return null;
  return { ...result, options: result.options.map(withPills) };
}

function renderCompletionPills(completion: Completion): HTMLElement | null {
  const pills = (completion as SqlCompletion).pills;
  if (!pills?.length) return null;

  const wrap = document.createElement("span");
  wrap.className = "sql-completion-pills";
  for (const pill of pills) {
    appendPill(wrap, pill.label, pill.variant);
  }
  return wrap;
}

function appendPill(parent: HTMLElement, label: string, variant: SqlPill["variant"]) {
  const el = document.createElement("span");
  el.className = `sql-completion-pill sql-completion-pill-${variant}`;
  el.textContent = label;
  parent.appendChild(el);
}

function unquoteIdent(raw: string): string {
  if (
    (raw.startsWith("`") && raw.endsWith("`")) ||
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1).replace(/""/g, '"');
  }
  if (raw.startsWith("[") && raw.endsWith("]")) return raw.slice(1, -1);
  return raw;
}

const ROWID_COLUMN: ColumnInfo = {
  name: "rowid",
  type: "INTEGER",
  notnull: false,
  pk: false,
  hasDefault: false,
  isVector: false,
  description: "SQLite implicit row identifier",
};

/** Identifier (or quoted identifier) under `pos`, if any. */
function wordAt(state: EditorState, pos: number): { from: number; to: number; text: string } | null {
  const tree = syntaxTree(state);
  if (!tree.length) return null;

  const node = tree.resolveInner(pos, -1);
  for (let n: SyntaxNode | null = node; n; n = n.parent) {
    if (/Comment/.test(n.name) || n.name === "String") return null;
  }

  let ident: SyntaxNode | null = null;
  if (node.name === "Identifier" || node.name === "QuotedIdentifier") {
    ident = node;
  } else if (node.parent?.name === "Identifier" || node.parent?.name === "QuotedIdentifier") {
    ident = node.parent;
  }

  if (ident) {
    const raw = state.doc.sliceString(ident.from, ident.to);
    const text = unquoteIdent(raw);
    if (!text) return null;
    return { from: ident.from, to: ident.to, text };
  }

  const line = state.doc.lineAt(pos);
  const rel = pos - line.from;
  let start = rel;
  let end = rel;
  while (start > 0 && /[`"'\w]/.test(line.text[start - 1]!)) start--;
  while (end < line.text.length && /[`"'\w]/.test(line.text[end]!)) end++;
  if (start === end) return null;
  const text = unquoteIdent(line.text.slice(start, end));
  if (!text) return null;
  return { from: line.from + start, to: line.from + end, text };
}

/** Table name immediately before `table.` prefix at `wordFrom`, if qualified. */
function qualifiedTable(state: EditorState, wordFrom: number): string | null {
  const stmt = statementAtCursor(state.doc.toString(), wordFrom);
  const before = state.doc.sliceString(stmt.from, wordFrom);
  const m = /(?:^|[\s,(])([`"'\w]+)\.\s*$/i.exec(before);
  return m ? unquoteIdent(m[1]) : null;
}

/** Table names referenced in the current statement's FROM / JOIN clauses. */
function fromTables(state: EditorState, pos: number): string[] {
  const stmt = statementAtCursor(state.doc.toString(), pos);
  const names: string[] = [];
  for (const m of stmt.text.matchAll(/\b(?:FROM|JOIN)\s+([`"'\w]+)/gi)) {
    names.push(unquoteIdent(m[1]));
  }
  return names;
}

type HoverTarget =
  | { kind: "table"; table: TableInfo }
  | { kind: "column"; table: TableInfo; column: ColumnInfo; score?: boolean }
  | { kind: "columns"; name: string; hits: Array<{ table: TableInfo; column: ColumnInfo }> };

function columnFlags(c: ColumnInfo): string[] {
  return [
    c.pk ? "PRIMARY KEY" : "",
    c.notnull ? "NOT NULL" : "",
    c.hasDefault ? "DEFAULT" : "",
    c.isVector ? "VECTOR" : "",
  ].filter(Boolean);
}

function findVectorColumn(table: TableInfo, colName: string): ColumnInfo | undefined {
  return table.columns.find(
    (c) => c.name.toLowerCase() === colName.toLowerCase() && c.isVector,
  );
}

function resolveHoverTarget(
  state: EditorState,
  word: { from: number; text: string },
  tables: TableInfo[],
  byName: Map<string, TableInfo>,
): HoverTarget | null {
  const name = word.text;
  const lower = name.toLowerCase();
  const preferred = new Set(fromTables(state, word.from).map((t) => t.toLowerCase()));

  const qTableName = qualifiedTable(state, word.from);
  if (qTableName) {
    const table = byName.get(qTableName.toLowerCase());
    if (!table) return null;

    const scoreMatch = /^(.+)_score$/i.exec(name);
    if (scoreMatch) {
      const col = findVectorColumn(table, scoreMatch[1]!);
      return col ? { kind: "column", table, column: col, score: true } : null;
    }
    if (lower === "rowid") return { kind: "column", table, column: ROWID_COLUMN };

    const col = table.columns.find((c) => c.name.toLowerCase() === lower);
    return col ? { kind: "column", table, column: col } : null;
  }

  const scoreMatch = /^(.+)_score$/i.exec(name);
  if (scoreMatch) {
    const search = tables.filter((t) => !preferred.size || preferred.has(t.name.toLowerCase()));
    for (const table of search) {
      const col = findVectorColumn(table, scoreMatch[1]!);
      if (col) return { kind: "column", table, column: col, score: true };
    }
    return null;
  }

  const tableHit = byName.get(lower);
  const colHits: Array<{ table: TableInfo; column: ColumnInfo }> = [];
  for (const table of tables) {
    for (const col of table.columns) {
      if (col.name.toLowerCase() === lower) colHits.push({ table, column: col });
    }
    if (lower === "rowid") colHits.push({ table, column: ROWID_COLUMN });
  }

  const ctx = detectSqlContext(state, word.from);
  if (ctx === "table" && tableHit) return { kind: "table", table: tableHit };

  if (colHits.length === 1) {
    const hit = colHits[0]!;
    return { kind: "column", table: hit.table, column: hit.column };
  }

  if (colHits.length > 1) {
    const scoped = colHits.filter((h) => preferred.has(h.table.name.toLowerCase()));
    if (scoped.length === 1) {
      const hit = scoped[0]!;
      return { kind: "column", table: hit.table, column: hit.column };
    }
    return { kind: "columns", name, hits: scoped.length ? scoped : colHits };
  }

  if (tableHit) return { kind: "table", table: tableHit };
  return null;
}

function renderColumnHover(
  root: HTMLElement,
  table: TableInfo,
  column: ColumnInfo,
  score?: boolean,
): HTMLElement {
  const title = document.createElement("div");
  title.className = "sql-hover-title";
  title.textContent = score ? `${column.name}_score` : column.name;
  root.appendChild(title);

  const pills = document.createElement("div");
  pills.className = "sql-hover-pills";
  if (score) {
    appendPill(pills, "score", "score");
    appendPill(pills, "REAL", "real");
  } else if (column.type) {
    appendPill(pills, shortTypeLabel(column.type), typePillVariant(column.type));
  }
  if (column.isVector) appendPill(pills, "vector", "score");
  appendPill(pills, table.name, "table-ref");
  for (const flag of columnFlags(column)) {
    appendPill(pills, flag, flag === "VECTOR" ? "score" : "default");
  }
  root.appendChild(pills);

  if (score) {
    const desc = document.createElement("div");
    desc.className = "sql-hover-desc";
    desc.textContent = `Query-time cosine similarity for MATCH on ${column.name} (0–1).`;
    root.appendChild(desc);
  } else if (column.description) {
    const desc = document.createElement("div");
    desc.className = "sql-hover-desc";
    desc.textContent = column.description;
    root.appendChild(desc);
  }
  return root;
}

function renderHoverInfo(target: HoverTarget): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "sql-hover-info";

  if (target.kind === "table") {
    const t = target.table;
    const title = document.createElement("div");
    title.className = "sql-hover-title";
    title.textContent = t.name;
    dom.appendChild(title);

    const pills = document.createElement("div");
    pills.className = "sql-hover-pills";
    appendPill(pills, t.isAnki ? "anki" : "table", t.isAnki ? "anki" : "table");
    dom.appendChild(pills);

    if (t.description) {
      const desc = document.createElement("div");
      desc.className = "sql-hover-desc";
      desc.textContent = t.description;
      dom.appendChild(desc);
    }

    const meta = document.createElement("div");
    meta.className = "sql-hover-meta";
    meta.textContent = `${t.columns.length} column${t.columns.length === 1 ? "" : "s"}`;
    dom.appendChild(meta);
    return dom;
  }

  if (target.kind === "column") {
    return renderColumnHover(dom, target.table, target.column, target.score);
  }

  const title = document.createElement("div");
  title.className = "sql-hover-title";
  title.textContent = target.name;
  dom.appendChild(title);

  const list = document.createElement("div");
  list.className = "sql-hover-columns";
  for (const { table, column } of target.hits) {
    const row = document.createElement("div");
    row.className = "sql-hover-column-row";

    const pills = document.createElement("div");
    pills.className = "sql-hover-pills";
    appendPill(pills, table.name, "table-ref");
    if (column.type) {
      appendPill(pills, shortTypeLabel(column.type), typePillVariant(column.type));
    }
    row.appendChild(pills);

    if (column.description) {
      const desc = document.createElement("div");
      desc.className = "sql-hover-desc";
      desc.textContent = column.description;
      row.appendChild(desc);
    }
    list.appendChild(row);
  }
  dom.appendChild(list);
  return dom;
}

/** Hover tooltips on table/column identifiers in the SQL buffer. */
function sqlSchemaHover(tables: TableInfo[]): Extension {
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  return hoverTooltip(
    (view, pos, side) => {
      const word = wordAt(view.state, pos);
      if (!word) return null;
      if (pos < word.from || pos > word.to) return null;
      if (pos === word.from && side < 0) return null;
      if (pos === word.to && side > 0) return null;

      const target = resolveHoverTarget(view.state, word, tables, byName);
      if (!target) return null;

      return {
        pos: word.from,
        end: word.to,
        above: true,
        create() {
          return { dom: renderHoverInfo(target) };
        },
      };
    },
    { hoverTime: 400 },
  );
}

/** Builds a CodeMirror SQL namespace from the open database schema. */
export function sqlSchemaFromTables(tables: TableInfo[]): SQLNamespace {
  const schema: Record<string, SQLNamespace> = {};

  for (const t of tables) {
    const cols = t.columns.flatMap((c) => {
      const items: Array<{ label: string; type: string; detail?: string }> = [
        { label: c.name, type: "property", detail: c.type || undefined },
      ];
      if (c.isVector) {
        items.push({
          label: `${c.name}_score`,
          type: "property",
          detail: "REAL (query-time score)",
        });
      }
      return items;
    });
    cols.push({ label: "rowid", type: "property", detail: "INTEGER" });
    schema[t.name] = cols;
  }

  return schema;
}

/** Text from the start of the current statement up to `pos`. */
function statementPrefix(state: EditorState, pos: number): string {
  const stmt = statementAtCursor(state.doc.toString(), pos);
  return stmt.text.slice(0, pos - stmt.from);
}

/** Classify what should be completed at the cursor (tables vs columns vs keywords). */
function detectSqlContext(state: EditorState, pos: number): SqlCompletionContext {
  const tree = syntaxTree(state).resolveInner(pos, -1);

  let node: SyntaxNode | null = tree;
  while (node) {
    if (/Comment/.test(node.name)) return "none";
    if (node.name === "String") return "none";
    node = node.parent;
  }

  if (tree.name === ".") return "qualified";
  if (state.doc.sliceString(pos - 1, pos) === ".") return "qualified";

  const text = statementPrefix(state, pos);

  // Table/view name: right after FROM, JOIN, UPDATE, INTO, or TABLE.
  if (/\b(FROM|JOIN|UPDATE|INTO|TABLE)\s+[`"'\w[\].]*$/i.test(text)) return "table";

  // SELECT list: after SELECT, before FROM.
  const fromIdx = text.search(/\bFROM\b/i);
  const selectIdx = text.search(/\bSELECT\b/i);
  if (selectIdx >= 0 && (fromIdx < 0 || text.length <= fromIdx + 4)) {
    if (text.length > selectIdx + 6) return "column";
  }

  // Filter / sort / group clauses — column names.
  if (
    /\b(WHERE|ON|HAVING|BY|SET|AND|OR|USING)\s+[`"'\w[\].]*$/i.test(text) ||
    /,\s*[`"'\w[\].]*$/i.test(text)
  ) {
    return "column";
  }

  return "keyword";
}

function matchWord(context: CompletionContext): { from: number; text: string } | null {
  const word = context.matchBefore(/[`"'\w[\]]*/);
  if (!word && !context.explicit) return null;
  return { from: word?.from ?? context.pos, text: word?.text ?? "" };
}

function tableCompletions(
  context: CompletionContext,
  tables: TableInfo[],
): CompletionResult | null {
  const word = matchWord(context);
  if (!word) return null;

  const options: SqlCompletion[] = tables.map((t) => ({
    label: t.name,
    type: "type",
    pills: [{ label: t.isAnki ? "anki" : "table", variant: t.isAnki ? "anki" : "table" }],
  }));

  return { from: word.from, options, validFor: /^\w*$/ };
}

function columnCompletions(
  context: CompletionContext,
  tables: TableInfo[],
): CompletionResult | null {
  const word = matchWord(context);
  if (!word) return null;

  const seen = new Set<string>();
  const options: SqlCompletion[] = [{ label: "*", type: "keyword" }];

  for (const t of tables) {
    for (const c of t.columns) {
      if (!seen.has(c.name)) {
        seen.add(c.name);
        const pills: SqlPill[] = [{ label: t.name, variant: "table-ref" }];
        if (c.type) {
          pills.unshift({ label: shortTypeLabel(c.type), variant: typePillVariant(c.type) });
        }
        if (c.isVector) pills.push({ label: "vector", variant: "score" });
        options.push({ label: c.name, type: "property", pills });
      }
      const score = `${c.name}_score`;
      if (c.isVector && !seen.has(score)) {
        seen.add(score);
        options.push({
          label: score,
          type: "property",
          pills: [
            { label: "score", variant: "score" },
            { label: t.name, variant: "table-ref" },
          ],
        });
      }
    }
    if (!seen.has("rowid")) {
      seen.add("rowid");
      options.push({
        label: "rowid",
        type: "property",
        pills: [
          { label: "INT", variant: "int" },
          { label: t.name, variant: "table-ref" },
        ],
      });
    }
  }

  return { from: word.from, options, validFor: /^\w*$/ };
}

/** One completion source: schema in qualified positions, tables/columns/keywords by context. */
function contextualSqlCompletion(tables: TableInfo[], schema: SQLNamespace) {
  const config = { dialect: SQLite, schema, upperCaseKeywords: true };
  const schemaSource = schemaCompletionSource(config);
  const keywordSource = keywordCompletionSource(SQLite, true);

  return (context: CompletionContext): CompletionResult | null => {
    const kind = detectSqlContext(context.state, context.pos);

    if (kind === "none") return null;

    if (kind === "qualified") {
      return mapResultPills(schemaSource(context) as CompletionResult | null);
    }

    if (kind === "table") {
      const schemaResult = schemaSource(context) as CompletionResult | null;
      if (schemaResult?.options.length) return mapResultPills(schemaResult);
      return tableCompletions(context, tables);
    }

    if (kind === "column") {
      // Top-level schema completion lists tables, not columns — using it here
      // (especially on Ctrl+Space mid-identifier) wrongly suggests table names.
      return columnCompletions(context, tables);
    }

    return mapResultPills(keywordSource(context) as CompletionResult | null);
  };
}

/**
 * VS Code-style Tab: accept the highlighted completion when the menu is open,
 * otherwise indent. Enter still accepts via the default `completionKeymap`.
 */
function tabAcceptOrIndent(): Extension {
  return Prec.highest(
    keymap.of([
      {
        key: "Tab",
        run(view) {
          if (completionStatus(view.state)) return acceptCompletion(view);
          return indentMore(view);
        },
        shift: indentLess,
      },
    ]),
  );
}

/**
 * SQLite highlighting plus context-filtered completion (no keyword dump after
 * `FROM`, etc.). `sql()` provides the language + highlighting; `override`
 * replaces its built-in completion sources with our context-aware one.
 */
export function sqlEditorExtensions(tables: TableInfo[]): Extension[] {
  const schema = sqlSchemaFromTables(tables);
  return [
    sql({ dialect: SQLite }),
    autocompletion({
      override: [contextualSqlCompletion(tables, schema)],
      activateOnTyping: true,
      addToOptions: [
        {
          position: 60,
          render: renderCompletionPills,
        },
      ],
      optionClass: (c) => ((c as SqlCompletion).pills?.length ? "sql-completion-has-pills" : ""),
    }),
    tabAcceptOrIndent(),
    sqlSchemaHover(tables),
  ];
}

/**
 * Splits a SQL buffer into statement spans. Semicolons inside strings and
 * comments do not start a new statement.
 */
export function splitSqlStatements(doc: string): StatementSpan[] {
  const out: StatementSpan[] = [];
  let start = 0;
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  const flush = (end: number) => {
    const text = doc.slice(start, end);
    if (text.trim()) out.push({ from: start, to: end, text });
    start = end;
  };

  while (i < doc.length) {
    const ch = doc[i];
    const next = doc[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (!inSingle && !inDouble && !inBacktick) {
      if (ch === "-" && next === "-") {
        inLineComment = true;
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        i += 2;
        continue;
      }
      if (ch === ";") {
        flush(i);
        start = i + 1;
        i++;
        continue;
      }
    }

    if (!inDouble && !inBacktick && ch === "'" && !inLineComment) {
      if (inSingle && next === "'") {
        i += 2;
        continue;
      }
      inSingle = !inSingle;
      i++;
      continue;
    }
    if (!inSingle && !inBacktick && ch === '"' && !inLineComment) {
      if (inDouble && next === '"') {
        i += 2;
        continue;
      }
      inDouble = !inDouble;
      i++;
      continue;
    }
    if (!inSingle && !inDouble && ch === "`") {
      inBacktick = !inBacktick;
      i++;
      continue;
    }

    i++;
  }

  if (start < doc.length) flush(doc.length);
  return out;
}

/** Returns the SQL statement containing `pos`, or the whole document. */
export function statementAtCursor(doc: string, pos: number): StatementSpan {
  const statements = splitSqlStatements(doc);
  for (const s of statements) {
    if (pos >= s.from && pos <= s.to) return s;
  }
  if (statements.length > 0) {
    const last = statements[statements.length - 1]!;
    if (pos > last.to) return last;
  }
  return { from: 0, to: doc.length, text: doc };
}

/** Lint extension: `prepare()` on the worker for the statement at the cursor. */
export function sqliteLinter(api: Remote<AnkiWorkerApi>, path: string) {
  return linter(
    async (view): Promise<Diagnostic[]> => {
      const pos = view.state.selection.main.head;
      const stmt = statementAtCursor(view.state.doc.toString(), pos);
      if (!stmt.text.trim()) return [];

      try {
        const issues = await api.checkSql(path, stmt.text);
        return issues.map((d) => ({
          from: stmt.from + d.from,
          to: stmt.from + d.to,
          severity: "error" as const,
          message: d.message,
        }));
      } catch {
        return [];
      }
    },
    { delay: 400 },
  );
}

/** Per-statement validity cached for the statement gutter (index-aligned with `splitSqlStatements`). */
interface StmtValidity {
  from: number;
  to: number;
  valid: boolean;
  error?: string;
}

const setStmtValidity = StateEffect.define<StmtValidity[]>();
const setHoveredStmt = StateEffect.define<{ from: number; to: number } | null>();

const stmtValidityField = StateField.define<StmtValidity[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setStmtValidity)) return e.value;
    }
    return value;
  },
});

function stmtHighlightRange(state: EditorState, stmt: StatementSpan): { from: number; to: number } {
  const from = firstNonWhitespacePos(state, stmt);
  let to = stmt.to;
  while (to > from && /\s/.test(state.doc.sliceString(to - 1, to))) to--;
  return { from, to };
}

function dispatchHoveredStmt(view: EditorView, range: { from: number; to: number } | null) {
  view.dispatch({
    effects: setHoveredStmt.of(range),
    annotations: Transaction.addToHistory.of(false),
  });
}

const hoveredStmtDeco = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setHoveredStmt)) continue;
      if (!e.value) return Decoration.none;
      return Decoration.set([
        Decoration.mark({ class: "sql-stmt-hover-mark" }).range(e.value.from, e.value.to),
      ]);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const PLAY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><polygon points="8,5 19,12 8,19"/></svg>';
const ERROR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';

const setStmtGutterRun = StateEffect.define<(sql: string) => void>();

const stmtGutterRunField = StateField.define<(sql: string) => void>({
  create: () => () => {},
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setStmtGutterRun)) return e.value;
    }
    return value;
  },
});

function hideGutterTip() {
  document.querySelectorAll(".sql-gutter-tip").forEach((el) => el.remove());
}

function showGutterTip(anchor: HTMLElement, text: string, view: EditorView, stmtFrom: number) {
  hideGutterTip();
  const tip = document.createElement("div");
  tip.className = "cm-tooltip sql-gutter-tip";
  tip.textContent = text;
  document.body.appendChild(tip);
  const coords = view.coordsAtPos(stmtFrom, -1);
  if (coords) {
    tip.style.left = `${coords.left}px`;
    tip.style.top = `${coords.top - 8}px`;
    tip.style.transform = "translateY(-100%)";
  } else {
    const rect = anchor.getBoundingClientRect();
    tip.style.left = `${rect.left}px`;
    tip.style.top = `${rect.top - 8}px`;
    tip.style.transform = "translateY(-100%)";
  }
}

function bindGutterBtnHover(
  btn: HTMLElement,
  view: EditorView,
  stmt: StatementSpan,
  tip: string,
  gutterPos: number,
) {
  const show = () => {
    dispatchHoveredStmt(view, stmtHighlightRange(view.state, stmt));
    showGutterTip(btn, tip, view, gutterPos);
  };
  const hide = () => {
    dispatchHoveredStmt(view, null);
    hideGutterTip();
  };
  btn.addEventListener("mouseenter", show);
  btn.addEventListener("mouseleave", hide);
  btn.addEventListener("pointerleave", hide);
  btn.addEventListener("mousedown", hide);
}

class StmtGutterMarker extends GutterMarker {
  constructor(
    readonly kind: "run" | "error",
    readonly stmtFrom: number,
    readonly stmtTo: number,
    readonly gutterPos: number,
    readonly stmtText: string,
    readonly tip: string,
  ) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return (
      other instanceof StmtGutterMarker &&
      other.kind === this.kind &&
      other.stmtFrom === this.stmtFrom &&
      other.stmtTo === this.stmtTo &&
      other.gutterPos === this.gutterPos &&
      other.tip === this.tip
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `sql-stmt-gutter-btn sql-stmt-gutter-${this.kind}`;
    btn.innerHTML = this.kind === "run" ? PLAY_SVG : ERROR_SVG;

    const stmt: StatementSpan = { from: this.stmtFrom, to: this.stmtTo, text: this.stmtText };
    bindGutterBtnHover(btn, view, stmt, this.tip, this.gutterPos);

    if (this.kind === "run") {
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        view.state.field(stmtGutterRunField)(this.stmtText);
      });
    }

    return btn;
  }
}

function firstNonWhitespacePos(state: EditorState, stmt: StatementSpan): number {
  const text = state.doc.sliceString(stmt.from, stmt.to);
  const m = /\S/.exec(text);
  return m ? stmt.from + m.index! : stmt.from;
}

/** Line start for the gutter icon — first line of statement content, not trailing `;` newline. */
function statementGutterLine(state: EditorState, stmt: StatementSpan): number {
  return state.doc.lineAt(firstNonWhitespacePos(state, stmt)).from;
}

function buildStmtGutterMarkers(state: EditorState): RangeSet<GutterMarker> {
  const validity = state.field(stmtValidityField);
  const stmts = splitSqlStatements(state.doc.toString());
  const builder = new RangeSetBuilder<GutterMarker>();

  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i]!;
    const status = validity[i];
    if (!status || status.from !== stmt.from || status.to !== stmt.to) continue;

    const tip = status.valid ? "Run this statement" : status.error || "SQL error";
    const gutterPos = firstNonWhitespacePos(state, stmt);
    const marker = new StmtGutterMarker(
      status.valid ? "run" : "error",
      stmt.from,
      stmt.to,
      gutterPos,
      stmt.text,
      tip,
    );
    const lineFrom = statementGutterLine(state, stmt);
    builder.add(lineFrom, lineFrom, marker);
  }

  return builder.finish();
}

const stmtGutterMarkersField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(markers, tr) {
    if (tr.effects.some((e) => e.is(setStmtValidity))) {
      hideGutterTip();
      return buildStmtGutterMarkers(tr.state);
    }
    if (tr.docChanged) {
      hideGutterTip();
      return markers.map(tr.changes);
    }
    return markers;
  },
  provide: (field) =>
    gutter({
      class: "cm-sql-stmt-gutter",
      markers: (view) => view.state.field(field),
    }),
});

function createStmtValidatePlugin(api: Remote<AnkiWorkerApi>, path: string) {
  return ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | null = null;

      constructor(readonly view: EditorView) {
        this.schedule();
      }

      update(u: { docChanged: boolean }) {
        if (u.docChanged) this.schedule();
      }

      schedule() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.validate(), 400);
      }

      async validate() {
        const doc = this.view.state.doc.toString();
        const stmts = splitSqlStatements(doc);
        const results = await Promise.all(
          stmts.map(async (stmt) => {
            try {
              const issues = await api.checkSql(path, stmt.text);
              return {
                from: stmt.from,
                to: stmt.to,
                valid: issues.length === 0,
                error: issues[0]?.message,
              } satisfies StmtValidity;
            } catch {
              return {
                from: stmt.from,
                to: stmt.to,
                valid: false,
                error: "SQL error",
              } satisfies StmtValidity;
            }
          }),
        );
        this.view.dispatch({ effects: setStmtValidity.of(results) });
      }

      destroy() {
        if (this.timer) clearTimeout(this.timer);
      }
    },
  );
}

function createRunHandlerPlugin(onRun: (sql: string) => void) {
  return ViewPlugin.fromClass(
    class {
      constructor(view: EditorView) {
        view.dispatch({ effects: setStmtGutterRun.of(onRun) });
      }
    },
  );
}

/**
 * Gutter run/error icons per SQL statement. Valid statements get a run button;
 * invalid ones show an error icon with the prepare-time message on hover.
 */
export function sqlStatementGutter(
  api: Remote<AnkiWorkerApi>,
  path: string,
  onRun: (sql: string) => void,
): Extension[] {
  return [
    stmtValidityField,
    hoveredStmtDeco,
    stmtGutterRunField,
    stmtGutterMarkersField,
    createStmtValidatePlugin(api, path),
    createRunHandlerPlugin(onRun),
  ];
}

/** Gutter markers for inline SQL errors. */
export { lintGutter };
