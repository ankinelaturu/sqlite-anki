// Main-thread OPFS helpers (async File System Access API). The worker owns the
// SQLite OPFS-VFS; here we only browse/read/edit the files it persists. Open
// `.db` files are locked → their size reads as null and they're not editable.

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface OpfsNode {
  name: string;
  /** Full path from the OPFS root, e.g. "/anki-models/model.onnx". */
  path: string;
  kind: "file" | "directory";
  /** File size in bytes; null for directories or locked files. */
  size: number | null;
  handle: FileSystemFileHandle | FileSystemDirectoryHandle;
  children?: OpfsNode[];
}

const TEXT_EXTS = new Set([
  "sql", "md", "txt", "json", "csv", "log", "js", "mjs", "cjs", "ts", "tsx",
  "html", "css", "xml", "yaml", "yml", "svg",
]);

export function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

/** Whether a file should open in the text editor (vs. a binary metadata view). */
export function isTextFile(name: string): boolean {
  return TEXT_EXTS.has(fileExt(name));
}

export function fmtBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function walkDir(dir: any, prefix: string): Promise<OpfsNode[]> {
  const nodes: OpfsNode[] = [];
  for await (const [name, handle] of dir.entries()) {
    const path = `${prefix}/${name}`;
    if (handle.kind === "directory") {
      nodes.push({
        name,
        path,
        kind: "directory",
        size: null,
        handle,
        children: await walkDir(handle, path),
      });
    } else {
      let size: number | null = null;
      try {
        size = (await handle.getFile()).size;
      } catch {
        size = null; // locked (e.g. an open .db)
      }
      nodes.push({ name, path, kind: "file", size, handle });
    }
  }
  nodes.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1,
  );
  return nodes;
}

/** Recursively reads the whole OPFS tree (root entries + nested dirs). */
export async function walkOpfs(): Promise<OpfsNode[]> {
  const root = await (navigator as any).storage.getDirectory();
  return walkDir(root, "");
}

export async function readText(handle: FileSystemFileHandle): Promise<string> {
  return (await handle.getFile()).text();
}

export async function writeText(handle: FileSystemFileHandle, content: string): Promise<void> {
  const w = await (handle as any).createWritable();
  await w.write(content);
  await w.close();
}

/** Triggers a browser download of an OPFS file. */
export async function downloadFile(handle: FileSystemFileHandle, name: string): Promise<void> {
  const file = await handle.getFile();
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Total OPFS-inclusive storage usage / quota for the origin. */
export async function storageEstimate(): Promise<{ usage: number; quota: number }> {
  const e = await (navigator as any).storage.estimate();
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
}
