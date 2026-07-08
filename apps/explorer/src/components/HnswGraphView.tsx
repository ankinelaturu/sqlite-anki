import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getDbWorker } from "@/db";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** One node of the exported HNSW graph (`anki_hnsw_json`). */
interface GraphNode {
  node: number;
  rowid: number;
  level: number;
}
/** One undirected edge, tagged with the layer it appears on. */
interface GraphEdge {
  a: number;
  b: number;
  layer: number;
}
interface Graph {
  entry: number | null;
  max_level: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface HnswGraphViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  path: string | null;
  table: string;
  col: string;
}

/** Quotes a SQL identifier (doubling embedded quotes). */
const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Resolves a shadcn CSS custom property (space-separated HSL) to an `hsl()` string. */
function cssVar(el: HTMLElement | null, name: string, fallback: string): string {
  if (!el) return fallback;
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v ? `hsl(${v})` : fallback;
}

const ENTRY = "#a78bfa"; // violet-400 — matches the anki accent in the schema tree
const UPPER = "#60a5fa"; // blue-400 — upper-layer "express lane" edges

export function HnswGraphView({ open, onOpenChange, path, table, col }: HnswGraphViewProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [labels, setLabels] = useState<Map<number, string>>(new Map());
  const [minLayer, setMinLayer] = useState(0);
  const [hover, setHover] = useState<GraphNode | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Node positions keyed by node index (persist across redraws within a layout run).
  const posRef = useRef<Map<number, { x: number; y: number; vx: number; vy: number }>>(new Map());
  const rafRef = useRef<number | null>(null);
  // Hovered node in a ref so `draw` can read it without changing identity (which
  // would otherwise restart the layout simulation on every mouse move).
  const hoverRef = useRef<GraphNode | null>(null);

  // Fetch the persisted graph + a rowid→label map whenever the target changes.
  useEffect(() => {
    if (!open || !path) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setGraph(null);
    setHover(null);
    hoverRef.current = null;
    posRef.current.clear(); // fresh layout for a new target
    (async () => {
      try {
        const api = getDbWorker();
        const gRes = await api.query(path, `SELECT anki_hnsw_json(?, ?) AS g`, [table, col]);
        const raw = gRes.rows[0]?.g as string | null | undefined;
        if (cancelled) return;
        if (!raw) {
          setGraph(null);
          setLoading(false);
          return;
        }
        const parsed = JSON.parse(raw) as Graph;
        // Labels from the PUBLIC vtab (graph rowid == vtab rowid): one scan.
        const lRes = await api.query(
          path,
          `SELECT rowid AS id, ${quoteIdent(col)} AS label FROM ${quoteIdent(table)}`,
        );
        if (cancelled) return;
        const map = new Map<number, string>();
        for (const r of lRes.rows) map.set(Number(r.id), String(r.label ?? ""));
        setLabels(map);
        setGraph(parsed);
        // Default to upper layers when layer 0 would be a dense hairball.
        setMinLayer(parsed.nodes.length > 150 && parsed.max_level >= 1 ? 1 : 0);
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, path, table, col]);

  // The visible subgraph for the chosen layer scope.
  const view = useMemo(() => {
    if (!graph) return null;
    const nodes = graph.nodes.filter((n) => n.level >= minLayer);
    const active = new Set(nodes.map((n) => n.node));
    const edges = graph.edges.filter(
      (e) => e.layer >= minLayer && active.has(e.a) && active.has(e.b),
    );
    return { nodes, edges, active };
  }, [graph, minLayer]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const v = view;
    if (!canvas || !v) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    const pos = posRef.current;
    const muted = cssVar(canvas, "--muted-foreground", "#8b8b9a");
    const border = cssVar(canvas, "--border", "#33333a");
    const fg = cssVar(canvas, "--foreground", "#e5e5ea");
    ctx.clearRect(0, 0, w, h);

    // Edges first (layer 0 muted/thin, upper layers accented).
    for (const e of v.edges) {
      const a = pos.get(e.a);
      const b = pos.get(e.b);
      if (!a || !b) continue;
      ctx.strokeStyle = e.layer === 0 ? border : UPPER;
      ctx.globalAlpha = e.layer === 0 ? 0.5 : 0.85;
      ctx.lineWidth = e.layer === 0 ? 0.6 : 1.2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Nodes.
    const hoverNode = hoverRef.current?.node ?? -1;
    for (const n of v.nodes) {
      const p = pos.get(n.node);
      if (!p) continue;
      const isEntry = graph?.entry === n.node;
      const isHover = n.node === hoverNode;
      const r = isEntry ? 5.5 : isHover ? 5 : 3 + n.level * 0.8;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = isEntry ? ENTRY : isHover ? fg : muted;
      ctx.fill();
      if (isEntry || isHover) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = isHover ? ENTRY : fg;
        ctx.stroke();
      }
    }
  }, [view, graph]);

  // Force-directed layout: settle over a cooling rAF loop, then rest.
  useEffect(() => {
    const canvas = canvasRef.current;
    const v = view;
    if (!open || !canvas || !v || v.nodes.length === 0) return;
    const w = canvas.width;
    const h = canvas.height;
    const pos = posRef.current;
    // Seed any new nodes on a circle around the center.
    v.nodes.forEach((n, i) => {
      if (!pos.has(n.node)) {
        const a = (i / v.nodes.length) * Math.PI * 2;
        pos.set(n.node, {
          x: w / 2 + Math.cos(a) * (Math.min(w, h) / 3),
          y: h / 2 + Math.sin(a) * (Math.min(w, h) / 3),
          vx: 0,
          vy: 0,
        });
      }
    });
    // Drop positions for nodes no longer in view.
    for (const id of [...pos.keys()]) if (!v.active.has(id)) pos.delete(id);

    const area = w * h;
    const k = Math.sqrt(area / Math.max(v.nodes.length, 1)) * 0.55; // ideal spacing
    let alpha = 1;
    let frame = 0;
    const maxFrames = 260;

    const tick = () => {
      const nodes = v.nodes;
      // Repulsion (O(N²) — fine for the browser-scale graphs we visualize).
      for (let i = 0; i < nodes.length; i++) {
        const pi = pos.get(nodes[i].node)!;
        for (let j = i + 1; j < nodes.length; j++) {
          const pj = pos.get(nodes[j].node)!;
          let dx = pi.x - pj.x;
          let dy = pi.y - pj.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            d2 = 0.01;
          }
          const d = Math.sqrt(d2);
          const f = (k * k) / d;
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          pi.vx += fx;
          pi.vy += fy;
          pj.vx -= fx;
          pj.vy -= fy;
        }
      }
      // Spring attraction along edges.
      for (const e of v.edges) {
        const a = pos.get(e.a)!;
        const b = pos.get(e.b)!;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d * d) / k;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
      // Integrate with gravity toward center + cooling + bounds.
      for (const n of nodes) {
        const p = pos.get(n.node)!;
        p.vx += (w / 2 - p.x) * 0.008;
        p.vy += (h / 2 - p.y) * 0.008;
        const speed = Math.min(Math.sqrt(p.vx * p.vx + p.vy * p.vy), 30);
        const ang = Math.atan2(p.vy, p.vx);
        p.x += Math.cos(ang) * speed * alpha;
        p.y += Math.sin(ang) * speed * alpha;
        p.x = Math.max(12, Math.min(w - 12, p.x));
        p.y = Math.max(12, Math.min(h - 12, p.y));
        p.vx *= 0.85;
        p.vy *= 0.85;
      }
      alpha *= 0.985;
      frame++;
      draw();
      if (frame < maxFrames && alpha > 0.02) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [view, open, draw]);

  // Redraw on hover without re-running the layout (draw reads hoverRef).
  useEffect(() => {
    hoverRef.current = hover;
    draw();
  }, [hover, draw]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const v = view;
    if (!canvas || !v) return;
    const rect = canvas.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const my = ((e.clientY - rect.top) / rect.height) * canvas.height;
    let best: GraphNode | null = null;
    let bestD = 12 * 12;
    for (const n of v.nodes) {
      const p = posRef.current.get(n.node);
      if (!p) continue;
      const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    if (best?.node !== hover?.node) setHover(best);
  };

  const layerOptions = graph ? Array.from({ length: graph.max_level + 1 }, (_, i) => i) : [0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">
            HNSW graph · {table}.{col}
          </DialogTitle>
          <DialogDescription>
            The persisted approximate-nearest-neighbor index for this vector column. Each node is a
            row (labelled by rowid); the <span style={{ color: ENTRY }}>entry point</span> is
            highlighted and <span style={{ color: UPPER }}>upper-layer edges</span> are the sparse
            "express lanes."
          </DialogDescription>
        </DialogHeader>

        {loading && <p className="py-16 text-center text-sm text-muted-foreground">Loading graph…</p>}

        {error && (
          <p className="py-16 text-center text-sm text-destructive">Couldn't load graph: {error}</p>
        )}

        {!loading && !error && !graph && (
          <div className="py-14 text-center text-sm text-muted-foreground">
            <p className="font-medium text-foreground">No graph cached yet.</p>
            <p className="mx-auto mt-2 max-w-md leading-relaxed">
              The index is built on the first semantic search and persisted on the next write. Run a{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                WHERE {col} MATCH '…'
              </code>{" "}
              query on <span className="font-mono">{table}</span>, then reopen this view.
            </p>
          </div>
        )}

        {!loading && !error && graph && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Show layers ≥</span>
                <Select value={String(minLayer)} onValueChange={(x) => setMinLayer(Number(x))}>
                  <SelectTrigger className="h-7 w-16">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {layerOptions.map((l) => (
                      <SelectItem key={l} value={String(l)}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="text-xs text-muted-foreground">
                {view?.nodes.length ?? 0} nodes · {view?.edges.length ?? 0} edges · entry rowid{" "}
                <span className="font-mono text-foreground">
                  {graph.entry != null
                    ? (graph.nodes.find((n) => n.node === graph.entry)?.rowid ?? "—")
                    : "—"}
                </span>
              </div>
            </div>

            <canvas
              ref={canvasRef}
              width={720}
              height={420}
              onMouseMove={onMove}
              onMouseLeave={() => setHover(null)}
              className="w-full rounded-md border bg-background"
              style={{ aspectRatio: "720 / 420" }}
            />

            <div
              className={cn(
                "min-h-[2.5rem] rounded-md border bg-muted/40 px-3 py-2 text-xs",
                !hover && "text-muted-foreground",
              )}
            >
              {hover ? (
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-foreground">
                    #{hover.rowid} · level {hover.level}
                    {graph.entry === hover.node ? " · entry" : ""}
                  </span>
                  <span className="truncate text-muted-foreground">
                    {labels.get(hover.rowid) || <em>(empty)</em>}
                  </span>
                </div>
              ) : (
                "Hover a node to see its row."
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
