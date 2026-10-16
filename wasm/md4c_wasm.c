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
 *
 * With MD4C_WASM_FLAG_SOURCE_POS in renderer_flags (the admin's editor
 * preview uses it), the opening tag of every block element carries
 * data-src="<byte offset>": where that block's text starts in the input,
 * so the preview can scroll along with the Markdown and find the line of
 * a clicked paragraph. Published pages are rendered without it.
 */

#include <stdlib.h>
#include <string.h>

/* The HTML renderer's internals, so its block callback can be wrapped. */
#include "md4c-html.c"


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

/* ---- Source positions ---- */

#define MD4C_WASM_FLAG_SOURCE_POS   0x10000
#define NO_POS                      0xffffffffu

/* Per block, in the order the parser enters them: where its text starts. */
static unsigned* src_pos;
static unsigned src_count;
static unsigned src_cap;
static unsigned src_next;      /* the next block to annotate (2nd pass) */
static unsigned src_base;      /* bytes skipped before the parsed input (BOM) */

/* Blocks entered but without a position yet (1st pass). */
#define MAX_OPEN 64
static unsigned open_blocks[MAX_OPEN];
static unsigned n_open;
static const MD_CHAR* pass_doc;
static MD_SIZE pass_size;

static int
pos_enter_block(MD_BLOCKTYPE type, void* detail, void* userdata)
{
    (void) type; (void) detail; (void) userdata;
    if(src_count >= src_cap) {
        unsigned cap = src_cap ? src_cap * 2 : 256;
        unsigned* p = (unsigned*) realloc(src_pos, cap * sizeof(unsigned));
        if(p == NULL)
            return -1;
        src_pos = p;
        src_cap = cap;
    }
    src_pos[src_count] = NO_POS;
    if(n_open < MAX_OPEN)
        open_blocks[n_open] = src_count;
    n_open++;
    src_count++;
    return 0;
}

static int
pos_leave_block(MD_BLOCKTYPE type, void* detail, void* userdata)
{
    (void) type; (void) detail; (void) userdata;
    if(n_open > 0)
        n_open--;
    return 0;
}

static int
pos_span(MD_SPANTYPE type, void* detail, void* userdata)
{
    (void) type; (void) detail; (void) userdata;
    return 0;
}

static int
pos_text(MD_TEXTTYPE type, const MD_CHAR* text, MD_SIZE size, void* userdata)
{
    unsigned i, n, off;
    (void) type; (void) size; (void) userdata;
    /* Most text is a pointer into the input; anything else (a newline or
     * replacement character made up by the parser) tells nothing. */
    if(text < pass_doc  ||  text >= pass_doc + pass_size)
        return 0;
    off = src_base + (unsigned)(text - pass_doc);
    n = n_open < MAX_OPEN ? n_open : MAX_OPEN;
    for(i = 0; i < n; i++) {
        if(src_pos[open_blocks[i]] == NO_POS)
            src_pos[open_blocks[i]] = off;
    }
    return 0;
}

/* Insert ` data-src="N"` before the first '>' written since `from`. */
static void
annotate_tag(MD_SIZE from, unsigned pos)
{
    char attr[32];
    MD_SIZE i, len;
    unsigned v = pos, digits = 1;
    char* p;

    for(i = from; i < output.size; i++) {
        if(output.data[i] == '>')
            break;
    }
    if(i >= output.size  ||  output.failed)
        return;
    while(v >= 10) { v /= 10; digits++; }
    memcpy(attr, " data-src=\"", 11);
    v = pos;
    for(p = attr + 11 + digits - 1; p >= attr + 11; p--) { *p = (char)('0' + v % 10); v /= 10; }
    attr[11 + digits] = '"';
    len = 12 + digits;

    membuf_append(attr, len, &output);      /* grows the buffer if needed */
    if(output.failed)
        return;
    memmove(output.data + i + len, output.data + i, output.size - len - i);
    memcpy(output.data + i, attr, len);
}

static int
annotated_enter_block(MD_BLOCKTYPE type, void* detail, void* userdata)
{
    unsigned k = src_next++;
    MD_SIZE before = output.size;
    int ret = enter_block_callback(type, detail, userdata);

    switch(type) {
        case MD_BLOCK_DOC:
        case MD_BLOCK_HTML:
        case MD_BLOCK_BLANK:
        case MD_BLOCK_FOOTNOTE_DEF_SECTION:
            break;      /* no element of its own, or raw HTML */
        default:
            if(ret == 0  &&  k < src_count  &&  src_pos[k] != NO_POS  &&  output.size > before)
                annotate_tag(before, src_pos[k]);
            break;
    }
    return ret;
}

/* md_html(), with each block's opening tag annotated (2 passes). */
static int
md_html_with_positions(const MD_CHAR* input, MD_SIZE input_size, unsigned parser_flags, unsigned renderer_flags)
{
    MD_HTML render = { membuf_append, &output, renderer_flags, 0, { 0 } };
    MD_PARSER pos_parser = { 0, parser_flags, pos_enter_block, pos_leave_block, pos_span, pos_span, pos_text, NULL, NULL };
    MD_PARSER parser = {
        0, parser_flags, annotated_enter_block, leave_block_callback, enter_span_callback,
        leave_span_callback, text_callback, debug_log_callback, NULL
    };
    int i, ret;

    for(i = 0; i < 256; i++) {
        unsigned char ch = (unsigned char) i;
        if(strchr("\"&'<>", ch) != NULL)
            render.escape_map[i] |= NEED_HTML_ESC_FLAG;
        if(!ISALNUM(ch)  &&  strchr("~-_.+!*(),%#@?=;:/$", ch) == NULL)
            render.escape_map[i] |= NEED_URL_ESC_FLAG;
    }
    src_base = 0;
    if(renderer_flags & MD_HTML_FLAG_SKIP_UTF8_BOM  &&  input_size >= 3  &&
       memcmp(input, "\xef\xbb\xbf", 3) == 0) {
        input += 3;
        input_size -= 3;
        src_base = 3;
    }

    src_pos = NULL;
    src_count = src_cap = src_next = n_open = 0;
    pass_doc = input;
    pass_size = input_size;
    ret = md_parse(input, input_size, &pos_parser, NULL);
    if(ret != 0)
        return ret;
    return md_parse(input, input_size, &parser, (void*) &render);
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

    if(renderer_flags & MD4C_WASM_FLAG_SOURCE_POS)
        ret = md_html_with_positions(input, input_size, parser_flags,
                                     renderer_flags & ~MD4C_WASM_FLAG_SOURCE_POS);
    else
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
