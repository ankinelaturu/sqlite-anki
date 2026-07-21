import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BLOCKS,
  BLOCK_BY_ID,
  BOUNDARIES,
  DIAGRAM_H,
  DIAGRAM_W,
  JOURNEYS,
  SLABS,
  WIRES,
  centre,
  type Block,
  type BlockKind,
  type Journey,
} from "@/lib/architecture-model";
import type { Metrics } from "@/db";
import { cn } from "@/lib/utils";

/**
 * An explorable map of the sqlite-anki architecture.
 *
 * Three things make it a map rather than a picture:
 *  - **semantic zoom** — detail is revealed in tiers as you zoom in, instead of
 *    the whole drawing simply scaling,
 *  - **journeys** — the read / write / boot paths light up in order through the
 *    same static structure,
 *  - **live binding** — a played journey dwells at each block in proportion to
 *    this session's real `anki_metrics()` averages, so the embed step visibly
 *    dominates.
 *
 * SVG rather than canvas (unlike `HnswGraphView`): only ~25 nodes, but a lot of
 * text that must stay crisp at every zoom level, plus free hit-testing.
 */

/** Zoom thresholds at which more detail appears. */
const LOD_MODULES = 0.62; // slabs → modules
const LOD_DETAIL = 1.15; // modules → sublabels, hooks, boundary text

const MIN_ZOOM = 0.35;
const MAX_ZOOM = 3.2;

/** Per-family accent, as a CSS custom property defined in the wrapper below. */
const KIND_VAR: Record<BlockKind, string> = {
  app: "var(--arch-app)",
  glue: "var(--arch-glue)",
  sqlite: "var(--arch-sqlite)",
  lib: "var(--arch-lib)",
  rust: "var(--arch-rust)",
  model: "var(--arch-model)",
  store: "var(--arch-store)",
};

interface View {
  x: number;
  y: number;
  k: number;
}

/** Nominal dwell (ms) for hops with no live metric behind them. */
const NOMINAL: Record<string, number> = { fast: 90, io: 180, embed: 700, search: 220 };

export interface ArchitectureMapProps {
  metrics: Metrics | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
  journey: Journey["id"] | null;
  onJourneyChange: (j: Journey["id"] | null) => void;
  /** Reports the active hop index while playing, for the inspector. */
  onHopChange: (i: number | null) => void;
  playing: boolean;
  onPlayingChange: (p: boolean) => void;
}

