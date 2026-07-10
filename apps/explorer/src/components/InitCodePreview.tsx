import { useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Check, Copy, FileCode2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ankiInitSnippet } from "@/lib/ankiInitSnippet";
import { editorColorMode, useTheme } from "@/lib/theme";

interface InitCodePreviewProps {
  modelId: string;
}

/** Read-only TypeScript preview of `sqlite3Init({ anki })` for the selected model. */
export function InitCodePreview({ modelId }: InitCodePreviewProps) {
  const colorMode = editorColorMode(useTheme());
  const code = useMemo(() => ankiInitSnippet(modelId), [modelId]);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const extensions = useMemo(
    () => [javascript({ typescript: true }), EditorState.readOnly.of(true), EditorView.editable.of(false)],
    [],
  );

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex shrink-0 items-center gap-2">
        <FileCode2 className="h-4 w-4 shrink-0 text-primary" />
        <p className="text-sm font-medium">The code</p>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              aria-label={copied ? "Copied" : "Copy code"}
              onClick={() => void copyCode()}
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{copied ? "Copied" : "Copy"}</TooltipContent>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-muted/30 [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto">
        <CodeMirror
          value={code}
          theme={colorMode}
          extensions={extensions}
          editable={false}
          basicSetup={{
            lineNumbers: true,
            foldGutter: false,
            highlightActiveLine: false,
            autocompletion: false,
          }}
          height="100%"
          className="h-full"
          style={{ height: "100%", fontSize: "12px" }}
        />
      </div>
    </div>
  );
}
