import { useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import MarkdownPreview from "@uiw/react-markdown-preview";
import "@uiw/react-markdown-preview/markdown.css";
import { Check, RefreshCw, Save } from "lucide-react";
import type { AnkiWorkerApi, Remote } from "@/db";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface NotesViewProps {
  api: Remote<AnkiWorkerApi>;
  path: string;
}

type SaveState = "loading" | "saved" | "dirty" | "saving";

export function NotesView({ api, path }: NotesViewProps) {
  const [content, setContent] = useState("");
  const [state, setState] = useState<SaveState>("loading");
  const [view, setView] = useState<"write" | "preview">("write");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const colorMode = useTheme() === "light" ? "light" : "dark";

  useEffect(() => {
    let alive = true;
    setState("loading");
    void api.readNotes(path).then((text) => {
      if (!alive) return;
      setContent(text);
      setState("saved");
    });
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [api, path]);

  const save = async (text: string) => {
    setState("saving");
    await api.writeNotes(path, text);
    setState((s) => (s === "saving" ? "saved" : s));
  };

  const onChange = (text: string) => {
    setContent(text);
    setState("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(text), 1200); // autosave
  };

  const label =
    state === "saving"
      ? "Saving…"
      : state === "dirty"
        ? "Unsaved"
        : state === "loading"
          ? "Loading…"
          : "Saved";

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex h-8 items-center rounded-md border border-input p-0.5">
          {(["write", "preview"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                "h-6 rounded px-2.5 text-xs font-medium capitalize transition-colors",
                view === v
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            {state === "saved" ? (
              <Check className="h-3.5 w-3.5 text-emerald-400" />
            ) : state === "saving" || state === "loading" ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            )}
            {label}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={state !== "dirty"}
            onClick={() => {
              if (timer.current) clearTimeout(timer.current);
              void save(content);
            }}
          >
            <Save /> Save
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {view === "write" ? (
          <CodeMirror
            value={content}
            onChange={onChange}
            theme={colorMode}
            extensions={[markdown()]}
            basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
            height="100%"
            style={{ height: "100%" }}
          />
        ) : (
          <div className="scrollbar-thin h-full overflow-auto px-5 py-4">
            {content.trim() ? (
              <MarkdownPreview
                source={content}
                style={{ background: "transparent", fontSize: 14 }}
                wrapperElement={{ "data-color-mode": colorMode }}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Nothing to preview yet.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
