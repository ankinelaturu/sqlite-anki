/*
 * sqlite-anki SQLite extension (C): registers SQL functions and calls Rust embedder.
 */

#include "sqlite3ext.h"
SQLITE_EXTENSION_INIT1

#include <stddef.h>

/* Rust embedder warm-up (ONNX + tokenizer); returns 0 on success. */
extern int anki_embedder_init(void);

static const char ANKI_VERSION[] = "0.1.0";
static const char ANKI_MODEL[] = "all-MiniLM-L6-v2";
static const int ANKI_DIM = 384;

static void anki_version_fn(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc;
  (void)argv;
  sqlite3_result_text(ctx, ANKI_VERSION, -1, SQLITE_STATIC);
}

static void anki_model_fn(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc;
  (void)argv;
  sqlite3_result_text(ctx, ANKI_MODEL, -1, SQLITE_STATIC);
}

static void anki_dim_fn(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc;
  (void)argv;
  sqlite3_result_int64(ctx, (sqlite3_int64)ANKI_DIM);
}

static int register_anki_functions(sqlite3 *db) {
  int rc;
  rc = sqlite3_create_function_v2(
      db, "anki_version", 0, SQLITE_UTF8 | SQLITE_DETERMINISTIC, 0,
      anki_version_fn, 0, 0, 0);
  if (rc != SQLITE_OK) return rc;

  rc = sqlite3_create_function_v2(
      db, "anki_model", 0, SQLITE_UTF8 | SQLITE_DETERMINISTIC, 0,
      anki_model_fn, 0, 0, 0);
  if (rc != SQLITE_OK) return rc;

  rc = sqlite3_create_function_v2(
      db, "anki_dim", 0, SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS, 0,
      anki_dim_fn, 0, 0, 0);
  if (rc != SQLITE_OK) return rc;

  return SQLITE_OK;
}

/* Exported for sqlite3_auto_extension (see sqlite3_wasm_extra_init.c). */
int sqlite3_anki_init(sqlite3 *db, char **pzErrMsg, const sqlite3_api_routines *pApi) {
  int rc;
  (void)pzErrMsg;
  SQLITE_EXTENSION_INIT2(pApi);
  rc = register_anki_functions(db);
  if (rc != SQLITE_OK) return rc;
  if (anki_embedder_init() != 0) return SQLITE_ERROR;
  return SQLITE_OK;
}
