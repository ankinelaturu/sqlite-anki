import { useState } from "react";
import { ChevronRight, Columns3, KeyRound, Sparkles, Table2 } from "lucide-react";
import type { TableInfo } from "@sqlite-anki/db-client";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

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
                "group flex items-center gap-1 rounded-md px-2 py-1 text-sm",
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
              <button
                className="flex min-w-0 flex-1 items-center gap-1.5"
                onClick={() => onOpenTable(t)}
              >
                <Table2 className={cn("h-4 w-4 shrink-0", t.isAnki ? "text-violet-400" : "text-sky-400")} />
                <span className="truncate">{t.name}</span>
                {t.isAnki && <Sparkles className="h-3 w-3 shrink-0 text-violet-400" />}
              </button>
            </div>
            {isOpen && (
              <div className="ml-5 border-l pl-2">
                {t.columns.map((c) => (
                  <div
                    key={c.name}
                    className="flex items-center gap-1.5 px-2 py-0.5 text-xs text-muted-foreground"
                  >
                    {c.pk ? (
                      <KeyRound className="h-3 w-3 text-amber-400" />
                    ) : (
                      <Columns3 className="h-3 w-3" />
                    )}
                    <span className="truncate text-foreground/80">{c.name}</span>
                    {c.isVector ? (
                      <Badge variant="vector">vector</Badge>
                    ) : (
                      c.type && <span className="text-muted-foreground/70">{c.type}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
