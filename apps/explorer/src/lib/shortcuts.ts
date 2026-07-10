/** True when the platform uses ⌘ as the primary modifier (macOS, iOS). */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

/** Primary modifier label for tooltips (`⌘` or `Ctrl`). */
export function modKeyLabel(): string {
  return isApplePlatform() ? "⌘" : "Ctrl";
}

/** `⌘Enter` or `Ctrl+Enter`. */
export function runSqlShortcut(): string {
  return isApplePlatform() ? "⌘Enter" : "Ctrl+Enter";
}

/** `⌘⇧Enter` or `Ctrl+Shift+Enter`. */
export function runSelectionShortcut(): string {
  return isApplePlatform() ? "⌘⇧Enter" : "Ctrl+Shift+Enter";
}
