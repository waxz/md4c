/* Minimal <stdlib.h> for the freestanding wasm32 build of MD4C. */
#ifndef MD4C_WASM_STDLIB_H
#define MD4C_WASM_STDLIB_H

#include <stddef.h>

void* malloc(size_t size);
void* calloc(size_t n, size_t size);
void* realloc(void* ptr, size_t size);
void free(void* ptr);

void qsort(void* base, size_t n, size_t size,
           int (*cmp)(const void*, const void*));
void* bsearch(const void* key, const void* base, size_t n, size_t size,
              int (*cmp)(const void*, const void*));

void abort(void);

#endif