export function ArchitectureMap({
  metrics,
  selected,
  onSelect,
  journey,
  onJourneyChange: _onJourneyChange,
  onHopChange,
  playing,
  onPlayingChange,
}: ArchitectureMapProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 0.62 });
  const [hover, setHover] = useState<string | null>(null);
  const [hop, setHop] = useState<number | null>(null);

  const active = useMemo(() => JOURNEYS.find((j) => j.id === journey) ?? null, [journey]);

  /* ---------------- live cost model ---------------- */

  /**
   * Real per-call averages when the session has exercised the path, else a
   * nominal value. Scaled into a watchable duration while keeping the *ratio*
   * between embed and search honest — that ratio is the whole point.
   */
  const dwellFor = useCallback(
    (cost?: string): number => {
      if (!cost) return NOMINAL.fast;
      if (cost === "embed" && metrics && metrics.embed_calls > 0) {
        return Math.min(2000, Math.max(200, (metrics.embed_ms / metrics.embed_calls) * 18));
      }
      if (cost === "search" && metrics && metrics.search_ops > 0) {
        return Math.min(2000, Math.max(60, (metrics.search_ms / metrics.search_ops) * 18));
      }
      return NOMINAL[cost] ?? NOMINAL.fast;
    },
    [metrics],
  );

  /* ---------------- journey playback ---------------- */

  useEffect(() => {
    if (!playing || !active) {
      setHop(null);
      onHopChange(null);
      return;
    }
    let i = 0;
    let timer: number;
    const step = () => {
      setHop(i);
      onHopChange(i);
      const d = dwellFor(active.hops[i]?.cost);
      timer = window.setTimeout(() => {
        i += 1;
        if (i >= active.hops.length) {
          onPlayingChange(false);
          setHop(null);
          onHopChange(null);
          return;
        }
        step();
      }, d);
    };
    step();
    return () => window.clearTimeout(timer);
  }, [playing, active, dwellFor, onHopChange, onPlayingChange]);

  /* ---------------- pan + zoom ---------------- */

  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const px = clientX - r.left;
    const py = clientY - r.top;
    setView((v) => {
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor));
      if (k === v.k) return v;
      // Keep the point under the cursor fixed.
      const scale = k / v.k;
      return { k, x: px - (px - v.x) * scale, y: py - (py - v.y) * scale };
    });
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    // Non-passive so the page doesn't scroll while zooming the map.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) }));
  };
  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  /** Fits the whole diagram in the viewport. */
  const reset = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    // The panel is display:none until its activity is selected, and the
    // resizable panel settles a frame late — a zero-ish box here would fit the
    // diagram to a few pixels. Wait for a real one.
    if (r.width < 50 || r.height < 50) return;
    const raw = Math.min(r.width / (DIAGRAM_W + 80), r.height / (DIAGRAM_H + 80));
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, raw));
    setView({ k, x: (r.width - DIAGRAM_W * k) / 2, y: (r.height - DIAGRAM_H * k) / 2 });
  }, []);

  // Fit once, as soon as the SVG genuinely has a size. Later resizes are left
  // alone so a re-fit never fights a zoom the user has chosen.
  const fitted = useRef(false);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const ro = new ResizeObserver(() => {
      if (fitted.current) return;
      const r = svg.getBoundingClientRect();
      if (r.width < 50 || r.height < 50) return;
      fitted.current = true;
      reset();
    });
    ro.observe(svg);
    return () => ro.disconnect();
  }, [reset]);

  /* ---------------- derived visual state ---------------- */

  const lodModules = view.k >= LOD_MODULES;
  const lodDetail = view.k >= LOD_DETAIL;

  /** Blocks on the active journey, and the current one. */
  const onPath = useMemo(() => {
    if (!active) return null;
    return new Set(active.hops.map((h) => h.block));
  }, [active]);
  const currentBlock = hop != null && active ? active.hops[hop]?.block : null;

  /** Which blocks this session has actually exercised. */
  const hot = useMemo(() => {
    const s = new Set<string>();
    if (!metrics) return s;
    if (metrics.embed_calls > 0) s.add("b_embed");
    if (metrics.search_ops > 0) {
      s.add("b_hnsw");
      s.add("b_vtab");
    }
    if (metrics.index_rebuilds > 0) s.add("b_graph");
    if (metrics.rows_matched > 0) s.add("b_data");
    return s;
  }, [metrics]);

  const dim = (id: string) => onPath != null && !onPath.has(id);

  /* ---------------- journey wire path ---------------- */

  const journeyPath = useMemo(() => {
    if (!active) return "";
    const pts = active.hops
      .map((h) => BLOCK_BY_ID[h.block])
      .filter(Boolean)
      .map((b) => centre(b));
    if (pts.length < 2) return "";
    return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  }, [active]);

  const pulse = currentBlock ? centre(BLOCK_BY_ID[currentBlock]!) : null;

  return (
    <div className="arch-map relative h-full w-full overflow-hidden">
      <svg
        ref={svgRef}
        className={cn("h-full w-full touch-none", dragging ? "cursor-grabbing" : "cursor-grab")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onClick={(e) => {
          if (e.target === svgRef.current) onSelect(null);
        }}
        role="img"
        aria-label="Interactive architecture map of sqlite-anki"
      >
        <defs>
          <marker id="arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
          <filter id="arch-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <pattern id="arch-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M40 0 H0 V40" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.35" />
          </pattern>
        </defs>

        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {/* grid backdrop */}
          <rect
            x={-200}
            y={-200}
            width={DIAGRAM_W + 400}
            height={DIAGRAM_H + 400}
            fill="url(#arch-grid)"
            className="text-border"
            opacity={0.5}
          />

          {/* ---- static wires ---- */}
          <g className="text-border" strokeWidth={2} fill="none">
            {WIRES.map(([a, b]) => {
              const A = BLOCK_BY_ID[a];
              const B = BLOCK_BY_ID[b];
              if (!A || !B) return null;
              const p = centre(A);
              const q = centre(B);
              const faded = dim(a) || dim(b);
              return (
                <line
                  key={`${a}-${b}`}
                  x1={p.x} y1={p.y} x2={q.x} y2={q.y}
                  stroke="currentColor"
                  opacity={faded ? 0.12 : 0.45}
                />
              );
            })}
          </g>

          {/* ---- slabs ---- */}
          {SLABS.map((s) => (
            <g key={s.id}>
              <rect
                x={s.x} y={s.y} width={s.w} height={s.h}
                rx={10}
                fill="var(--arch-slab)"
                stroke={KIND_VAR[s.kind]}
                strokeWidth={1.5}
                opacity={0.9}
              />
              <rect x={s.x} y={s.y} width={4} height={s.h} rx={2} fill={KIND_VAR[s.kind]} />
              <text
                x={s.x + 16} y={s.y + 24}
                className="fill-foreground"
                style={{ fontSize: 15, fontWeight: 600 }}
              >
                {s.title}
              </text>
              <text
                x={s.x + 16} y={s.y + 42}
                className="fill-muted-foreground"
                style={{ fontSize: 11, fontFamily: "ui-monospace, monospace" }}
              >
                {s.sub}
              </text>
            </g>
          ))}

          {/* ---- boundary labels ---- */}
          {lodDetail &&
            BOUNDARIES.map((b) => (
              <g key={b.id}>
                <line
                  x1={90} y1={b.y} x2={730} y2={b.y}
                  stroke="currentColor"
                  className="text-border"
                  strokeDasharray="4 6"
                  strokeWidth={1}
                />
                <text
                  x={96} y={b.y - 6}
                  className="fill-muted-foreground"
                  style={{ fontSize: 10, fontFamily: "ui-monospace, monospace" }}
                >
                  {b.text}
                </text>
              </g>
            ))}

          {/* ---- journey route ---- */}
          {active && (
            <path
              d={journeyPath}
              fill="none"
              stroke="var(--arch-path)"
              strokeWidth={3}
              strokeLinecap="round"
              strokeDasharray="10 8"
              opacity={0.75}
              markerEnd="url(#arch-arrow)"
              style={{ color: "var(--arch-path)" }}
            >
              <animate attributeName="stroke-dashoffset" from="36" to="0" dur="1.4s" repeatCount="indefinite" />
            </path>
          )}

          {/* ---- blocks ---- */}
          {lodModules &&
            BLOCKS.map((b) => (
              <BlockNode
                key={b.id}
                b={b}
                lodDetail={lodDetail}
                dimmed={dim(b.id)}
                isCurrent={currentBlock === b.id}
                isSelected={selected === b.id}
                isHot={hot.has(b.id)}
                onHover={setHover}
                onSelect={onSelect}
              />
            ))}

          {/* ---- travelling pulse ---- */}
          {pulse && (
            <g pointerEvents="none">
              <circle cx={pulse.x} cy={pulse.y} r={16} fill="var(--arch-path)" opacity={0.25}>
                <animate attributeName="r" values="14;26;14" dur="1s" repeatCount="indefinite" />
              </circle>
              <circle cx={pulse.x} cy={pulse.y} r={7} fill="var(--arch-path)" filter="url(#arch-glow)" />
            </g>
          )}
        </g>
      </svg>

      {/* ---- zoom controls ---- */}
      <div className="pointer-events-auto absolute bottom-3 right-3 flex flex-col gap-1 rounded-md border bg-card/95 p-1 shadow-sm backdrop-blur">
        <MapBtn label="Zoom in" onClick={() => zoomAt(0, 0, 1.25)}>+</MapBtn>
        <MapBtn label="Zoom out" onClick={() => zoomAt(0, 0, 1 / 1.25)}>−</MapBtn>
        <MapBtn label="Fit to view" onClick={reset}>⤢</MapBtn>
      </div>

      {/* ---- zoom / LOD readout ---- */}
      <div className="pointer-events-none absolute bottom-3 left-3 rounded border bg-card/90 px-2 py-1 font-mono text-[0.7rem] text-muted-foreground backdrop-blur">
        {Math.round(view.k * 100)}% ·{" "}
        {!lodModules ? "layers" : !lodDetail ? "modules" : "detail"}
        {hover && <span className="ml-2 text-foreground">{BLOCK_BY_ID[hover]?.label}</span>}
      </div>
    </div>
  );
}

