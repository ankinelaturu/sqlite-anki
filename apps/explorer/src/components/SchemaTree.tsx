import { useState, type ReactElement } from "react";
import {
  Binary,
  Calendar,
  ChevronRight,
  Columns3,
  Hash,
  Sparkles,
  Table2,
  Type,
  type LucideIcon,
} from "lucide-react";
import type { TableInfo } from "@/db";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Per-column visual identity from SQLite type affinity: a left icon plus a pill
 *  style, sharing one color so a column's type and qualifiers read together. */
function typeMeta(type: string | undefined): { Icon: LucideIcon; color: string; pill: string } {
  const t = (type ?? "").toUpperCase();
  const num = {
    Icon: Hash,
    color: "text-sky-400",
    pill: "border-sky-400/30 bg-sky-400/10 text-sky-400",
  };
  if (/INT/.test(t)) return num;
  if (/CHAR|TEXT|CLOB/.test(t))
    return {
      Icon: Type,
      color: "text-emerald-400",
      pill: "border-emerald-400/30 bg-emerald-400/10 text-emerald-400",
    };
  if (/REAL|FLOA|DOUB|NUM|DEC/.test(t)) return num;
  if (/BLOB/.test(t))
    return {
      Icon: Binary,
      color: "text-orange-400",
      pill: "border-orange-400/30 bg-orange-400/10 text-orange-400",
    };
  if (/DATE|TIME/.test(t))
    return {
      Icon: Calendar,
      color: "text-pink-400",
      pill: "border-pink-400/30 bg-pink-400/10 text-pink-400",
    };
  return {
    Icon: Columns3,
    color: "text-muted-foreground",
    pill: "border-border bg-muted text-muted-foreground",
  };
}

/** Wraps an element in a shadcn tooltip when there's a description. */
function Described({ desc, children }: { desc?: string; children: ReactElement }) {
  if (!desc) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="max-w-xs leading-relaxed">{desc}</TooltipContent>
    </Tooltip>
  );
}

interface SchemaTreeProps {
  tables: TableInfo[];
  activeTable: string | null;
  onOpenTable: (table: TableInfo) => void;
}

export function SchemaTree({ tables, activeTable, onOpenTable }: SchemaTreeProps) {
  const [open, setOpen] = useState<Record<string, boolean>>({});

  if (tables.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        No tables. Create one from the SQL tab.
      </p>
    );
  }

  return (
    <div className="py-1">
      {tables.map((t) => {
        const isOpen = open[t.name] ?? false;
        return (
          <div key={t.name}>
            <div
              className={cn(
                "group flex items-center gap-1 rounded-md px-2 py-1 text-sm hover:bg-accent/50",
                activeTable === t.name && "bg-accent",
              )}
            >
              <button
                className="flex h-4 w-4 items-center justify-center text-muted-foreground"
                onClick={() => setOpen((s) => ({ ...s, [t.name]: !isOpen }))}
              >
                <ChevronRight
                  className={cn("h-3.5 w-3.5 transition-transform", isOpen && "rotate-90")}
                />
              </button>
              <Described desc={t.description}>
                <button
                  className="flex min-w-0 flex-1 items-center gap-1.5"
                  onClick={() => onOpenTable(t)}
                >
                  <Table2 className={cn("h-4 w-4 shrink-0", t.isAnki ? "text-violet-400" : "text-sky-400")} />
                  <span className="truncate">{t.name}</span>
                  {t.isAnki && <Sparkles className="h-3 w-3 shrink-0 text-violet-400" />}
                </button>
              </Described>
            </div>
            {isOpen && (
              <div className="ml-5 border-l pl-2">
                {t.columns.map((c) => {
                  const { Icon, color, pill } = typeMeta(c.type);
                  const pillCls = cn(
                    "inline-flex items-center rounded border px-1 text-[9px] font-medium uppercase leading-[1.4] tracking-wide",
                    pill,
                  );
                  return (
                    <Described key={c.name} desc={c.description}>
                      <div className="flex flex-wrap items-center gap-1.5 rounded px-2 py-[0.3rem] text-muted-foreground hover:bg-accent/50">
                        <Icon className={cn("h-4 w-4 shrink-0", color)} />
                        <span className="text-sm text-foreground/80">{c.name}</span>
                        {c.type && (
                          <span className={cn("text-xs uppercase opacity-60", color)}>
                            {c.type}
                          </span>
                        )}
                        {c.pk && <span className={pillCls}>PRIMARY KEY</span>}
                        {c.isVector && <span className={pillCls}>VECTOR</span>}
                        {c.notnull && !c.pk && <span className={pillCls}>NOT NULL</span>}
                        {c.hasDefault && <span className={pillCls}>DEFAULT</span>}
                      </div>
                    </Described>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
