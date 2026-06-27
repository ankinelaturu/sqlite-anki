import { useState } from "react";
import { ActivityBar, type Activity } from "@/components/ActivityBar";
import { SqliteWorkspace } from "@/workspaces/SqliteWorkspace";
import { OpfsWorkspace } from "@/workspaces/OpfsWorkspace";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const ACTIVITY_KEY = "anki-activity";

export function App() {
  const [activity, setActivity] = useState<Activity>(
    () => (localStorage.getItem(ACTIVITY_KEY) as Activity) || "sqlite",
  );
  const select = (a: Activity) => {
    setActivity(a);
    localStorage.setItem(ACTIVITY_KEY, a);
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen">
        <ActivityBar active={activity} onSelect={select} />
        {/* Both workspaces stay mounted (inactive one hidden) so the SQLite
            workspace keeps its loaded model + open tabs when you peek at OPFS. */}
        <div className={cn("h-full min-w-0 flex-1", activity !== "sqlite" && "hidden")}>
          <SqliteWorkspace />
        </div>
        <div className={cn("h-full min-w-0 flex-1", activity !== "opfs" && "hidden")}>
          <OpfsWorkspace />
        </div>
      </div>
    </TooltipProvider>
  );
}
