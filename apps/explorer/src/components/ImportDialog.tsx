import { useMemo, useState } from "react";
import { Cpu, Database, Eye, FileUp, Sparkles, Table2 } from "lucide-react";
import type { ImportAnalysis, ImportColumn, ImportPlan } from "@/db";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface ImportDialogProps {
  analysis: ImportAnalysis;
  /** Sanitized default database name (no extension), from the uploaded filename. */
  defaultName: string;
  /** Currently-loaded model id — imports vectorize with this model. */
  modelId: string | null;
  /** Existing database paths (e.g. `/foo.db`) to warn on name collisions. */
  existingDbs: string[];
  onCancel: () => void;
  onConfirm: (targetPath: string, plan: ImportPlan) => void;
}

/** `{ tableName: Set<pickedColumn> }` */
type Picks = Record<string, Set<string>>;

/**
 * The Import & Vectorize dialog: pick which text columns to embed per table,
 * name the rebuilt database, and add notes. Vectorized tables become `anki`
 * virtual tables; everything else is copied verbatim.
 */
export function ImportDialog({
  analysis,
  defaultName,
  modelId,
  existingDbs,
  onCancel,
  onConfirm,
}: ImportDialogProps) {
  const [name, setName] = useState(defaultName);
  const [notes, setNotes] = useState("");
  const [picks, setPicks] = useState<Picks>({});
  // Per-table renames for reserved-prefix columns: { table: { oldName: newName } }.
  const [renames, setRenames] = useState<Record<string, Record<string, string>>>({});

  const toggle = (table: string, col: string) =>
    setPicks((p) => {
      const cur = new Set(p[table] ?? []);
      if (cur.has(col)) cur.delete(col);
      else cur.add(col);
      return { ...p, [table]: cur };
    });

  const setRename = (table: string, oldName: string, newName: string) =>
    setRenames((r) => ({ ...r, [table]: { ...(r[table] ?? {}), [oldName]: newName } }));

  // A rename is valid if it's non-empty, not itself `anki_`-prefixed, and doesn't
  // collide (case-insensitive) with another column's effective name in the table.
  const isValidRename = (table: string, oldName: string, cols: ImportColumn[]) => {
    const v = (renames[table]?.[oldName] ?? "").trim();
    if (!v || /^anki_/i.test(v)) return false;
    const lower = v.toLowerCase();
    return !cols.some(
      (c) => c.name !== oldName && (renames[table]?.[c.name] ?? c.name).toLowerCase() === lower,
    );
  };

  // Every vectorized table's reserved columns must be renamed before we can rebuild.
  const renamesResolved = analysis.tables.every((t) => {
    if ((picks[t.name]?.size ?? 0) === 0) return true;
    return t.columns.filter((c) => c.reserved).every((c) => isValidRename(t.name, c.name, t.columns));
  });

  const safeName = name.trim().replace(/[^a-zA-Z0-9_-]/g, "");
  const targetPath = `/${safeName}.db`;
  const collision = existingDbs.includes(targetPath);

  // Rows we'll embed = every row of a table with at least one picked column.
  const embedRows = useMemo(
    () =>
      analysis.tables
        .filter((t) => !t.isView && (picks[t.name]?.size ?? 0) > 0)
        .reduce((n, t) => n + t.rowCount, 0),
    [analysis, picks],
  );
  const totalPicks = Object.values(picks).reduce((n, s) => n + s.size, 0);

  const submit = () => {
    if (!safeName || collision || !renamesResolved) return;
    // Collect the reserved-column renames for vectorized tables only.
    const renamesOut: Record<string, Record<string, string>> = {};
    for (const t of analysis.tables) {
      if ((picks[t.name]?.size ?? 0) === 0) continue;
      const map: Record<string, string> = {};
      for (const c of t.columns) {
        if (c.reserved) map[c.name] = (renames[t.name]?.[c.name] ?? "").trim();
      }
      if (Object.keys(map).length) renamesOut[t.name] = map;
    }
    const plan: ImportPlan = {
      tables: Object.fromEntries(
        Object.entries(picks)
          .filter(([, s]) => s.size > 0)
          .map(([t, s]) => [t, [...s]]),
      ),
      renames: renamesOut,
      notes,
    };
    onConfirm(targetPath, plan);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-0 p-0">
        <DialogHeader className="shrink-0 border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <FileUp className="h-5 w-5 text-primary" /> Import &amp; Vectorize
          </DialogTitle>
          <DialogDescription>
            Tick the text columns to make semantically searchable. Those tables are
            rebuilt as <code className="text-foreground">anki</code> virtual tables;
            everything else is copied unchanged.
          </DialogDescription>
        </DialogHeader>

        {/* per-table column picker — scrolls independently */}
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
          <div className="space-y-4 px-5 py-4">
            {analysis.tables.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No tables or views found in this file.
              </p>
            )}
            {analysis.tables.map((t) => {
              const picked = picks[t.name] ?? new Set<string>();
              return (
                <div key={t.name} className="rounded-lg border bg-card">
                  <div className="flex items-center gap-2 border-b px-3 py-2">
                    {t.isView ? (
                      <Eye className="h-4 w-4 text-sky-400" />
                    ) : picked.size > 0 ? (
                      <Sparkles className="h-4 w-4 text-violet-400" />
                    ) : (
                      <Table2 className="h-4 w-4 text-sky-400" />
                    )}
                    <span className="text-sm font-medium">{t.name}</span>
                    {t.isView ? (
                      <Badge variant="outline">view</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {t.rowCount.toLocaleString()} row
                        {t.rowCount === 1 ? "" : "s"}
                      </span>
                    )}
                    {picked.size > 0 && (
                      <Badge variant="vector" className="ml-auto">
                        {picked.size} vector
                      </Badge>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 px-3 py-2.5 sm:grid-cols-2">
                    {t.columns.map((c) => {
                      const canVector = !t.isView && c.textLike;
                      const on = picked.has(c.name);
                      return (
                        <label
                          key={c.name}
                          className={cn(
                            "flex items-center gap-2 text-sm",
                            canVector ? "cursor-pointer" : "cursor-default opacity-60",
                          )}
                        >
                          <Checkbox
                            checked={on}
                            disabled={!canVector}
                            onCheckedChange={() => toggle(t.name, c.name)}
                          />
                          <span className="truncate">{c.name}</span>
                          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            {c.type || "—"}
                          </span>
                          {c.isBlob && (
                            <Badge variant="outline" className="ml-auto text-[10px]">
                              blob
                            </Badge>
                          )}
                        </label>
                      );
                    })}
                  </div>
                  {picked.size > 0 && t.columns.some((c) => c.reserved) && (
                    <div className="space-y-1.5 border-t px-3 py-2.5">
                      <p className="text-xs text-amber-400">
                        Reserved <code className="text-foreground">anki_</code> prefix —
                        rename to vectorize this table:
                      </p>
                      {t.columns
                        .filter((c) => c.reserved)
                        .map((c) => (
                          <div key={c.name} className="flex items-center gap-2 text-sm">
                            <span className="truncate font-mono text-xs text-muted-foreground">
                              {c.name}
                            </span>
                            <span className="text-muted-foreground">→</span>
                            <Input
                              value={renames[t.name]?.[c.name] ?? ""}
                              onChange={(e) => setRename(t.name, c.name, e.target.value)}
                              placeholder="new name"
                              className={cn(
                                "h-7 flex-1",
                                !isValidRename(t.name, c.name, t.columns) && "border-destructive",
                              )}
                            />
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* fixed footer: name, notes, model, actions */}
        <div className="shrink-0 space-y-3 border-t px-5 py-4">
          <div className="flex items-end gap-4">
            <div className="flex-1">
              <Label className="mb-1.5 block">Database name</Label>
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 shrink-0 text-sky-400" />
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="my-database"
                />
                <span className="text-sm text-muted-foreground">.db</span>
              </div>
              {collision && (
                <p className="mt-1 text-xs text-destructive">
                  A database named {safeName}.db already exists.
                </p>
              )}
            </div>
            <span className="flex items-center gap-1.5 pb-2 text-xs text-muted-foreground">
              <Cpu className="h-3.5 w-3.5 text-violet-400" />
              {modelId ?? "no model"}
            </span>
          </div>

          <div>
            <Label className="mb-1.5 block">Notes (optional)</Label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="What is this database for?"
              className="flex min-h-[3.5rem] w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
        </div>

        <DialogFooter className="shrink-0 items-center border-t px-5 py-3">
          <span className="mr-auto text-xs text-muted-foreground">
            {totalPicks === 0
              ? "No columns picked — the file will be copied unchanged."
              : `Will embed ~${embedRows.toLocaleString()} row${embedRows === 1 ? "" : "s"} across ${
                  Object.values(picks).filter((s) => s.size > 0).length
                } table${Object.values(picks).filter((s) => s.size > 0).length === 1 ? "" : "s"}.`}
          </span>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!safeName || collision || !renamesResolved}>
            {totalPicks === 0 ? "Import" : "Rebuild & Vectorize"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
