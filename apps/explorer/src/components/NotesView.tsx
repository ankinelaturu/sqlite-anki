import { useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { Check, RefreshCw, Save } from "lucide-react";
import type { AnkiWorkerApi, Remote } from "@sqlite-anki/db-client";
import { Button } from "@/components/ui/button";

interface NotesViewProps {
  api: Remote<AnkiWorkerApi>;
  path: string;
}

type SaveState = "loading" | "saved" | "dirty" | "saving";

export function NotesView({ api, path }: NotesViewProps) {
  const [content, setContent] = useState("");
  const [state, setState] = useState<SaveState>("loading");
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
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs text-muted-foreground">notes.md · autosaves</span>
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
        <CodeMirror
          value={content}
          onChange={onChange}
          theme="dark"
          extensions={[markdown()]}
          basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
          height="100%"
          style={{ height: "100%" }}
        />
      </div>
    </div>
  );
}
