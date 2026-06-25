/**
 * Introspection functions: `anki_version()`, `anki_model()`, `anki_dim()`.
 *
 * `anki_model()` and `anki_dim()` are NOT build constants — they read the
 * metadata of the model loaded at runtime via `anki_load_model` (see
 * docs/dynamic-model-loading.md). So they must reflect whatever model the glue
 * loaded, and report NULL before any model is loaded. `anki_version()` is the
 * one true constant (the extension's own version, baked in at build time).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule, withModel, MODEL_ID, MODEL_DIM } from "./harness.mjs";

// With a model loaded, the dynamic functions report that exact model's id and
// dimension. This is the data the persistence mismatch-guard also relies on.
test("introspection reflects the loaded model", async () => {
  const sqlite3 = await withModel();
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    const row = db.selectObject(
      "SELECT anki_version() AS version, anki_model() AS model, anki_dim() AS dim"
    );
    assert.equal(typeof row.version, "string");
    assert.equal(row.model, MODEL_ID);
    assert.equal(row.dim, MODEL_DIM);
  } finally {
    db.close();
  }
});

// Before a model is loaded the runtime metadata is empty, so the dynamic
// functions return NULL rather than a stale/hardcoded value. `anki_version()`
// is still available because it does not depend on a loaded model.
test("anki_dim()/anki_model() are NULL when no model is loaded", async () => {
  const sqlite3 = await loadModule(); // no model
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    assert.equal(db.selectValue("SELECT anki_dim()"), null);
    assert.equal(db.selectValue("SELECT anki_model()"), null);
    assert.equal(typeof db.selectValue("SELECT anki_version()"), "string");
  } finally {
    db.close();
  }
});
