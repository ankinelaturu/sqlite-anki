/*
 * sqlite-anki SQLite extension (C): registers SQL functions, the anki vtab,
 * and exposes the JS-facing model loader.
 *
 * The model is NOT bundled. The JS glue fetches the ONNX model + tokenizer and
 * calls anki_load_model() (below) before any SQL runs. anki_model()/anki_dim()
 * are implemented in Rust (they read the runtime-loaded model's metadata);
 * only anki_version() is a build constant here.
 */

#include "sqlite3ext.h"
SQLITE_EXTENSION_INIT1

#include <emscripten.h>
#include <stddef.h>

/* Rust: registers the `anki` vtab, similarity(), anki_model(), anki_dim(). */
extern int anki_register_vtab(sqlite3 *db);

/* Rust: loads the global embedder from bytes. Returns 0 on success. */
extern int anki_embedder_load(const unsigned char *model, size_t model_len,
                              const unsigned char *tokenizer, size_t tokenizer_len,
                              unsigned int dim,
                              const unsigned char *model_id, size_t model_id_len);

/*
 * JS-facing entry point. EMSCRIPTEN_KEEPALIVE exports it (and keeps it from
 * being dead-code-eliminated) so the glue can call it via wasm.exports. Thin
 * forwarder to the Rust loader.
 */
EMSCRIPTEN_KEEPALIVE
int anki_load_model(const unsigned char *model, size_t model_len,
                    const unsigned char *tokenizer, size_t tokenizer_len,
                    unsigned int dim,
                    const unsigned char *model_id, size_t model_id_len) {
  return anki_embedder_load(model, model_len, tokenizer, tokenizer_len, dim,
                            model_id, model_id_len);
}

/* Rust: JSON snapshot of cumulative operation metrics (see docs/metrics.md). */
extern const char *anki_metrics_json(void);

/* JS-facing metrics export; returns a NUL-terminated JSON string (do not free). */
EMSCRIPTEN_KEEPALIVE
const char *anki_metrics(void) { return anki_metrics_json(); }

static const char ANKI_VERSION[] = "0.1.0";

static void anki_version_fn(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc;
  (void)argv;
  sqlite3_result_text(ctx, ANKI_VERSION, -1, SQLITE_STATIC);
}

static int register_anki_functions(sqlite3 *db) {
  return sqlite3_create_function_v2(
      db, "anki_version", 0, SQLITE_UTF8 | SQLITE_DETERMINISTIC, 0,
      anki_version_fn, 0, 0, 0);
}

/* Exported for sqlite3_auto_extension (see sqlite3_wasm_extra_init.c). */
int sqlite3_anki_init(sqlite3 *db, char **pzErrMsg, const sqlite3_api_routines *pApi) {
  int rc;
  (void)pzErrMsg;
  SQLITE_EXTENSION_INIT2(pApi);
  rc = register_anki_functions(db);
  if (rc != SQLITE_OK) return rc;
  /* Registration only — the model is loaded separately via anki_load_model(). */
  return anki_register_vtab(db);
}
