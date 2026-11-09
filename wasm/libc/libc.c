/*
 * Tiny freestanding libc for building MD4C to wasm32 with plain clang
 * (no Emscripten, no WASI sysroot needed).
 *
 * Memory model: a bump ("arena") allocator on top of the wasm linear memory.
 * free() is a no-op, and realloc() grows the most recent block in place when
 * it can. The whole heap is released at once by md4c_wasm_heap_reset(), which
 * the wrapper calls before every conversion. A conversion allocates only a
 * small multiple of the input/output size, so this is both simple and fast.
 */

#include <stddef.h>
#include <stdint.h>
#include <stdarg.h>

#include "include/stdio.h"
#include "include/stdlib.h"
#include "include/string.h"


/**************************
 ***  Memory allocator  ***
 **************************/

extern unsigned char __heap_base;

#define ALIGN           16
#define PAGE_SIZE       65536
#define HDR_SIZE        ALIGN   /* keeps payloads 16-byte aligned */

static uintptr_t heap_top = 0;
static uintptr_t last_block = 0;

static uintptr_t
align_up(uintptr_t x)
{
    return (x + (ALIGN - 1)) & ~(uintptr_t)(ALIGN - 1);
}

static int
ensure_memory(uintptr_t end)
{
    uintptr_t have = __builtin_wasm_memory_size(0) * (uintptr_t) PAGE_SIZE;
    if(end > have) {
        uintptr_t pages = (end - have + PAGE_SIZE - 1) / PAGE_SIZE;
        if(__builtin_wasm_memory_grow(0, pages) == (size_t) -1)
            return -1;
    }
    return 0;
}

void
md4c_wasm_heap_reset(void)
{
    heap_top = align_up((uintptr_t) &__heap_base);
    last_block = 0;
}

void*
malloc(size_t size)
{
    uintptr_t block, end;

    if(heap_top == 0)
        md4c_wasm_heap_reset();

    block = heap_top + HDR_SIZE;
    end = align_up(block + size);
    if(end < block  ||  ensure_memory(end) != 0)
        return NULL;

    *(size_t*)(block - HDR_SIZE) = size;
    heap_top = end;
    last_block = block;
    return (void*) block;
}

void*
calloc(size_t n, size_t size)
{
    size_t total = n * size;
    void* p;

    if(size != 0  &&  total / size != n)
        return NULL;
    p = malloc(total);
    if(p != NULL)
        memset(p, 0, total);
    return p;
}

void
free(void* ptr)
{
    (void) ptr;
}

void*
realloc(void* ptr, size_t size)
{
    size_t old_size;
    void* p;

    if(ptr == NULL)
        return malloc(size);

    old_size = *(size_t*)((uintptr_t) ptr - HDR_SIZE);

    /* The most recent block can simply be extended. */
    if((uintptr_t) ptr == last_block) {
        uintptr_t end = align_up((uintptr_t) ptr + size);
        if(ensure_memory(end) != 0)
            return NULL;
        *(size_t*)((uintptr_t) ptr - HDR_SIZE) = size;
        heap_top = end;
        return ptr;
    }

    p = malloc(size);
    if(p != NULL)
        memcpy(p, ptr, (old_size < size) ? old_size : size);
    return p;
}

void
abort(void)
{
    __builtin_trap();
}


/*************************
 ***  Memory & string  ***
 *************************/

void*
memcpy(void* dst, const void* src, size_t n)
{
    unsigned char* d = dst;
    const unsigned char* s = src;
    while(n--)
        *d++ = *s++;
    return dst;
}

void*
memmove(void* dst, const void* src, size_t n)
{
    unsigned char* d = dst;
    const unsigned char* s = src;
    if(d < s) {
        while(n--)
            *d++ = *s++;
    } else if(d > s) {
        d += n;
        s += n;
        while(n--)
            *--d = *--s;
    }
    return dst;
}

void*
memset(void* dst, int c, size_t n)
{
    unsigned char* d = dst;
    while(n--)
        *d++ = (unsigned char) c;
    return dst;
}

int
memcmp(const void* a, const void* b, size_t n)
{
    const unsigned char* x = a;
    const unsigned char* y = b;
    for(; n > 0; n--, x++, y++) {
        if(*x != *y)
            return (int) *x - (int) *y;
    }
    return 0;
}

void*
memchr(const void* s, int c, size_t n)
{
    const unsigned char* p = s;
    for(; n > 0; n--, p++) {
        if(*p == (unsigned char) c)
            return (void*) p;
    }
    return NULL;
}

size_t
strlen(const char* s)
{
    const char* p = s;
    while(*p)
        p++;
    return (size_t)(p - s);
}

char*
strchr(const char* s, int c)
{
    for(;; s++) {
        if(*s == (char) c)
            return (char*) s;
        if(*s == '\0')
            return NULL;
    }
}

int
strcmp(const char* a, const char* b)
{
    while(*a  &&  *a == *b) {
        a++;
        b++;
    }
    return (int)(unsigned char) *a - (int)(unsigned char) *b;
}

int
strncmp(const char* a, const char* b, size_t n)
{
    for(; n > 0; n--, a++, b++) {
        if(*a != *b)
            return (int)(unsigned char) *a - (int)(unsigned char) *b;
        if(*a == '\0')
            return 0;
    }
    return 0;
}


/*************************
 ***  Sort & search    ***
 *************************/

static void
swap_bytes(unsigned char* a, unsigned char* b, size_t size)
{
    while(size--) {
        unsigned char t = *a;
        *a++ = *b;
        *b++ = t;
    }
}

