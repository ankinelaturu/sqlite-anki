import {
  sql,
  schemaCompletionSource,
  keywordCompletionSource,
  SQLite,
  type SQLNamespace,
} from "@codemirror/lang-sql";
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import type { Extension } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
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

  const options: Completion[] = tables.map((t) => ({
    label: t.name,
    type: "type",
    detail: t.isVirtual ? "virtual table" : "table",
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
  const options: Completion[] = [{ label: "*", type: "keyword" }];

  for (const t of tables) {
    for (const c of t.columns) {
      if (!seen.has(c.name)) {
        seen.add(c.name);
        options.push({ label: c.name, type: "property", detail: t.name });
      }
      const score = `${c.name}_score`;
      if (c.isVector && !seen.has(score)) {
        seen.add(score);
        options.push({ label: score, type: "property", detail: `${t.name} · score` });
      }
    }
    if (!seen.has("rowid")) {
      seen.add("rowid");
      options.push({ label: "rowid", type: "property", detail: t.name });
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
      return schemaSource(context) as CompletionResult | null;
    }

    if (kind === "table") {
      const schemaResult = schemaSource(context) as CompletionResult | null;
      if (schemaResult?.options.length) return schemaResult;
      return tableCompletions(context, tables);
    }

    if (kind === "column") {
      const schemaResult = schemaSource(context) as CompletionResult | null;
      if (schemaResult?.options.length) return schemaResult;
      return columnCompletions(context, tables);
    }

    return keywordSource(context) as CompletionResult | null;
  };
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
    }),
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
