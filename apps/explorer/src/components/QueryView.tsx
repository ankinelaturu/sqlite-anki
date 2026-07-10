import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import type { EditorView } from "@codemirror/view";
import { Check, Play, RefreshCw, TextCursorInput } from "lucide-react";
import type { AnkiWorkerApi, QueryResult, Remote, TableInfo } from "@/db";
import { Button } from "@/components/ui/button";
import { DataGrid } from "@/components/DataGrid";
import { editorColorMode, useTheme } from "@/lib/theme";
import { sqlEditorExtensions, sqlStatementGutter, sqliteLinter } from "@/lib/sqlEditor";
import { runSelectionShortcut, runSqlShortcut } from "@/lib/shortcuts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface QueryViewProps {
  api: Remote<AnkiWorkerApi>;
  path: string;
  tables: TableInfo[];
  run: (sql: string) => Promise<QueryResult>;
}

type SaveState = "loading" | "saved" | "dirty" | "saving";
const STARTER_SQL = "SELECT name FROM sqlite_master WHERE type IN ('table','view');\n";
const SELECTION_FAB_EST_W = 148;
const SELECTION_FAB_EST_H = 32;
const SELECTION_FAB_GAP = 6;

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Place the run-selection button above or below the selection end, never on top of it. */
function selectionFabPosition(
  view: EditorView,
  wrap: HTMLElement,
): { x: number; y: number } | null {
  const sel = view.state.selection.main;
  if (sel.empty) return null;

  const fromCoords = view.coordsAtPos(sel.from, -1);
  const toCoords = view.coordsAtPos(sel.to, 1);
  if (!fromCoords || !toCoords) return null;

  const endedForward = sel.head === sel.to;
  const headCoords = view.coordsAtPos(sel.head, endedForward ? 1 : -1);
  if (!headCoords) return null;

  const wrapRect = wrap.getBoundingClientRect();
  const pad = 8;

  const selRect = {
    x: Math.min(fromCoords.left, toCoords.left) - wrapRect.left,
    y: Math.min(fromCoords.top, toCoords.top) - wrapRect.top,
    w: Math.max(fromCoords.right, toCoords.right) - Math.min(fromCoords.left, toCoords.left),
    h: Math.max(fromCoords.bottom, toCoords.bottom) - Math.min(fromCoords.top, toCoords.top),
  };

  const headLineTop = headCoords.top - wrapRect.top;
  const headLineBottom = headCoords.bottom - wrapRect.top;

  const belowTop = headLineBottom + SELECTION_FAB_GAP;
  const aboveTop = headLineTop - SELECTION_FAB_GAP - SELECTION_FAB_EST_H;

  let top = endedForward ? belowTop : aboveTop;

  let left = headCoords.left - wrapRect.left;
  left = Math.min(Math.max(pad, left), wrapRect.width - SELECTION_FAB_EST_W - pad);

  const fabAt = (y: number) => ({ x: left, y, w: SELECTION_FAB_EST_W, h: SELECTION_FAB_EST_H });

  const fits = (y: number) =>
    y >= pad && y + SELECTION_FAB_EST_H <= wrapRect.height - pad && !rectsOverlap(fabAt(y), selRect);

  if (!fits(top)) {
    const alternate = endedForward ? aboveTop : belowTop;
    if (fits(alternate)) top = alternate;
    else if (fits(belowTop)) top = belowTop;
    else if (fits(aboveTop)) top = aboveTop;
    else top = Math.min(Math.max(pad, top), wrapRect.height - SELECTION_FAB_EST_H - pad);
  }

  return { x: left, y: top };
}

