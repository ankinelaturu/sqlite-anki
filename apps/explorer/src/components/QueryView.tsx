import { useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { sql, SQLite } from "@codemirror/lang-sql";
import { Play } from "lucide-react";
import type { QueryResult } from "@sqlite-anki/db-client";
import { Button } from "@/components/ui/button";
import { DataGrid } from "@/components/DataGrid";

interface QueryViewProps {
  initialSql?: string;
  run: (sql: string) => Promise<QueryResult>;
}

export function QueryView({ initialSql, run }: QueryViewProps) {
  const [value, setValue] = useState(
    initialSql ?? "SELECT name FROM sqlite_master WHERE type='table';",
  );
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const execute = async () => {
    setRunning(true);
    setError(null);
    try {
      setResult(await run(value));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs text-muted-foreground">SQL · ⌘/Ctrl+Enter to run</span>
        <Button size="sm" onClick={execute} disabled={running}>
          <Play /> Run
        </Button>
      </div>
      <div className="min-h-[8rem] shrink-0 border-b" style={{ flexBasis: "38%" }}>
        <CodeMirror
          value={value}
          onChange={setValue}
          theme="dark"
          extensions={[sql({ dialect: SQLite })]}
          onKeyDownCapture={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void execute();
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
