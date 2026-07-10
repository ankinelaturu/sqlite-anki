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
import { Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import type { AnkiWorkerApi, Remote, TableInfo } from "@/db";

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
    const el = document.createElement("span");
    el.className = `sql-completion-pill sql-completion-pill-${pill.variant}`;
    el.textContent = pill.label;
    wrap.appendChild(el);
  }
  return wrap;
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

function filterByPrefix(options: Completion[], prefix: string): Completion[] {
  if (!prefix) return options;
  const lower = prefix.toLowerCase();
  return options.filter((o) => o.label.toLowerCase().startsWith(lower));
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

  const filtered = filterByPrefix(options, word.text);
  if (!filtered.length && !context.explicit) return null;

  return { from: word.from, options: filtered.length ? filtered : options, validFor: /^\w*$/ };
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

  const filtered = filterByPrefix(options, word.text);
  if (!filtered.length && !context.explicit) return null;

  return { from: word.from, options: filtered.length ? filtered : options, validFor: /^\w*$/ };
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
      const schemaResult = schemaSource(context) as CompletionResult | null;
      if (schemaResult?.options.length) return mapResultPills(schemaResult);
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

/** Gutter markers for inline SQL errors. */
export { lintGutter };