function MapBtn({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className="flex h-7 w-7 items-center justify-center rounded text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

function BlockNode({
  b,
  lodDetail,
  dimmed,
  isCurrent,
  isSelected,
  isHot,
  onHover,
  onSelect,
}: {
  b: Block;
  lodDetail: boolean;
  dimmed: boolean;
  isCurrent: boolean;
  isSelected: boolean;
  isHot: boolean;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
}) {
  const accent = KIND_VAR[b.kind];
  return (
    <g
      opacity={dimmed ? 0.25 : 1}
      onPointerEnter={() => onHover(b.id)}
      onPointerLeave={() => onHover(null)}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(b.id);
      }}
      className="cursor-pointer"
      style={{ transition: "opacity 200ms" }}
    >
      {isCurrent && (
        <rect
          x={b.x - 6} y={b.y - 6} width={b.w + 12} height={b.h + 12}
          rx={12}
          fill="none"
          stroke="var(--arch-path)"
          strokeWidth={2.5}
          filter="url(#arch-glow)"
        />
      )}
      <rect
        x={b.x} y={b.y} width={b.w} height={b.h}
        rx={8}
        fill="var(--arch-block)"
        stroke={isSelected ? "var(--arch-path)" : accent}
        strokeWidth={isSelected ? 2.5 : 1.5}
      />
      {/* left accent rail */}
      <rect x={b.x} y={b.y} width={3} height={b.h} rx={1.5} fill={accent} />
      {isHot && (
        <circle cx={b.x + b.w - 10} cy={b.y + 10} r={4} fill={accent}>
          <animate attributeName="opacity" values="1;0.35;1" dur="1.8s" repeatCount="indefinite" />
        </circle>
      )}
      <text
        x={b.x + 14} y={b.y + (b.sub && lodDetail ? 24 : b.h / 2 + 4)}
        className="fill-foreground"
        style={{ fontSize: 13, fontWeight: 600, fontFamily: "ui-monospace, monospace" }}
      >
        {b.label}
      </text>
      {b.sub && lodDetail && (
        <text
          x={b.x + 14} y={b.y + 42}
          className="fill-muted-foreground"
          style={{ fontSize: 10.5 }}
        >
          {b.sub}
        </text>
      )}
    </g>
  );
}
