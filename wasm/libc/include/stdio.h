/* Minimal <stdio.h> for the freestanding wasm32 build of MD4C.
 *
 * There is no file system inside the wasm module. All I/O goes through
 * memory buffers; the browser-side file system lives in JavaScript
 * (see wasm/js/md4c-fs.js, built on storagesdk). */
#ifndef MD4C_WASM_STDIO_H
#define MD4C_WASM_STDIO_H

#include <stddef.h>
#include <stdarg.h>

typedef struct MD4C_WASM_FILE FILE;
extern FILE* const stderr;
extern FILE* const stdout;

int vsnprintf(char* buf, size_t size, const char* fmt, va_list ap);
int snprintf(char* buf, size_t size, const char* fmt, ...);
int sprintf(char* buf, const char* fmt, ...);
int fprintf(FILE* f, const char* fmt, ...);

#endif
