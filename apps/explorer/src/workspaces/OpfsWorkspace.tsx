import { useCallback, useEffect, useState } from "react";
import { File, Folder, HardDrive, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Entry {
  name: string;
  kind: "file" | "directory";
  size: number | null; // null = directory or locked (e.g. an open .db)
}

function fmtSize(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Phase 1: a flat read-only listing of the OPFS root so you can verify the
 * explorer is actually creating files (databases, sidecars, the model cache).
 * Phase 2 will add a recursive tree + editors + an OPFS status bar.
 */
export function OpfsWorkspace() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const root = await (navigator as any).storage.getDirectory();
      const out: Entry[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const [name, h] of (root as any).entries()) {
        let size: number | null = null;
        if (h.kind === "file") {
          try {
            size = (await h.getFile()).size;
          } catch {
            size = null; // locked (open db) or unreadable
          }
        }
        out.push({ name, kind: h.kind, size });
      }
      out.sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1,
      );
      setEntries(out);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-card px-4">
        <div className="flex items-center gap-2 font-semibold">
          <HardDrive className="h-5 w-5 text-primary" /> OPFS
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

      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-3">
        {err && <p className="text-sm text-destructive">{err}</p>}
        {!err && entries.length === 0 && !loading && (
          <p className="text-sm text-muted-foreground">
            Empty — create or populate a database in the SQLite workspace, then Refresh.
          </p>
        )}
        <div className="divide-y divide-border/60">
          {entries.map((e) => (
            <div key={e.name} className="flex items-center gap-2 px-2 py-1.5 text-sm">
              {e.kind === "directory" ? (
                <Folder className="h-4 w-4 shrink-0 text-sky-400" />
              ) : (
                <File className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{e.name}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {e.kind === "directory" ? "dir" : fmtSize(e.size)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
