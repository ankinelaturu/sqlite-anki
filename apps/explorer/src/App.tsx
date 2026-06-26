import { useCallback, useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  AppWindow,
  Binary,
  Boxes,
  BrainCircuit,
  Cpu,
  Database,
  DatabaseZap,
  ExternalLink,
  FileCode2,
  FileText,
  HardDrive,
  Plus,
  Sparkles,
  Table2,
  X,
} from "lucide-react";
import { ANKI_MODEL_REGISTRY } from "@sqlite-anki/wasm";
import {
  getDbWorker,
  proxy,
  resetDbWorker,
  type InitResult,
  type QueryResult,
  type TableInfo,
} from "@sqlite-anki/db-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { SchemaTree } from "@/components/SchemaTree";
import { TableView, type SearchMode } from "@/components/TableView";
import { QueryView } from "@/components/QueryView";
import { NotesView } from "@/components/NotesView";
import { StatusBar, type OpStatus } from "@/components/StatusBar";
import { cn } from "@/lib/utils";

const MODELS = Object.keys(ANKI_MODEL_REGISTRY);
const DEMO_PATH = "/demo.db";
// Binary icons emitted from the model toward the app, one every 0.4s.
const TRAVELERS = [0, 0.4, 0.8, 1.2];

interface Tab {
  key: string;
  kind: "query" | "table" | "notes";
  table?: TableInfo;
  title: string;
}

const queryTab: Tab = { key: "__query__", kind: "query", title: "SQL" };
const notesTab: Tab = { key: "__notes__", kind: "notes", title: "Notes" };
const baseTabs = (): { tabs: Tab[]; active: string } => ({
  tabs: [queryTab, notesTab],
  active: queryTab.key,
});

