import { useEffect, useState } from "react";

export type ThemeKey = "light" | "paper" | "dark" | "dim" | "nord";
export const DEFAULT_THEME: ThemeKey = "dark";

/** Themes with light backgrounds — CodeMirror / markdown preview use the light palette. */
export const LIGHT_THEMES = new Set<ThemeKey>(["light", "paper"]);

/** Maps retired theme keys saved in localStorage to their replacements. */
const LEGACY_THEME: Record<string, ThemeKey> = {
  sepia: "paper",
  mocha: "dim",
  neon: "nord",
};

export function migrateThemeKey(raw: string | null): ThemeKey {
  if (!raw) return DEFAULT_THEME;
  if (raw in LEGACY_THEME) return LEGACY_THEME[raw]!;
  if (raw === "light" || raw === "paper" || raw === "dark" || raw === "dim" || raw === "nord") {
    return raw;
  }
  return DEFAULT_THEME;
}

export function isLightTheme(key: ThemeKey): boolean {
  return LIGHT_THEMES.has(key);
}

/** CodeMirror / markdown `data-color-mode` value for a theme key. */
export function editorColorMode(key: ThemeKey): "light" | "dark" {
  return isLightTheme(key) ? "light" : "dark";
}

export function getTheme(): ThemeKey {
  return migrateThemeKey(document.documentElement.dataset.theme ?? null);
}

export function setTheme(key: ThemeKey): void {
  document.documentElement.dataset.theme = key;
  try {
    localStorage.setItem("theme", key);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event("themechange"));
}

/** Reactive current theme — updates when `setTheme` is called anywhere. */
export function useTheme(): ThemeKey {
  const [theme, set] = useState<ThemeKey>(getTheme);
  useEffect(() => {
    const handler = () => set(getTheme());
    window.addEventListener("themechange", handler);
    return () => window.removeEventListener("themechange", handler);
  }, []);
  return theme;
}
