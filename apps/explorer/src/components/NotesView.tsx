import { useEffect, useRef, useState } from "react";
import { Check, RefreshCw, Save } from "lucide-react";
import type { AnkiWorkerApi, Remote } from "@/db";
import { Button } from "@/components/ui/button";
import { MarkdownEditor, WritePreviewToggle, type MarkdownMode } from "@/components/MarkdownEditor";

interface NotesViewProps {
  api: Remote<AnkiWorkerApi>;
  path: string;
}

type SaveState = "loading" | "saved" | "dirty" | "saving";

export function NotesView({ api, path }: NotesViewProps) {
  const [content, setContent] = useState("");
  const [state, setState] = useState<SaveState>("loading");
  const [view, setView] = useState<MarkdownMode>("write");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
        <WritePreviewToggle mode={view} onChange={setView} />
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
        <MarkdownEditor value={content} onChange={onChange} mode={view} />
      </div>
    </div>
  );
}
