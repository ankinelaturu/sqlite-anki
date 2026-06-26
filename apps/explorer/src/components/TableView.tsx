import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { ChevronDown, ChevronUp, Plus, RefreshCw, Search, X } from "lucide-react";
import type {
  AnkiWorkerApi,
  QueryResult,
  Remote,
  SqlValue,
  TableInfo,
} from "@sqlite-anki/db-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DataGrid } from "@/components/DataGrid";
import { cn } from "@/lib/utils";

export type SearchMode = "hnsw" | "exact";
const CANDIDATE_STEP = 32;
const MIN_CANDIDATES = 32;

interface TableViewProps {
  api: Remote<AnkiWorkerApi>;
  path: string;
  table: TableInfo;
  onOp: (label: string, result: QueryResult) => void;
  onError: (msg: string) => void;
  // Search settings live in the parent so they persist across table switches.
  mode: SearchMode;
  setMode: Dispatch<SetStateAction<SearchMode>>;
  candidates: number;
  setCandidates: Dispatch<SetStateAction<number>>;
}

const PAGE = 500;

export function TableView({
  api,
  path,
  table,
  onOp,
  onError,
  mode,
  setMode,
  candidates,
  setCandidates,
}: TableViewProps) {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);

  const vectorColNames = useMemo(
    () => table.columns.filter((c) => c.isVector).map((c) => c.name),
    [table],
  );
  const vectorCols = useMemo(() => new Set(vectorColNames), [vectorColNames]);
  const [searchCol, setSearchCol] = useState(vectorColNames[0] ?? "");

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
    if (!searchCol || !query.trim()) return reload();
    try {
      const col = searchCol;
      // Append the MATCH DSL suffix: query/exact or query/hnsw:<candidates>.
      // (The parser reads the last "/segment", so slashes in the text are safe.)
      const suffix = mode === "exact" ? "/exact" : `/hnsw:${candidates}`;
      const r = await api.query(
        path,
        `SELECT rowid AS rowid, *, round(similarity(${q(col)}), 4) AS _similarity
         FROM ${q(table.name)} WHERE ${q(col)} MATCH ?
         ORDER BY _similarity DESC LIMIT ?`,
        [`${query}${suffix}`, PAGE],
      );
      setResult(r);
      setSearching(true);
      onOp(`search ${table.name}`, r);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  // Re-run live when the column / mode / candidate budget change mid-search, so
  // the controls feel interactive (and the status bar shows the cost delta).
  useEffect(() => {
    if (searching && query.trim()) void runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchCol, mode, candidates]);

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
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={() => void reload()}>
              <RefreshCw />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
        <Button variant="outline" size="sm" onClick={() => void addRow()}>
          <Plus /> Add row
        </Button>
        {vectorColNames.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            {/* WHERE */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default select-none font-mono text-xs font-semibold text-muted-foreground">
                  WHERE
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs leading-relaxed">
                This toolbar builds a semantic <code>WHERE … MATCH</code> query
                against the chosen vector column.
              </TooltipContent>
            </Tooltip>

            {/* column picker */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Select value={searchCol} onValueChange={setSearchCol}>
                    <SelectTrigger className="h-9 w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {vectorColNames.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </span>
              </TooltipTrigger>
              <TooltipContent>Vector column to search</TooltipContent>
            </Tooltip>

            {/* MATCH label */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default select-none font-mono text-xs font-semibold text-muted-foreground">
                  MATCH
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs leading-relaxed">
                Semantic match — embeds your text and ranks rows by cosine
                similarity to the selected column.
              </TooltipContent>
            </Tooltip>

            {/* search input */}
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="relative w-72">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    placeholder="search by meaning…"
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
                      aria-label="Clear search"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent>Press Enter to search</TooltipContent>
            </Tooltip>

            {/* DSL "/" separator */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default select-none font-mono text-sm text-muted-foreground">
                  /
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs leading-relaxed">
                DSL: <code>query/mode</code> — the search mode follows the slash.
              </TooltipContent>
            </Tooltip>

            {/* mode toggle */}
            <div className="flex h-9 items-center rounded-md border border-input p-0.5">
              {(["hnsw", "exact"] as const).map((m) => (
                <Tooltip key={m}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setMode(m)}
                      className={cn(
                        "h-7 rounded px-2 text-xs font-medium transition-colors",
                        mode === m
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {m}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs leading-relaxed">
                    {m === "hnsw"
                      ? "Approximate search via the HNSW index — fast, may miss a few matches at scale."
                      : "Exact brute-force scan — checks every row, complete but slower."}
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>

            {/* DSL ":" separator (candidates only apply to hnsw) */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "cursor-default select-none font-mono text-sm",
                    mode === "exact" ? "text-muted-foreground/40" : "text-muted-foreground",
                  )}
                >
                  :
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs leading-relaxed">
                DSL: <code>/hnsw:N</code> — the candidate budget follows the colon
                (HNSW only).
              </TooltipContent>
            </Tooltip>

            {/* candidate-budget stepper (HNSW only) */}
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className={cn(
                    "flex h-9 items-center rounded-md border border-input",
                    mode === "exact" && "opacity-40",
                  )}
                >
                  <input
                    type="number"
                    min={MIN_CANDIDATES}
                    step={CANDIDATE_STEP}
                    disabled={mode === "exact"}
                    value={candidates}
                    onChange={(e) =>
                      setCandidates(
                        Math.max(MIN_CANDIDATES, parseInt(e.target.value, 10) || MIN_CANDIDATES),
                      )
                    }
                    className="w-12 bg-transparent pl-2 text-sm tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                  <div className="flex h-full flex-col border-l border-input">
                    <button
                      disabled={mode === "exact"}
                      onClick={() => setCandidates((c) => c + CANDIDATE_STEP)}
                      className="flex flex-1 items-center justify-center px-1 text-muted-foreground hover:text-foreground disabled:pointer-events-none"
                      aria-label="More candidates"
                    >
                      <ChevronUp className="h-3 w-3" />
                    </button>
                    <button
                      disabled={mode === "exact"}
                      onClick={() => setCandidates((c) => Math.max(MIN_CANDIDATES, c - CANDIDATE_STEP))}
                      className="flex flex-1 items-center justify-center border-t border-input px-1 text-muted-foreground hover:text-foreground disabled:pointer-events-none"
                      aria-label="Fewer candidates"
                    >
                      <ChevronDown className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs leading-relaxed">
                HNSW candidate budget — how many neighbours the index examines.
                Higher = better recall, slower. Ignored in exact mode.
              </TooltipContent>
            </Tooltip>
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
