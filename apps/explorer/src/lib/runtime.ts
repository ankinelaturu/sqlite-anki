import { useEffect, useState } from "react";
import type { InitResult } from "@/db";

/**
 * Shared handle on the loaded wasm runtime (`sqlite3Init` result).
 *
 * The SQLite workspace owns initialization — `init` runs once per worker — but
 * other panels (Architecture) want the same version/model/dim facts without
 * forcing a second init or starting the worker themselves. This is a tiny
 * module-level store with a window-event subscription, mirroring `theme.ts`.
 */
let current: InitResult | null = null;

const EVENT = "anki-runtime-change";

/** Publishes the runtime facts (or `null` after a reset). */
export function setRuntimeInfo(info: InitResult | null): void {
  current = info;
  window.dispatchEvent(new Event(EVENT));
}

export function getRuntimeInfo(): InitResult | null {
  return current;
}

/** Reactive runtime facts — updates when `setRuntimeInfo` is called anywhere. */
export function useRuntimeInfo(): InitResult | null {
  const [info, set] = useState<InitResult | null>(getRuntimeInfo);
  useEffect(() => {
    const handler = () => set(getRuntimeInfo());
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);
  return info;
}
