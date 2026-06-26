import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { Row, SqlValue } from "@sqlite-anki/db-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface DataGridProps {
  columns: string[];
  rows: Row[];
  vectorColumns?: Set<string>;
  editable?: boolean;
  onEditCommit?: (rowid: number, column: string, value: SqlValue) => void;
  onDeleteRow?: (rowid: number) => void;
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(4);
  if (v instanceof Uint8Array) return `‹blob ${v.length}b›`;
  return String(v);
}

export function DataGrid({
  columns,
  rows,
  vectorColumns,
  editable = false,
  onEditCommit,
  onDeleteRow,
}: DataGridProps) {
  const [editing, setEditing] = useState<{ rowid: number; col: string } | null>(null);
  const [draft, setDraft] = useState("");
  // One shared tooltip that follows the hovered cell — only when it's truncated.
  const [hover, setHover] = useState<{ key: string; rect: DOMRect; text: string } | null>(null);

  const onCellOver = (e: React.MouseEvent) => {
    const td = (e.target as HTMLElement).closest<HTMLElement>("td[data-cell]");
    if (!td || td.scrollWidth <= td.clientWidth) {
      setHover((h) => (h ? null : h));
      return;
    }
    const key = td.dataset.cell!;
    setHover((h) =>
      h && h.key === key ? h : { key, rect: td.getBoundingClientRect(), text: td.textContent ?? "" },
    );
  };

  if (columns.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No rows.
      </div>
    );
  }

  const dataCols = columns.filter((c) => c !== "rowid");
  const hasRowid = columns.includes("rowid");

  const commit = (rowid: number, col: string) => {
    onEditCommit?.(rowid, col, draft === "" ? null : draft);
    setEditing(null);
  };

  return (
    <div
      className="scrollbar-thin h-full overflow-auto"
      onMouseOver={onCellOver}
      onMouseLeave={() => setHover(null)}
    >
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-card">
          <tr className="border-b">
            {hasRowid && (
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">#</th>
            )}
            {dataCols.map((c) => (
              <th key={c} className="whitespace-nowrap px-3 py-2 text-left font-medium">
                <span className="flex items-center gap-1.5">
                  {c}
                  {vectorColumns?.has(c) && <Badge variant="vector">vector</Badge>}
                  {c === "_similarity" && <Badge variant="default">score</Badge>}
                </span>
              </th>
            ))}
            {editable && onDeleteRow && <th className="w-10" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const rowid = hasRowid ? Number(row.rowid) : i;
            return (
              <tr key={rowid} className="border-b border-border/50 hover:bg-accent/40">
                {hasRowid && (
                  <td className="px-3 py-1.5 text-xs tabular-nums text-muted-foreground">
                    {String(row.rowid)}
                  </td>
                )}
                {dataCols.map((col) => {
                  const isEditing = editing?.rowid === rowid && editing.col === col;
                  return (
                    <td
                      key={col}
                      data-cell={`${rowid}:${col}`}
                      className={cn(
                        "max-w-[28rem] truncate px-3 py-1.5 align-top",
                        editable && col !== "_similarity" && "cursor-text",
                        col === "_similarity" && "tabular-nums text-violet-300",
                      )}
                      onDoubleClick={() => {
                        if (!editable || !hasRowid || col === "_similarity") return;
                        setEditing({ rowid, col });
                        setDraft(row[col] == null ? "" : String(row[col]));
                      }}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={() => commit(rowid, col)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commit(rowid, col);
                            if (e.key === "Escape") setEditing(null);
                          }}
                          className="w-full rounded border border-ring bg-background px-1 py-0.5 outline-none"
                        />
                      ) : (
                        renderValue(row[col])
                      )}
                    </td>
                  );
                })}
                {editable && onDeleteRow && (
                  <td className="px-1">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => onDeleteRow(rowid)}
                        >
                          <Trash2 className="text-destructive" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Delete row</TooltipContent>
                    </Tooltip>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* single shared tooltip, anchored to the hovered (truncated) cell */}
      {hover && (
        <Tooltip open key={hover.key}>
          <TooltipTrigger asChild>
            <span
              aria-hidden
              style={{
                position: "fixed",
                left: hover.rect.left,
                top: hover.rect.top,
                width: hover.rect.width,
                height: hover.rect.height,
                pointerEvents: "none",
              }}
            />
          </TooltipTrigger>
          <TooltipContent className="max-w-md whitespace-pre-wrap break-words">
            {hover.text}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
