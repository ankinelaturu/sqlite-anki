import { useState } from "react";
import { ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { fmtBytes, type OpfsNode } from "@/lib/opfs";
import { cn } from "@/lib/utils";

interface OpfsTreeProps {
  nodes: OpfsNode[];
  selectedPath: string | null;
  onSelect: (node: OpfsNode) => void;
  depth?: number;
}

export function OpfsTree({ nodes, selectedPath, onSelect, depth = 0 }: OpfsTreeProps) {
  if (nodes.length === 0 && depth === 0) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        Empty — create or populate a database in the SQLite workspace.
      </p>
    );
  }
  return (
    <div>
      {nodes.map((node) => (
        <OpfsTreeItem
          key={node.path}
          node={node}
          selectedPath={selectedPath}
          onSelect={onSelect}
          depth={depth}
        />
      ))}
    </div>
  );
}

function OpfsTreeItem({
  node,
  selectedPath,
  onSelect,
  depth,
}: {
  node: OpfsNode;
  selectedPath: string | null;
  onSelect: (node: OpfsNode) => void;
  depth: number;
}) {
  const [open, setOpen] = useState(depth === 0);
  const isDir = node.kind === "directory";
  const selected = node.path === selectedPath;

  return (
    <div>
      <div
        role="button"
        onClick={() => (isDir ? setOpen((o) => !o) : onSelect(node))}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        className={cn(
          "flex cursor-default items-center gap-1.5 rounded py-1 pr-2 text-sm hover:bg-accent/50",
          selected && "bg-accent",
        )}
      >
        {isDir ? (
          <ChevronRight
            className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        {isDir ? (
          open ? (
            <FolderOpen className="h-4 w-4 shrink-0 text-sky-400" />
          ) : (
            <Folder className="h-4 w-4 shrink-0 text-sky-400" />
          )
        ) : (
          <File className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className={cn("truncate", selected ? "text-foreground" : "text-foreground/80")}>
          {node.name}
        </span>
        {!isDir && (
          <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">
            {fmtBytes(node.size)}
          </span>
        )}
      </div>
      {isDir && open && node.children && (
        <OpfsTree
          nodes={node.children}
          selectedPath={selectedPath}
          onSelect={onSelect}
          depth={depth + 1}
        />
      )}
    </div>
  );
}
