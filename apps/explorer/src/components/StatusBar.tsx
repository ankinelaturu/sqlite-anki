import {
  Cpu,
  Database,
  Gauge,
  HardDrive,
  Layers,
  Search,
  Save,
  Timer,
} from "lucide-react";
import type { Metrics } from "@sqlite-anki/db-client";
import { cn } from "@/lib/utils";

export interface OpStatus {
  label: string;
  elapsedMs: number;
  metrics: Metrics;
}

interface StatusBarProps {
  opfs: boolean;
  version: string | null;
  modelId: string | null;
  dim: number | null;
  op: OpStatus | null;
  busy: boolean;
  error: string | null;
}

function Metric({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
  tone?: "embed" | "default";
}) {
  return (
    <div
      className="flex items-center gap-1.5 tabular-nums"
      title={label}
    >
      <Icon
        className={cn(
          "h-3.5 w-3.5",
          tone === "embed" ? "text-violet-400" : "text-muted-foreground",
        )}
      />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

const ms = (n: number) => `${n.toFixed(n < 10 ? 1 : 0)}ms`;

export function StatusBar({ opfs, version, modelId, dim, op, busy, error }: StatusBarProps) {
  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t bg-card px-3 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <HardDrive className={cn("h-3.5 w-3.5", opfs ? "text-emerald-400" : "text-amber-400")} />
        {opfs ? "OPFS" : "in-memory"}
      </span>
      {version && (
        <span className="flex items-center gap-1.5">
          <Database className="h-3.5 w-3.5" /> SQLite {version}
        </span>
      )}
      {modelId && (
        <span className="flex items-center gap-1.5">
          <Cpu className="h-3.5 w-3.5 text-violet-400" /> {modelId}
          {dim ? ` · ${dim}d` : ""}
        </span>
      )}

      <div className="ml-auto flex items-center gap-4">
        {error ? (
          <span className="font-medium text-destructive">{error}</span>
        ) : busy ? (
          <span className="text-primary">working…</span>
        ) : op ? (
          <>
            <span className="text-foreground/80">{op.label}</span>
            <Metric icon={Timer} label="total" value={ms(op.elapsedMs)} />
            <Metric icon={Cpu} label="embed" value={`${ms(op.metrics.embed_ms)}×${op.metrics.embed_calls}`} tone="embed" />
            <Metric icon={Search} label="search" value={ms(op.metrics.search_ms)} />
            <Metric icon={Save} label="persist" value={ms(op.metrics.persist_ms)} />
            {op.metrics.index_rebuild_ms > 0 && (
              <Metric icon={Layers} label="rebuild" value={ms(op.metrics.index_rebuild_ms)} />
            )}
            {op.metrics.candidates > 0 && (
              <Metric icon={Gauge} label="cand" value={String(op.metrics.candidates)} />
            )}
          </>
        ) : (
          <span>ready</span>
        )}
      </div>
    </footer>
  );
}