/* Heap sort: O(n log n), no recursion, no extra memory. */
static void
sift_down(unsigned char* base, size_t root, size_t n, size_t size,
          int (*cmp)(const void*, const void*))
{
    for(;;) {
        size_t child = 2 * root + 1;
        if(child >= n)
            return;
        if(child + 1 < n  &&  cmp(base + child * size, base + (child+1) * size) < 0)
            child++;
        if(cmp(base + root * size, base + child * size) >= 0)
            return;
        swap_bytes(base + root * size, base + child * size, size);
        root = child;
    }
}

void
qsort(void* base, size_t n, size_t size, int (*cmp)(const void*, const void*))
{
    unsigned char* b = base;
    size_t i;

    if(n < 2)
        return;
    for(i = n / 2; i > 0; i--)
        sift_down(b, i - 1, n, size, cmp);
    for(i = n - 1; i > 0; i--) {
        swap_bytes(b, b + i * size, size);
        sift_down(b, 0, i, size, cmp);
    }
}

void*
bsearch(const void* key, const void* base, size_t n, size_t size,
        int (*cmp)(const void*, const void*))
{
    const unsigned char* b = base;
    size_t lo = 0, hi = n;

    while(lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        int c = cmp(key, b + mid * size);
        if(c == 0)
            return (void*)(b + mid * size);
        if(c < 0)
            hi = mid;
        else
            lo = mid + 1;
    }
    return NULL;
}


/*************************
 ***  printf family    ***
 *************************/

/* Supports %s, %c, %d, %i, %u, %x, %X, %p and %% (with an optional 'l' or
 * 'z' length modifier). That covers every format string in MD4C. */

struct out {
    char* buf;
    size_t size;
    size_t len;
};

static void
out_char(struct out* o, char ch)
{
    if(o->len + 1 < o->size)
        o->buf[o->len] = ch;
    o->len++;
}

static void
out_uint(struct out* o, unsigned long long v, unsigned base, int upper)
{
    const char* digits = upper ? "0123456789ABCDEF" : "0123456789abcdef";
    char tmp[24];
    int i = 0;

    do {
        tmp[i++] = digits[v % base];
        v /= base;
    } while(v != 0);
    while(i > 0)
        out_char(o, tmp[--i]);
}

int
vsnprintf(char* buf, size_t size, const char* fmt, va_list ap)
{
    struct out o = { buf, size, 0 };

    for(; *fmt != '\0'; fmt++) {
        int is_long = 0;

        if(*fmt != '%') {
            out_char(&o, *fmt);
            continue;
        }
        fmt++;
        while(*fmt == 'l'  ||  *fmt == 'z') {
            is_long = 1;
            fmt++;
        }

        switch(*fmt) {
            case 's':
            {
                const char* s = va_arg(ap, const char*);
                if(s == NULL)
                    s = "(null)";
                while(*s)
                    out_char(&o, *s++);
                break;
            }
            case 'c':
                out_char(&o, (char) va_arg(ap, int));
                break;
            case 'd':
            case 'i':
            {
                long long v = is_long ? va_arg(ap, long) : va_arg(ap, int);
                if(v < 0) {
                    out_char(&o, '-');
                    out_uint(&o, (unsigned long long)(-(v + 1)) + 1, 10, 0);
                } else {
                    out_uint(&o, (unsigned long long) v, 10, 0);
                }
                break;
            }
            case 'u':
                out_uint(&o, is_long ? va_arg(ap, unsigned long) : va_arg(ap, unsigned), 10, 0);
                break;
            case 'x':
            case 'X':
                out_uint(&o, is_long ? va_arg(ap, unsigned long) : va_arg(ap, unsigned), 16, *fmt == 'X');
                break;
            case 'p':
                out_char(&o, '0');
                out_char(&o, 'x');
                out_uint(&o, (uintptr_t) va_arg(ap, void*), 16, 0);
                break;
            case '%':
                out_char(&o, '%');
                break;
            case '\0':
                fmt--;
                break;
            default:
                out_char(&o, '%');
                out_char(&o, *fmt);
                break;
        }
    }

    if(o.size > 0)
        o.buf[(o.len < o.size) ? o.len : o.size - 1] = '\0';
    return (int) o.len;
}

int
snprintf(char* buf, size_t size, const char* fmt, ...)
{
    va_list ap;
    int n;
    va_start(ap, fmt);
    n = vsnprintf(buf, size, fmt, ap);
    va_end(ap);
    return n;
}

int
sprintf(char* buf, const char* fmt, ...)
{
    va_list ap;
    int n;
    va_start(ap, fmt);
    n = vsnprintf(buf, (size_t) -1 / 2, fmt, ap);
    va_end(ap);
    return n;
}

/* There are no files in the module. Anything written to stderr/stdout is
 * forwarded to the host through the imported md4c_wasm_log() function. */

struct MD4C_WASM_FILE { int fd; };
static struct MD4C_WASM_FILE stdout_file = { 1 };
static struct MD4C_WASM_FILE stderr_file = { 2 };
FILE* const stdout = &stdout_file;
FILE* const stderr = &stderr_file;

__attribute__((import_module("env"), import_name("md4c_wasm_log")))
extern void md4c_wasm_log(int fd, const char* msg, size_t len);

int
fprintf(FILE* f, const char* fmt, ...)
{
    char buf[512];
    va_list ap;
    int n;

    va_start(ap, fmt);
    n = vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    md4c_wasm_log(f->fd, buf, (n < (int) sizeof(buf)) ? (size_t) n : sizeof(buf) - 1);
    return n;
}
