import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, Search, X } from "lucide-react";
import type {
  AnkiWorkerApi,
  QueryResult,
  Remote,
  SqlValue,
  TableInfo,
} from "@sqlite-anki/db-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataGrid } from "@/components/DataGrid";

interface TableViewProps {
  api: Remote<AnkiWorkerApi>;
  path: string;
  table: TableInfo;
  onOp: (label: string, result: QueryResult) => void;
  onError: (msg: string) => void;
}

const PAGE = 500;

export function TableView({ api, path, table, onOp, onError }: TableViewProps) {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);

  const vectorCols = useMemo(
    () => new Set(table.columns.filter((c) => c.isVector).map((c) => c.name)),
    [table],
  );
  const firstVector = table.columns.find((c) => c.isVector)?.name;

  const reload = useCallback(async () => {
    try {
      const r = await api.tableData(path, table.name, PAGE, 0);
      setResult(r);
      setSearching(false);
      onOp(`load ${table.name}`, r);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }, [api, path, table.name, onOp, onError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const runSearch = async () => {
    if (!firstVector || !query.trim()) return reload();
    try {
      const col = firstVector;
      const r = await api.query(
        path,
        `SELECT rowid AS rowid, *, round(similarity(${q(col)}), 4) AS _similarity
         FROM ${q(table.name)} WHERE ${q(col)} MATCH ?
         ORDER BY _similarity DESC LIMIT ?`,
        [query, PAGE],
      );
      setResult(r);
      setSearching(true);
      onOp(`search ${table.name}`, r);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  const editCommit = async (rowid: number, column: string, value: SqlValue) => {
    try {
      const r = await api.updateCell(path, table.name, rowid, column, value);
      onOp(`update ${table.name}`, r);
      await reload();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteRow = async (rowid: number) => {
    try {
      const r = await api.deleteRow(path, table.name, rowid);
      onOp(`delete ${table.name}`, r);
      await reload();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  const addRow = async () => {
    const values: Record<string, SqlValue> = {};
    for (const c of table.columns) values[c.name] = c.isVector ? "new note" : null;
    try {
      const r = await api.insertRow(path, table.name, values);
      onOp(`insert ${table.name}`, r);
      await reload();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="icon-sm" onClick={() => void reload()} title="Refresh">
          <RefreshCw />
        </Button>
        <Button variant="outline" size="sm" onClick={() => void addRow()}>
          <Plus /> Add row
        </Button>
        {firstVector && (
          <div className="relative ml-auto w-80">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              placeholder={`Semantic search · ${firstVector} MATCH …`}
              className="pl-8 pr-8"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void runSearch()}
            />
            {searching && (
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setQuery("");
                  void reload();
                }}
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <DataGrid
          columns={result?.columns ?? []}
          rows={result?.rows ?? []}
          vectorColumns={vectorCols}
          editable={!searching}
          onEditCommit={editCommit}
          onDeleteRow={deleteRow}
        />
      </div>
    </div>
  );
}

function q(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
