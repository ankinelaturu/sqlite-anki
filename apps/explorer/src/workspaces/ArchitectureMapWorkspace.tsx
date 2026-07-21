import { useCallback, useEffect, useState } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelGroupHandle,
} from "react-resizable-panels";
import { useRef } from "react";
import { Network, Pause, Play, RefreshCw } from "lucide-react";
import { ArchitectureMap } from "@/components/ArchitectureMap";
import { BLOCK_BY_ID, JOURNEYS, type Journey } from "@/lib/architecture-model";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getDbWorker, type Metrics } from "@/db";
import { useRuntimeInfo } from "@/lib/runtime";
import { cn } from "@/lib/utils";

/**
 * The Architecture Map workspace: an explorable, zoomable diagram of how
 * sqlite-anki fits together, with the read / write / boot journeys animated
 * through it at this session's real measured speeds.
 *
 * Renders fully without a database — journeys then play at nominal timings and
 * the "hot" indicators stay dark.
 */
export function ArchitectureMapWorkspace({
  sidebarSize,
  onSidebarResize,
  active,
}: {
  sidebarSize: number;
  onSidebarResize: (pct: number) => void;
  active: boolean;
}) {
  const panelGroup = useRef<ImperativePanelGroupHandle>(null);
  useEffect(() => {
    if (active) panelGroup.current?.setLayout([100 - sidebarSize, sidebarSize]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const info = useRuntimeInfo();
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [journey, setJourney] = useState<Journey["id"] | null>("read");
  const [playing, setPlaying] = useState(false);
  const [hop, setHop] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!info) {
      setMetrics(null);
      return;
    }
    setLoading(true);
    try {
      setMetrics(await getDbWorker().metrics());
    } catch {
      setMetrics(null);
    } finally {
      setLoading(false);
    }
  }, [info]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const current = JOURNEYS.find((j) => j.id === journey) ?? null;
  const hopInfo = current && hop != null ? current.hops[hop] : null;
  const block = selected ? BLOCK_BY_ID[selected] : null;
  const live = metrics != null && metrics.embed_calls > 0;

  return (
    <div
      className="flex h-full flex-col bg-background"
      /* Diagram palette. Hue per layer family, but saturation/lightness tuned
         off the theme so it reads on all five. Defined here (not in the SVG) so
         the map component stays presentation-only. */
      style={
        {
          "--arch-app": "hsl(199 89% 55%)",
          "--arch-glue": "hsl(172 66% 45%)",
          "--arch-sqlite": "hsl(45 93% 52%)",
          "--arch-lib": "hsl(24 90% 58%)",
          "--arch-rust": "hsl(14 84% 58%)",
          "--arch-model": "hsl(265 85% 68%)",
          "--arch-store": "hsl(142 60% 48%)",
          "--arch-path": "hsl(var(--primary))",
          "--arch-slab": "hsl(var(--card) / 0.55)",
          "--arch-block": "hsl(var(--card))",
        } as React.CSSProperties
      }
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card px-4">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <Network className="h-6 w-6 text-primary" /> Architecture Map
        </div>
        <span className="hidden text-sm text-muted-foreground lg:inline">
          Scroll to zoom · drag to pan · click a block
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          {JOURNEYS.map((j) => (
            <Button
              key={j.id}
              size="sm"
              variant={journey === j.id ? "default" : "outline"}
              onClick={() => {
                setJourney(journey === j.id ? null : j.id);
                setPlaying(false);
              }}
            >
              {j.label}
            </Button>
          ))}
          <Button
            size="sm"
            variant="secondary"
            disabled={!journey}
            onClick={() => setPlaying((p) => !p)}
          >
            {playing ? <Pause /> : <Play />}
            {playing ? "Stop" : "Play"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading || !info}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
          </Button>
        </div>
      </header>

      <PanelGroup
        ref={panelGroup}
        direction="horizontal"
        className="min-h-0 flex-1"
        onLayout={(s) => {
          if (active) onSidebarResize(s[1]);
        }}
      >
        <Panel className="min-w-0">
          <ArchitectureMap
            metrics={metrics}
            selected={selected}
            onSelect={setSelected}
            journey={journey}
            onJourneyChange={setJourney}
            onHopChange={setHop}
            playing={playing}
            onPlayingChange={setPlaying}
          />
        </Panel>

        <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-primary" />

        <Panel defaultSize={sidebarSize} minSize={18} className="flex flex-col border-l bg-card">
          <div className="flex h-10 shrink-0 items-center border-b px-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {block ? "Block" : "Journey"}
            </span>
          </div>

          <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-3">
            {block ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <span className="font-mono text-sm font-semibold">{block.label}</span>
                  {block.path && (
                    <span className="break-all font-mono text-[0.7rem] text-muted-foreground">
                      {block.path}
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">{block.role}</p>
                <Button variant="outline" size="sm" onClick={() => setSelected(null)}>
                  Back to journey
                </Button>
              </div>
            ) : current ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-semibold">{current.label} path</span>
                  <code className="rounded bg-accent/50 px-1.5 py-1 font-mono text-[0.7rem]">
                    {current.blurb}
                  </code>
                </div>

                <div className="flex flex-col gap-1">
                  {current.hops.map((h, i) => {
                    const b = BLOCK_BY_ID[h.block];
                    const isNow = hop === i;
                    return (
                      <button
                        key={`${h.block}-${i}`}
                        onClick={() => setSelected(h.block)}
                        className={cn(
                          "flex flex-col gap-0.5 rounded border px-2 py-1.5 text-left transition-colors",
                          isNow
                            ? "border-primary bg-primary/10"
                            : "border-transparent hover:bg-accent/40",
                        )}
                      >
                        <span className="flex items-center gap-1.5">
                          <span className="font-mono text-[0.65rem] tabular-nums text-muted-foreground">
                            {String(i + 1).padStart(2, "0")}
                          </span>
                          <span className="font-mono text-xs text-foreground">{h.hook}</span>
                          {h.cost === "embed" && (
                            <Badge variant="secondary" className="ml-auto text-[0.6rem]">
                              model
                            </Badge>
                          )}
                        </span>
                        <span className="pl-6 text-[0.7rem] text-muted-foreground">
                          {b?.label}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {hopInfo?.note && (
                  <p className="rounded border border-l-2 border-l-primary bg-background p-2 text-xs text-muted-foreground">
                    {hopInfo.note}
                  </p>
                )}

                <p className="text-[0.7rem] text-muted-foreground">
                  {live
                    ? "Playback speed is scaled from this session's real anki_metrics() averages — the embed step genuinely takes the longest."
                    : "No embeddings run yet this session, so playback uses nominal timings. Run a MATCH in the SQLite panel, then Refresh."}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Pick a journey to trace a path through the system, or click any block to inspect it.
              </p>
            )}
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}
