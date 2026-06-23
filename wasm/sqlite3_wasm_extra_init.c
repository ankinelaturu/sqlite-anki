/*
 * sqlite-anki WASM bootstrap for official SQLite ext/wasm build.
 *
 * When this file is present in the ext/wasm build directory, SQLite defines
 * SQLITE_EXTRA_INIT=sqlite3_wasm_extra_init and calls it during library init.
 *
 * See: https://sqlite.org/wasm/doc/trunk/building.md
 */

#include "sqlite3.h"

#include "anki_extension.c"

int sqlite3_wasm_extra_init(const char *zArg) {
  (void)zArg;
  return sqlite3_auto_extension((void (*)(void))sqlite3_anki_init);
}
