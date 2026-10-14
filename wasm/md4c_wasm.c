/*
 * WebAssembly entry points for MD4C.
 *
 * The module is buffer based: the host copies Markdown into linear memory,
 * calls md4c_wasm_to_html(), and copies the resulting HTML back out. File
 * access (reading .md, writing .html) is the host's job; in the browser that
 * is wasm/js/md4c-fs.js, which stores files through storagesdk.
 *
 * Typical call sequence from JavaScript:
 *
 *   md4c_wasm_reset();
 *   in = md4c_wasm_alloc(n);            // copy n bytes of UTF-8 to `in`
 *   if(md4c_wasm_to_html(in, n, parser_flags, renderer_flags) == 0)
 *       read md4c_wasm_output_len() bytes at md4c_wasm_output_ptr();
 */

#include <stdlib.h>
#include <string.h>

#include "md4c-html.h"


#define WASM_EXPORT(name)   __attribute__((export_name(#name)))

void md4c_wasm_heap_reset(void);

struct membuffer {
    char* data;
    MD_SIZE asize;
    MD_SIZE size;
    int failed;
};

static struct membuffer output;

static void
membuf_append(const MD_CHAR* text, MD_SIZE size, void* userdata)
{
    struct membuffer* buf = (struct membuffer*) userdata;

    if(buf->failed)
        return;

    if(buf->size + size > buf->asize) {
        MD_SIZE new_asize = buf->asize + buf->asize / 2 + size + 64;
        char* new_data = (char*) realloc(buf->data, new_asize);
        if(new_data == NULL) {
            buf->failed = 1;
            return;
        }
        buf->data = new_data;
        buf->asize = new_asize;
    }

    memcpy(buf->data + buf->size, text, size);
    buf->size += size;
}

WASM_EXPORT(md4c_wasm_reset) void
md4c_wasm_reset_export(void)
{
    md4c_wasm_heap_reset();
    memset(&output, 0, sizeof(output));
}

WASM_EXPORT(md4c_wasm_alloc) void*
md4c_wasm_alloc(unsigned size)
{
    return malloc(size);
}

WASM_EXPORT(md4c_wasm_to_html) int
md4c_wasm_to_html(const char* input, unsigned input_size,
                  unsigned parser_flags, unsigned renderer_flags)
{
    int ret;

    memset(&output, 0, sizeof(output));
    /* HTML is typically a bit longer than its Markdown source. */
    output.asize = input_size + input_size / 4 + 64;
    output.data = (char*) malloc(output.asize);
    if(output.data == NULL)
        return -1;

    ret = md_html(input, input_size, membuf_append, &output,
                  parser_flags, renderer_flags);
    if(ret != 0  ||  output.failed)
        return -1;
    return 0;
}

WASM_EXPORT(md4c_wasm_output_ptr) const char*
md4c_wasm_output_ptr(void)
{
    return output.data;
}

WASM_EXPORT(md4c_wasm_output_len) unsigned
md4c_wasm_output_len(void)
{
    return output.size;
}
