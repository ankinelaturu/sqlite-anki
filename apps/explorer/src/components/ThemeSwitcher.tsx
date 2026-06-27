import { Coffee, Moon, Sun, Sunset, Zap } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { setTheme, useTheme, type ThemeKey } from "@/lib/theme";
import { cn } from "@/lib/utils";

const THEMES: { key: ThemeKey; label: string; icon: typeof Sun }[] = [
  { key: "light", label: "Light", icon: Sun },
  { key: "sepia", label: "Sepia", icon: Sunset },
  { key: "dark", label: "Dark", icon: Moon },
  { key: "mocha", label: "Mocha", icon: Coffee },
  { key: "neon", label: "Neon", icon: Zap },
];

export function ThemeSwitcher() {
  const theme = useTheme();
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border/60 p-0.5">
      {THEMES.map(({ key, label, icon: Icon }) => (
        <Tooltip key={key}>
          <TooltipTrigger asChild>
            <button
              onClick={() => setTheme(key)}
              aria-label={`${label} theme`}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded transition-colors",
                theme === key
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
