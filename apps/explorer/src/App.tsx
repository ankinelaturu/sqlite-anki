import { useCallback, useState } from "react";
import { ActivityBar, type Activity } from "@/components/ActivityBar";
import { SqliteWorkspace } from "@/workspaces/SqliteWorkspace";
import { OpfsWorkspace } from "@/workspaces/OpfsWorkspace";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const ACTIVITY_KEY = "anki-activity";
const SIDEBAR_KEY = "anki-sidebar";

/** Shared props so the sidebar width stays in sync across both workspaces. */
export interface WorkspaceProps {
  sidebarSize: number;
  onSidebarResize: (pct: number) => void;
  active: boolean;
}

export function App() {
  const [activity, setActivity] = useState<Activity>(
    () => (localStorage.getItem(ACTIVITY_KEY) as Activity) || "sqlite",
  );
  const [sidebarSize, setSidebarSize] = useState<number>(
    () => Number(localStorage.getItem(SIDEBAR_KEY)) || 24,
  );

  const select = (a: Activity) => {
    setActivity(a);
    localStorage.setItem(ACTIVITY_KEY, a);
  };
  const onSidebarResize = useCallback((pct: number) => {
    setSidebarSize(pct);
    localStorage.setItem(SIDEBAR_KEY, String(pct));
  }, []);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen">
        <ActivityBar active={activity} onSelect={select} />
        {/* Both workspaces stay mounted (inactive one hidden) so the SQLite
            workspace keeps its loaded model + open tabs when you peek at OPFS.
            The sidebar width is shared + re-applied when a workspace activates. */}
        <div className={cn("h-full min-w-0 flex-1", activity !== "sqlite" && "hidden")}>
          <SqliteWorkspace
            sidebarSize={sidebarSize}
            onSidebarResize={onSidebarResize}
            active={activity === "sqlite"}
          />
        </div>
        <div className={cn("h-full min-w-0 flex-1", activity !== "opfs" && "hidden")}>
          <OpfsWorkspace
            sidebarSize={sidebarSize}
            onSidebarResize={onSidebarResize}
            active={activity === "opfs"}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}
