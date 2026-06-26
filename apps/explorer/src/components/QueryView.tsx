import { useEffect, useRef, useState } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { sql, SQLite } from "@codemirror/lang-sql";
import { Check, Play, RefreshCw, TextCursorInput } from "lucide-react";
import type { AnkiWorkerApi, QueryResult, Remote } from "@sqlite-anki/db-client";
import { Button } from "@/components/ui/button";
import { DataGrid } from "@/components/DataGrid";

interface QueryViewProps {
  api: Remote<AnkiWorkerApi>;
  path: string;
  run: (sql: string) => Promise<QueryResult>;
}

type SaveState = "loading" | "saved" | "dirty" | "saving";
const STARTER_SQL = "SELECT name FROM sqlite_master WHERE type IN ('table','view');\n";

export function QueryView({ api, path, run }: QueryViewProps) {
  const [value, setValue] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [save, setSave] = useState<SaveState>("loading");
  const [hasSelection, setHasSelection] = useState(false);
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const execute = async (text: string) => {
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
  };

  const runSelection = () => {
    const view = cmRef.current?.view;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    void execute(view.state.sliceDoc(from, to));
  };

  // ⌘/Ctrl+Enter runs the selection if there is one, else the whole buffer.
  const runSmart = () => {
    const sel = cmRef.current?.view?.state.selection.main;
    if (sel && !sel.empty) runSelection();
    else void execute(value);
  };

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
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">SQL · ⌘/Ctrl+Enter to run</span>
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
          <Button
            size="sm"
            variant="outline"
            disabled={!hasSelection || running}
            onClick={runSelection}
          >
            <TextCursorInput /> Run selection
          </Button>
          <Button size="sm" disabled={running} onClick={() => void execute(value)}>
            <Play /> Run
          </Button>
        </div>
      </div>

      <div className="min-h-[8rem] shrink-0 border-b" style={{ flexBasis: "38%" }}>
        <CodeMirror
          ref={cmRef}
          value={value}
          onChange={onChange}
          onUpdate={(u) => setHasSelection(!u.state.selection.main.empty)}
          theme="dark"
          extensions={[sql({ dialect: SQLite })]}
          onKeyDownCapture={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              runSmart();
            }
          }}
          basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false }}
          height="100%"
          style={{ height: "100%" }}
        />
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