export function QueryView({ api, path, tables, run }: QueryViewProps) {
  const [value, setValue] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [save, setSave] = useState<SaveState>("loading");
  const [hasSelection, setHasSelection] = useState(false);
  const [selectionFab, setSelectionFab] = useState<{ x: number; y: number } | null>(null);
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const editorWrapRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const colorMode = editorColorMode(useTheme());
  const runShortcut = runSqlShortcut();
  const runSelShortcut = runSelectionShortcut();

  const execute = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || running) return;
      setRunning(true);
      setError(null);
      try {
        setResult(await run(trimmed));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setResult(null);
      } finally {
        setRunning(false);
      }
    },
    [run, running],
  );

  const extensions = useMemo(
    () => [
      ...sqlEditorExtensions(tables),
      sqliteLinter(api, path),
      ...sqlStatementGutter(api, path, (sql) => void execute(sql)),
    ],
    [tables, api, path, execute],
  );

  // Load the persisted scratchpad for this database.
  useEffect(() => {
    let alive = true;
    setSave("loading");
    void api.readQuery(path).then((text) => {
      if (!alive) return;
      setValue(text || STARTER_SQL);
      setSave("saved");
    });
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [api, path]);

  const persist = async (text: string) => {
    setSave("saving");
    await api.writeQuery(path, text);
    setSave((s) => (s === "saving" ? "saved" : s));
  };

  const onChange = (text: string) => {
    setValue(text);
    setSave("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void persist(text), 1000); // autosave
  };

  const runSelection = () => {
    const view = cmRef.current?.view;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    void execute(view.state.sliceDoc(from, to));
  };

  const syncSelectionUi = useCallback(
    (view: EditorView) => {
      const empty = view.state.selection.main.empty;
      setHasSelection(!empty);
      if (empty || running) {
        setSelectionFab(null);
        return;
      }
      const wrap = editorWrapRef.current;
      if (!wrap) return;
      setSelectionFab(selectionFabPosition(view, wrap));
    },
    [running],
  );

  useEffect(() => {
    if (running) setSelectionFab(null);
  }, [running]);

  const saveLabel =
    save === "saving"
      ? "Saving…"
      : save === "dirty"
        ? "Unsaved"
        : save === "loading"
          ? "Loading…"
          : "Saved";

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-3">
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            SQL · {runShortcut} run · {runSelShortcut} run selection
          </span>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            {save === "saved" ? (
              <Check className="h-3.5 w-3.5 text-emerald-400" />
            ) : save === "saving" || save === "loading" ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            )}
            {saveLabel}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                disabled={!hasSelection || running}
                onClick={runSelection}
              >
                <TextCursorInput /> Run selection
              </Button>
            </TooltipTrigger>
            <TooltipContent>Run selection · {runSelShortcut}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" disabled={running} onClick={() => void execute(value)}>
                <Play /> Run
              </Button>
            </TooltipTrigger>
            <TooltipContent>Run SQL · {runShortcut}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div
        ref={editorWrapRef}
        className="relative min-h-[8rem] shrink-0 border-b"
        style={{ flexBasis: "38%" }}
      >
        <CodeMirror
          ref={cmRef}
          value={value}
          onChange={onChange}
          onUpdate={(u) => {
            if (u.view) syncSelectionUi(u.view);
          }}
          theme={colorMode}
          extensions={extensions}
          onKeyDownCapture={(e) => {
            if (!(e.metaKey || e.ctrlKey) || e.key !== "Enter") return;
            e.preventDefault();
            if (e.shiftKey) runSelection();
            else void execute(value);
          }}
          indentWithTab={false}
          basicSetup={{
            lineNumbers: true,
            foldGutter: false,
            highlightActiveLine: false,
            autocompletion: false,
          }}
          height="100%"
          style={{ height: "100%" }}
        />
        {selectionFab && hasSelection && !running ? (
          <Button
            type="button"
            size="xs"
            className="absolute z-10 shadow-md"
            style={{ left: selectionFab.x, top: selectionFab.y }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={runSelection}
          >
            <Play />
            Run the Selection
          </Button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1">
        {error ? (
          <div className="m-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 font-mono text-sm text-destructive">
            {error}
          </div>
        ) : result ? (
          <div className="flex h-full flex-col">
            <div className="border-b px-3 py-1 text-xs text-muted-foreground">
              {result.rows.length} row{result.rows.length === 1 ? "" : "s"} ·{" "}
              {result.elapsedMs.toFixed(1)}ms
              {result.rowsAffected > 0 ? ` · ${result.rowsAffected} affected` : ""}
            </div>
            <div className="min-h-0 flex-1">
              <DataGrid columns={result.columns} rows={result.rows} />
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Run a query to see results.
          </div>
        )}
      </div>
    </div>
  );
}
