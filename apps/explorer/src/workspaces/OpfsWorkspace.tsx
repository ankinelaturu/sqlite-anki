import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelGroupHandle,
} from "react-resizable-panels";
import CodeMirror from "@uiw/react-codemirror";
import { sql } from "@codemirror/lang-sql";
import {
  Download,
  File,
  FileCode2,
  FilePlus,
  FileText,
  FileX2,
  FolderPlus,
  HardDrive,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import { OpfsTree } from "@/components/OpfsTree";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  MarkdownEditor,
  WritePreviewToggle,
  type MarkdownMode,
} from "@/components/MarkdownEditor";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/theme";
import type { WorkspaceProps } from "@/App";
import {
  downloadFile,
  fileExt,
  fmtBytes,
  isTextFile,
  readText,
  storageEstimate,
  walkOpfs,
  writeText,
  type OpfsNode,
} from "@/lib/opfs";

function tabIcon(name: string) {
  const e = fileExt(name);
  if (e === "sql") return <FileCode2 className="h-4 w-4 shrink-0 text-emerald-400" />;
  if (e === "md") return <FileText className="h-4 w-4 shrink-0 text-amber-400" />;
  if (isTextFile(name)) return <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />;
  return <File className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

/**
 * Phase 2: a VSCode-style OPFS browser — recursive file tree on the left, a
 * tabbed editor on the right (one tab per open file, each with a file header for
 * file-specific actions), plus an OPFS storage status bar.
 */
export function OpfsWorkspace({ sidebarSize, onSidebarResize, active }: WorkspaceProps) {
  const panelGroup = useRef<ImperativePanelGroupHandle>(null);
  useEffect(() => {
    if (active) panelGroup.current?.setLayout([sidebarSize, 100 - sidebarSize]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const [tree, setTree] = useState<OpfsNode[]>([]);
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [open, setOpen] = useState<OpfsNode[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState<Record<string, string>>({});
  const [original, setOriginal] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<Record<string, MarkdownMode>>({}); // md write/preview per file
  const [saving, setSaving] = useState(false);

  const colorMode = useTheme() === "light" ? "light" : "dark";
  const activeNode = open.find((n) => n.path === activePath) ?? null;
  const activeIsText = activeNode != null && isTextFile(activeNode.name);
  const dirty = activeNode != null && activeIsText && content[activeNode.path] !== original[activeNode.path];

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [t, u] = await Promise.all([walkOpfs(), storageEstimate()]);
      setTree(t);
      setUsage(u);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openFile = async (node: OpfsNode) => {
    if (node.kind !== "file") return;
    setActivePath(node.path);
    if (open.some((n) => n.path === node.path)) return; // already open → just focus
    setOpen((o) => [...o, node]);
    if (isTextFile(node.name)) {
      try {
        const text = await readText(node.handle as FileSystemFileHandle);
        setContent((c) => ({ ...c, [node.path]: text }));
        setOriginal((c) => ({ ...c, [node.path]: text }));
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    }
  };

  const closeTab = (path: string) => {
    const idx = open.findIndex((n) => n.path === path);
    const next = open.filter((n) => n.path !== path);
    setOpen(next);
    if (activePath === path) {
      setActivePath((next[idx] ?? next[idx - 1])?.path ?? null);
    }
    setContent(({ [path]: _c, ...rest }) => rest);
    setOriginal(({ [path]: _o, ...rest }) => rest);
    setMode(({ [path]: _m, ...rest }) => rest);
  };

  const save = async () => {
    if (!activeNode || !dirty) return;
    setSaving(true);
    try {
      await writeText(activeNode.handle as FileSystemFileHandle, content[activeNode.path]);
      setOriginal((c) => ({ ...c, [activeNode.path]: content[activeNode.path] }));
      void refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const download = async (node: OpfsNode | null) => {
    if (!node || node.kind !== "file") return;
    try {
      await downloadFile(node.handle as FileSystemFileHandle, node.name);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const ext = activeNode ? fileExt(activeNode.name) : "";
  const isMd = ext === "md";
  const extensions = useMemo(() => (ext === "sql" ? [sql()] : []), [ext]);

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card px-4">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <HardDrive className="h-6 w-6 text-primary" /> OPFS
        </div>
        <span className="text-sm text-muted-foreground">
          Origin Private File System — what the explorer persists
        </span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} /> Refresh
        </Button>
      </header>

      <PanelGroup
        ref={panelGroup}
        direction="horizontal"
        className="min-h-0 flex-1"
        onLayout={(s) => {
          if (active) onSidebarResize(s[0]);
        }}
      >
        <Panel defaultSize={sidebarSize} minSize={15} className="flex flex-col border-r bg-card">
          <div className="flex h-10 shrink-0 items-center justify-between border-b px-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Files
            </span>
            {/* TODO(phase 3): wire up create file/folder — placeholders for now */}
            <div className="flex items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="New file">
                    <FilePlus />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>New file</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="New folder">
                    <FolderPlus />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>New folder</TooltipContent>
              </Tooltip>
            </div>
          </div>
          <div className="scrollbar-thin min-h-0 flex-1 overflow-auto py-2">
            {err && <p className="px-3 py-2 text-xs text-destructive">{err}</p>}
            <OpfsTree nodes={tree} selectedPath={activePath} onSelect={openFile} />
          </div>
        </Panel>

        <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-primary" />

        <Panel className="flex min-w-0 flex-col">
          {open.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a file to open it.
            </div>
          ) : (
            <>
              {/* tab strip (same style as the SQLite workspace) */}
              <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b bg-card px-2">
                {open.map((n) => (
                  <div
                    key={n.path}
                    className={cnTab(activePath === n.path)}
                  >
                    <button
                      className="flex items-center gap-1.5"
                      onClick={() => setActivePath(n.path)}
                    >
                      {tabIcon(n.name)}
                      {n.name}
                    </button>
                    <button
                      className="opacity-0 group-hover:opacity-100"
                      onClick={() => closeTab(n.path)}
                      aria-label={`Close ${n.name}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>

              {/* per-file header: path + file-specific actions (room for more later) */}
              {activeNode && (
                <div className="flex h-12 shrink-0 items-center gap-2 border-b bg-card px-3">
                  <span className="truncate text-sm text-muted-foreground">{activeNode.path}</span>
                  {isMd && (
                    <WritePreviewToggle
                      mode={mode[activeNode.path] ?? "write"}
                      onChange={(m) => setMode((c) => ({ ...c, [activeNode.path]: m }))}
                    />
                  )}
                  <div className="ml-auto flex shrink-0 items-center gap-1.5">
                    {dirty && <span className="text-xs text-amber-400">● unsaved</span>}
                    <Button variant="ghost" size="icon-sm" onClick={() => void download(activeNode)}>
                      <Download />
                    </Button>
                    {activeIsText && (
                      <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
                        <Save /> Save
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {/* editor / binary view */}
              <div className="min-h-0 flex-1">
                {activeNode && isMd ? (
                  <MarkdownEditor
                    value={content[activeNode.path] ?? ""}
                    onChange={(v) => setContent((c) => ({ ...c, [activeNode.path]: v }))}
                    mode={mode[activeNode.path] ?? "write"}
                  />
                ) : activeNode && activeIsText ? (
                  <CodeMirror
                    value={content[activeNode.path] ?? ""}
                    onChange={(v) => setContent((c) => ({ ...c, [activeNode.path]: v }))}
                    theme={colorMode}
                    extensions={extensions}
                    height="100%"
                    style={{ height: "100%" }}
                    basicSetup={{ foldGutter: false, highlightActiveLine: false }}
                  />
                ) : activeNode ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                    <FileX2 className="h-10 w-10" />
                    <p className="text-sm">
                      Binary file · {fmtBytes(activeNode.size)} · not editable
                    </p>
                  </div>
                ) : null}
              </div>
            </>
          )}
        </Panel>
      </PanelGroup>

      <footer className="flex h-7 shrink-0 items-center gap-3 border-t bg-card px-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <HardDrive className="h-3.5 w-3.5" />
          {usage
            ? `${fmtBytes(usage.usage)} used${usage.quota ? ` of ${fmtBytes(usage.quota)}` : ""}`
            : "—"}
        </span>
        {activeNode && (
          <span className="ml-auto truncate">
            {activeNode.path} · {fmtBytes(activeNode.size)}
          </span>
        )}
      </footer>
    </div>
  );
}

function cnTab(activeTab: boolean): string {
  return [
    "group flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm",
    activeTab ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
  ].join(" ");
}
