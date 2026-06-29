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
import type { ReactNode } from "react";
import type { Metrics } from "@/db";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

/** A status-bar chip whose meaning is explained in a tooltip. */
function Chip({
  children,
  desc,
}: {
  children: ReactNode;
  desc: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex cursor-default items-center gap-1.5">{children}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs leading-relaxed">{desc}</TooltipContent>
    </Tooltip>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  desc,
  tone,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
  desc: ReactNode;
  tone?: "embed" | "default";
}) {
  return (
    <Chip desc={desc}>
      <Icon
        className={cn(
          "h-3.5 w-3.5",
          tone === "embed" ? "text-violet-400" : "text-muted-foreground",
        )}
      />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums text-foreground">{value}</span>
    </Chip>
  );
}

const ms = (n: number) => `${n.toFixed(n < 10 ? 1 : 0)}ms`;

export function StatusBar({ opfs, version, modelId, dim, op, busy, error }: StatusBarProps) {
  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t bg-card px-3 text-xs text-muted-foreground">
      <Chip
        desc={
          opfs
            ? "Storage backend: OPFS (Origin Private File System) — durable on-device storage that survives reloads."
            : "Storage backend: in-memory — this database is lost when you reload the page (OPFS unavailable)."
        }
      >
        <HardDrive className={cn("h-3.5 w-3.5", opfs ? "text-emerald-400" : "text-amber-400")} />
        {opfs ? "OPFS" : "in-memory"}
      </Chip>
      {version && (
        <Chip desc="Version of the SQLite engine compiled into the WASM build.">
          <Database className="h-3.5 w-3.5" /> SQLite {version}
        </Chip>
      )}
      {modelId && (
        <Chip desc={`Embedding model loaded for this session${dim ? ` — produces ${dim}-dimensional vectors` : ""}. It powers every MATCH query and the per-column scores.`}>
          <Cpu className="h-3.5 w-3.5 text-violet-400" /> {modelId}
          {dim ? ` · ${dim}d` : ""}
        </Chip>
      )}

      <div className="ml-auto flex items-center gap-4">
        {error ? (
          <span className="font-medium text-destructive">{error}</span>
        ) : busy ? (
          <span className="text-primary">working…</span>
        ) : op ? (
          <>
            <span className="text-foreground/80">{op.label}</span>
            <Metric
              icon={Timer}
              label="total"
              value={ms(op.elapsedMs)}
              desc="Total wall-clock time for this operation (measured in JS), covering SQL execution, embedding, search and I/O."
            />
            <Metric
              icon={Cpu}
              label="embed"
              value={`${ms(op.metrics.embed_ms)}×${op.metrics.embed_calls}`}
              tone="embed"
              desc="Time spent running the embedding model (tokenize + ONNX inference) and how many texts were embedded. Usually the dominant cost — this is the in-browser ML work."
            />
            <Metric
              icon={Search}
              label="search"
              value={ms(op.metrics.search_ms)}
              desc="Time spent in the vector search for this query — either the HNSW index lookup or a brute-force cosine scan."
            />
            <Metric
              icon={Save}
              label="persist"
              value={ms(op.metrics.persist_ms)}
              desc="Time spent writing rows (and their embeddings) to the shadow tables that back the virtual table."
            />
            {op.metrics.index_rebuild_ms > 0 && (
              <Metric
                icon={Layers}
                label="rebuild"
                value={ms(op.metrics.index_rebuild_ms)}
                desc="Time spent rebuilding the HNSW vector index. Happens lazily on the first MATCH after rows change."
              />
            )}
            {op.metrics.candidates > 0 && (
              <Metric
                icon={Gauge}
                label="cand"
                value={String(op.metrics.candidates)}
                desc="Number of rows whose cosine similarity was computed during the search (candidates examined)."
              />
            )}
          </>
        ) : (
          <span>ready</span>
        )}
      </div>
    </footer>
  );
}
