import { useEffect, useState } from "react";

export type ThemeKey = "light" | "sepia" | "dark" | "mocha" | "neon";
export const DEFAULT_THEME: ThemeKey = "dark";

export function getTheme(): ThemeKey {
  return (document.documentElement.dataset.theme as ThemeKey) || DEFAULT_THEME;
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