export function App() {
  // The Comlink remote is a *callable* proxy — never put it in React state
  // (a state setter would invoke it as an updater). Use the memoized singleton.
  const api = getDbWorker();

  const [info, setInfo] = useState<InitResult | null>(null);
  const [modelChoice, setModelChoice] = useState(MODELS[0] ?? "");
  const [loadingModel, setLoadingModel] = useState(false);

  const [databases, setDatabases] = useState<string[]>([]);
  const [activeDb, setActiveDb] = useState<string | null>(null);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [tabsByDb, setTabsByDb] = useState<Record<string, { tabs: Tab[]; active: string }>>({});

  // Search settings persist across table switches (TableView remounts per table).
  const [searchMode, setSearchMode] = useState<SearchMode>("hnsw");
  const [candidates, setCandidates] = useState(256);

  const [op, setOp] = useState<OpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newDbName, setNewDbName] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmDemo, setConfirmDemo] = useState(false);
  const [populating, setPopulating] = useState<{ done: number; total: number } | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const populateStart = useRef(0);
  const populateActive = populating !== null;

  // Tick an elapsed timer on the main thread while building the demo, so there's
  // visible motion even between the (slow) per-row progress updates.
  useEffect(() => {
    if (!populateActive) return;
    populateStart.current = performance.now();
    setElapsedMs(0);
    const iv = setInterval(() => setElapsedMs(performance.now() - populateStart.current), 200);
    return () => clearInterval(iv);
  }, [populateActive]);

  const onOp = useCallback((label: string, r: QueryResult) => {
    setOp({ label, elapsedMs: r.elapsedMs, metrics: r.metrics });
    setError(null);
  }, []);
  const onError = useCallback((m: string) => setError(m), []);

  const loadModel = async () => {
    setLoadingModel(true);
    setError(null);
    try {
      const reg = ANKI_MODEL_REGISTRY[modelChoice];
      const res = await api.init({ model: modelChoice, modelId: modelChoice, dim: reg?.dim });
      setInfo(res);
      setDatabases(await api.listDatabases());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingModel(false);
    }
  };

  const refreshSchema = useCallback(
    async (path: string) => {
      setTables(await api.schema(path));
    },
    [api],
  );

  const openDb = async (path: string) => {
    setBusy(true);
    try {
      const t = await api.openDatabase(path);
      setActiveDb(path);
      setTables(t);
      setTabsByDb((m) => (m[path] ? m : { ...m, [path]: baseTabs() }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const createDb = async () => {
    const name = newDbName.trim().replace(/[^a-zA-Z0-9_-]/g, "");
    if (!name) return;
    setDialogOpen(false);
    setNewDbName("");
    await openDb(`/${name}.db`);
    setDatabases(await api.listDatabases());
  };

  const onPopulateDemo = () => {
    if (databases.includes(DEMO_PATH)) setConfirmDemo(true);
    else void startPopulate();
  };

  const startPopulate = async () => {
    setConfirmDemo(false);
    setError(null);
    setPopulating({ done: 0, total: 0 });
    try {
      await api.populateDemo(
        DEMO_PATH,
        proxy((done, total) => setPopulating({ done, total })),
      );
      setPopulating(null);
      setDatabases(await api.listDatabases());
      await openDb(DEMO_PATH);
    } catch (e) {
      setPopulating(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const openTable = (table: TableInfo) => {
    if (!activeDb) return;
    const key = `table:${table.name}`;
    setTabsByDb((m) => {
      const cur = m[activeDb] ?? baseTabs();
      const exists = cur.tabs.some((t) => t.key === key);
      const tabs = exists
        ? cur.tabs.map((t) => (t.key === key ? { ...t, table } : t))
        : [...cur.tabs, { key, kind: "table" as const, table, title: table.name }];
      return { ...m, [activeDb]: { tabs, active: key } };
    });
  };

  const closeTab = (key: string) => {
    if (!activeDb || key === queryTab.key) return;
    setTabsByDb((m) => {
      const cur = m[activeDb];
      if (!cur) return m;
      const tabs = cur.tabs.filter((t) => t.key !== key);
      const active = cur.active === key ? queryTab.key : cur.active;
      return { ...m, [activeDb]: { tabs, active } };
    });
  };

  const setActiveTab = (key: string) => {
    if (!activeDb) return;
    setTabsByDb((m) => ({ ...m, [activeDb]: { ...m[activeDb], active: key } }));
  };

  const runQuery = useCallback(
    async (sql: string): Promise<QueryResult> => {
      if (!activeDb) throw new Error("no database open");
      const r = await api.query(activeDb, sql);
      onOp("query", r);
      void refreshSchema(activeDb); // DDL may have changed schema
      return r;
    },
    [api, activeDb, onOp, refreshSchema],
  );

  const current = activeDb ? tabsByDb[activeDb] : undefined;
  const activeTab = current?.tabs.find((t) => t.key === current.active);

  // ---- model gate ----
  if (!info) {
    const sel = ANKI_MODEL_REGISTRY[modelChoice];
    const large = (sel?.sizeMb ?? 0) > 200;
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="w-[28rem] rounded-xl border bg-card p-6 shadow-xl">
          <div className="mb-1 flex items-center gap-2 text-lg font-semibold">
            <Boxes className="h-5 w-5 text-primary" /> sqlite-anki Explorer
          </div>
          <p className="mb-5 text-sm text-muted-foreground">
            Choose an embedding model to load into the browser. It downloads once
            and powers semantic search for every database this session.
          </p>
          <Label className="mb-1.5 block">Model</Label>
          <Select value={modelChoice} onValueChange={setModelChoice} disabled={loadingModel}>
            <SelectTrigger>
              <SelectValue placeholder="Select a model" />
            </SelectTrigger>
            <SelectContent>
              {MODELS.map((m) => (
                <SelectItem key={m} value={m}>
                  {m} · {ANKI_MODEL_REGISTRY[m].dim}d
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* selected-model details */}
          {sel && (
            <div className="mt-3 rounded-lg border bg-secondary/30 p-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {sel.description}
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
                <Badge variant="secondary">{sel.dim}-dim</Badge>
                <span
                  className={cn(
                    "flex items-center gap-1 text-muted-foreground",
                    large && "text-amber-400",
                  )}
                >
                  <HardDrive className="h-3.5 w-3.5" /> {sel.sizeMb} MB
                  {large ? " · large download" : ""}
                </span>
                <a
                  href={sel.modelUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-primary hover:underline"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> HuggingFace
                </a>
              </div>
            </div>
          )}

          <Button
            className={cn("mt-5 w-full", loadingModel && "cursor-progress disabled:opacity-100")}
            onClick={() => void loadModel()}
            disabled={loadingModel}
          >
            {loadingModel ? (
              <span className="flex w-full items-center justify-between">
                <BrainCircuit className="h-4 w-4 shrink-0" />
                <span className="relative mx-3 h-4 flex-1 overflow-hidden">
                  {TRAVELERS.map((delay) => (
                    <Binary
                      key={delay}
                      className="anki-travel text-primary-foreground/85"
                      style={{ width: "11px", height: "11px", animationDelay: `${delay}s` }}
                    />
                  ))}
                </span>
                <AppWindow className="h-4 w-4 shrink-0" />
              </span>
            ) : (
              <>
                <BrainCircuit className="h-4 w-4" />
                <span>Load &amp; Start</span>
                <AppWindow className="h-4 w-4" />
              </>
            )}
          </Button>
          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col bg-background">
        {/* header */}
        <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-card px-4">
          <div className="flex items-center gap-2 font-semibold">
            <Boxes className="h-5 w-5 text-primary" /> sqlite-anki
          </div>
          <Separator orientation="vertical" className="h-6" />
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Cpu className="h-4 w-4 text-violet-400" /> {info.modelId}
          </span>
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            onClick={() => {
              resetDbWorker();
              setInfo(null);
              setActiveDb(null);
              setTables([]);
              setTabsByDb({});
            }}
          >
            change
          </Button>
        </header>

        <PanelGroup direction="horizontal" className="min-h-0 flex-1">
          {/* sidebar */}
          <Panel defaultSize={22} minSize={15} className="flex flex-col border-r bg-card">
            <div className="flex items-center justify-between px-3 py-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Database className="h-3.5 w-3.5" /> Databases
              </span>
              <div className="flex items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={onPopulateDemo}
                      disabled={!!populating}
                    >
                      <DatabaseZap className="text-primary" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs leading-relaxed">
                    Populate a sample CRM + knowledge base (~870 rows: accounts,
                    contacts, opportunities, tickets, articles). Embeds ~400 vector
                    rows in your browser — a couple of minutes.
                  </TooltipContent>
                </Tooltip>
                <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DialogTrigger asChild>
                        <Button variant="ghost" size="icon-sm">
                          <Plus />
                        </Button>
                      </DialogTrigger>
                    </TooltipTrigger>
                    <TooltipContent>New database</TooltipContent>
                  </Tooltip>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>New OPFS database</DialogTitle>
                  </DialogHeader>
                  <div className="flex items-center gap-2">
                    <Input
                      autoFocus
                      placeholder="my-database"
                      value={newDbName}
                      onChange={(e) => setNewDbName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && void createDb()}
                    />
                    <span className="text-sm text-muted-foreground">.db</span>
                  </div>
                  <DialogFooter>
                    <Button onClick={() => void createDb()}>Create</Button>
                  </DialogFooter>
                </DialogContent>
                </Dialog>
              </div>
            </div>
            <div className="scrollbar-thin flex-1 overflow-auto px-1.5">
              {databases.length === 0 && (
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  No databases yet. Create one →
                </p>
              )}
              {databases.map((path) => (
                <div key={path}>
                  <button
                    onClick={() => void openDb(path)}
                    className={cn(
                      "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-sm",
                      activeDb === path ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Database className="h-4 w-4 text-sky-400" />
                    <span className="truncate">{path.replace(/^\//, "")}</span>
                  </button>
                  {activeDb === path && (
                    <SchemaTree
                      tables={tables}
                      activeTable={activeTab?.kind === "table" ? activeTab.table?.name ?? null : null}
                      onOpenTable={openTable}
                    />
                  )}
                </div>
              ))}
            </div>
          </Panel>

          <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-primary/50" />

          {/* workspace */}
          <Panel className="flex min-w-0 flex-col">
            {!activeDb ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                <Database className="h-10 w-10 opacity-40" />
                <p className="text-sm">Select or create a database to begin.</p>
              </div>
            ) : (
              <>
                {/* tab bar */}
                <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b bg-card px-2">
                  {current?.tabs.map((t) => (
                    <div
                      key={t.key}
                      className={cn(
                        "group flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm",
                        current.active === t.key
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <button
                        className="flex items-center gap-1.5"
                        onClick={() => setActiveTab(t.key)}
                      >
                        {t.kind === "query" ? (
                          <FileCode2 className="h-4 w-4 text-emerald-400" />
                        ) : t.kind === "notes" ? (
                          <FileText className="h-4 w-4 text-amber-400" />
                        ) : t.table?.isAnki ? (
                          <Sparkles className="h-4 w-4 text-violet-400" />
                        ) : (
                          <Table2 className="h-4 w-4 text-sky-400" />
                        )}
                        {t.title}
                      </button>
                      {t.kind === "table" && (
                        <button
                          className="opacity-0 group-hover:opacity-100"
                          onClick={() => closeTab(t.key)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <div className="min-h-0 flex-1">
                  {/* The SQL editor stays mounted (hidden) so its content,
                      results and selection survive tab switches. */}
                  <div className={cn("h-full", activeTab?.kind !== "query" && "hidden")}>
                    <QueryView key={activeDb} api={api} path={activeDb} run={runQuery} />
                  </div>
                  {activeTab?.kind === "notes" && (
                    <NotesView key={`${activeDb}:notes`} api={api} path={activeDb} />
                  )}
                  {activeTab?.kind === "table" && activeTab.table && (
                    <TableView
                      key={`${activeDb}:${activeTab.table.name}`}
                      api={api}
                      path={activeDb}
                      table={activeTab.table}
                      onOp={onOp}
                      onError={onError}
                      mode={searchMode}
                      setMode={setSearchMode}
                      candidates={candidates}
                      setCandidates={setCandidates}
                    />
                  )}
                </div>
              </>
            )}
          </Panel>
        </PanelGroup>

        <StatusBar
          opfs={info.opfs}
          version={info.version}
          modelId={info.modelId}
          dim={info.dim}
          op={op}
          busy={busy || loadingModel}
          error={error}
        />
      </div>

      {/* confirm overwrite of the demo database */}
      <Dialog open={confirmDemo} onOpenChange={setConfirmDemo}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Overwrite demo database?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            A database named <code className="text-foreground">demo.db</code>{" "}
            already exists. This deletes it (and its notes &amp; SQL scratchpad) and
            rebuilds the sample CRM + knowledge base — ~870 rows, a couple of minutes
            of embedding.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDemo(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void startPopulate()}>
              Overwrite &amp; rebuild
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* demo build progress */}
      <Dialog open={!!populating}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <DatabaseZap className="h-5 w-5 text-primary" /> Building demo database…
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Generating a CRM + knowledge base and embedding{" "}
            {populating?.total || "…"} vector rows. This runs entirely in your
            browser — feel free to wait; it only happens once.
          </p>
          <div className="mt-1">
            <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="anki-progress h-full rounded-full transition-[width] duration-200"
                style={{
                  width: `${
                    populating && populating.total
                      ? Math.round((populating.done / populating.total) * 100)
                      : 4
                  }%`,
                }}
              />
            </div>
            <div className="mt-1.5 flex justify-between text-xs tabular-nums text-muted-foreground">
              <span>
                {(elapsedMs / 1000).toFixed(1)}s elapsed
                {populating && populating.done > 4
                  ? ` · ~${Math.max(
                      0,
                      Math.round(
                        ((populating.total - populating.done) *
                          (elapsedMs / populating.done)) /
                          1000,
                      ),
                    )}s left`
                  : ""}
              </span>
              <span>
                {populating?.done ?? 0} / {populating?.total ?? 0}
              </span>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
