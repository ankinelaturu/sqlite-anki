import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import MarkdownPreview from "@uiw/react-markdown-preview";
import "@uiw/react-markdown-preview/markdown.css";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

export type MarkdownMode = "write" | "preview";

/** Shared Write/Preview segmented toggle (place in a host's header). */
export function WritePreviewToggle({
  mode,
  onChange,
}: {
  mode: MarkdownMode;
  onChange: (m: MarkdownMode) => void;
}) {
  return (
    <div className="flex h-7 items-center rounded-md border border-input p-0.5">
      {(["write", "preview"] as const).map((v) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={cn(
            "h-6 rounded px-2.5 text-xs font-medium capitalize transition-colors",
            mode === v
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {v}
        </button>
      ))}
    </div>
  );
}

/**
 * Shared Markdown editor body: CodeMirror (write) or rendered preview. Controlled
 * — the host owns `value`/`onChange` and the `mode` toggle. Used by the SQLite
 * Notes tab and OPFS `.md` files so the editing experience is identical.
 */
export function MarkdownEditor({
  value,
  onChange,
  mode,
}: {
  value: string;
  onChange: (v: string) => void;
  mode: MarkdownMode;
}) {
  const colorMode = useTheme() === "light" ? "light" : "dark";
  return mode === "write" ? (
    <CodeMirror
      value={value}
      onChange={onChange}
      theme={colorMode}
      extensions={[markdown()]}
      basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
      height="100%"
      style={{ height: "100%" }}
    />
  ) : (
    <div className="scrollbar-thin h-full overflow-auto px-5 py-4">
      {value.trim() ? (
        <MarkdownPreview
          source={value}
          style={{ background: "transparent", fontSize: 14 }}
          wrapperElement={{ "data-color-mode": colorMode }}
        />
      ) : (
        <p className="text-sm text-muted-foreground">Nothing to preview yet.</p>
      )}
    </div>
  );
}
