/**
 * Main-thread facade for the sqlite-anki database worker.
 */
import * as Comlink from "comlink";
import type { AnkiWorkerApi } from "./types";

export * from "./types";
export type Remote<T> = Comlink.Remote<T>;

let worker: Worker | null = null;
let api: Comlink.Remote<AnkiWorkerApi> | null = null;

/** Returns the (lazily-started) worker API handle. */
export function getDbWorker(): Comlink.Remote<AnkiWorkerApi> {
  if (!api) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    api = Comlink.wrap<AnkiWorkerApi>(worker);
  }
  return api;
}

/** Terminates the worker (e.g. to switch models — `init` runs once per worker). */
export function resetDbWorker(): void {
  worker?.terminate();
  worker = null;
  api = null;
}
