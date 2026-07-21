import { useCallback, useEffect, useRef, useState } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelGroupHandle,
} from "react-resizable-panels";
import { Layers, RefreshCw } from "lucide-react";
import { ArchitectureView, SECTIONS, type SectionId } from "@/components/ArchitectureView";
import { Button } from "@/components/ui/button";
import { getDbWorker, type Metrics } from "@/db";
import { useRuntimeInfo } from "@/lib/runtime";
import { cn } from "@/lib/utils";

/**
 * How sqlite-anki is put together — the layer stack, a query's lifecycle, the
 * shadow-table storage and the runtime model path.
 *
 * The reference content is static and renders with no database open; the
 * runtime facts and per-operation costs bind to the live wasm module once the
 * SQLite workspace has loaded one. Metrics are read on demand rather than
 * polled — they're cumulative counters, so a refresh is enough.
 */
export function ArchitectureWorkspace({
  sidebarSize,
  onSidebarResize,
  active,
}: {
  sidebarSize: number;
  onSidebarResize: (pct: number) => void;
  active: boolean;
}) {
  const panelGroup = useRef<ImperativePanelGroupHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (active) panelGroup.current?.setLayout([sidebarSize, 100 - sidebarSize]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const info = useRuntimeInfo();
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [section, setSection] = useState<SectionId>("runtime");

  /** Reads cumulative counters — only meaningful once a model is loaded. */
  const refresh = useCallback(async () => {
    if (!info) {
      setMetrics(null);
      return;
    }
    setLoading(true);
    try {
      setMetrics(await getDbWorker().metrics());
    } catch {
      setMetrics(null); // worker gone or not initialized — fall back to static
    } finally {
      setLoading(false);
    }
  }, [info]);

  // Refresh when the panel is opened, and whenever a model is loaded/cleared.
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  // `scrollIntoView` rather than `offsetTop`: offsetTop is relative to the
  // nearest *positioned* ancestor, which isn't necessarily the scroll
  // container. This also honours the sections' `scroll-mt-*`.
  const jump = (id: SectionId) => {
    setSection(id);
    document
      .getElementById(`arch-${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card px-4">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <Layers className="h-6 w-6 text-primary" /> Architecture
        </div>
        <span className="hidden text-sm text-muted-foreground sm:inline">
          How the extension is put together — and what it&apos;s doing right now
        </span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => void refresh()}
          disabled={loading || !info}
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
          <div className="flex h-10 shrink-0 items-center border-b px-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Sections
            </span>
          </div>
          <nav className="scrollbar-thin min-h-0 flex-1 overflow-auto py-2">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => jump(s.id)}
                aria-current={section === s.id}
                className={cn(
                  "relative flex w-full items-center px-3 py-1.5 text-left text-sm transition-colors",
                  section === s.id
                    ? "bg-accent/60 text-foreground"
                    : "text-muted-foreground hover:bg-accent/30 hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "absolute bottom-1 left-0 top-1 w-0.5 rounded-r bg-primary transition-opacity",
                    section === s.id ? "opacity-100" : "opacity-0",
                  )}
                />
                {s.label}
              </button>
            ))}
          </nav>
        </Panel>

        <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-primary" />

        <Panel className="flex min-w-0 flex-col">
          <div ref={scroller} className="scrollbar-thin min-h-0 flex-1 overflow-auto">
            <ArchitectureView info={info} metrics={metrics} />
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}
