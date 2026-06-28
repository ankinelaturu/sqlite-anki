import {
  Contrast,
  Database,
  HardDrive,
  Moon,
  ScrollText,
  Snowflake,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { setTheme, useTheme, type ThemeKey } from "@/lib/theme";
import { cn } from "@/lib/utils";

export type Activity = "sqlite" | "opfs";

const ACTIVITIES: { id: Activity; label: string; Icon: LucideIcon }[] = [
  { id: "sqlite", label: "SQLite", Icon: Database },
  { id: "opfs", label: "OPFS", Icon: HardDrive },
];

const THEMES: { key: ThemeKey; label: string; Icon: LucideIcon }[] = [
  { key: "light", label: "Light", Icon: Sun },
  { key: "paper", label: "Paper", Icon: ScrollText },
  { key: "dark", label: "Dark", Icon: Moon },
  { key: "dim", label: "Dim", Icon: Contrast },
  { key: "nord", label: "Nord", Icon: Snowflake },
];

/** One icon-only bar button with a left-edge accent line when selected. */
function BarButton({
  Icon,
  label,
  active,
  onClick,
}: {
  Icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          aria-label={label}
          aria-current={active}
          className={cn(
            "relative flex h-12 w-full items-center justify-center transition-colors",
            active
              ? "text-foreground"
              : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
          )}
        >
          <span
            className={cn(
              "absolute bottom-2 left-0 top-2 w-0.5 rounded-r bg-primary transition-opacity",
              active ? "opacity-100" : "opacity-0",
            )}
          />
          <Icon className="h-7 w-7" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/** VSCode-style activity bar: two groups of identical icon buttons — workspaces
 *  on top, theme picker at the bottom — separated by a divider. */
export function ActivityBar({
  active,
  onSelect,
}: {
  active: Activity;
  onSelect: (a: Activity) => void;
}) {
  const theme = useTheme();
  return (
    <nav className="flex w-16 shrink-0 flex-col gap-1 border-r bg-card py-3">
      {ACTIVITIES.map(({ id, label, Icon }) => (
        <BarButton
          key={id}
          Icon={Icon}
          label={label}
          active={active === id}
          onClick={() => onSelect(id)}
        />
      ))}
      <div className="mt-auto flex flex-col gap-1">
        <div className="mx-3 my-1 h-px bg-border/60" />
        {THEMES.map(({ key, label, Icon }) => (
          <BarButton
            key={key}
            Icon={Icon}
            label={label}
            active={theme === key}
            onClick={() => setTheme(key)}
          />
        ))}
      </div>
    </nav>
  );
}
