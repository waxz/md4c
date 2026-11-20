#!/usr/bin/env node
// A stdin -> stdout stand-in for md2html, backed by the wasm build. It lets
// the regular test suite run against md4c.wasm:
//
//   python3 test/run-testsuite.py -s test/spec.txt -p wasm/test/md2html-wasm.mjs

import { readFileSync } from 'node:fs';
import { Dialect, Flags, HtmlFlags, loadMd4c } from '../js/md4c.js';

const OPTIONS = {
  '--commonmark': [Dialect.COMMONMARK, 0],
  '--github': [Dialect.GITHUB, 0],
  '--fadmonitions': [Flags.ADMONITIONS, 0],
  '--fverbatim-entities': [0, HtmlFlags.VERBATIM_ENTITIES],
  '--fhighlight': [Flags.HIGHLIGHT, 0],
  '--finsert': [Flags.INSERT, 0],
  '--fpermissive-atx-headers': [Flags.PERMISSIVEATXHEADERS, 0],
  '--fno-indented-code': [Flags.NOINDENTEDCODEBLOCKS, 0],
  '--fno-html-blocks': [Flags.NOHTMLBLOCKS, 0],
  '--fno-html-spans': [Flags.NOHTMLSPANS, 0],
  '--fno-html': [Flags.NOHTML, 0],
  '--fcollapse-whitespace': [Flags.COLLAPSEWHITESPACE, 0],
  '--fpermissive-url-autolinks': [Flags.PERMISSIVEURLAUTOLINKS, 0],
  '--fpermissive-www-autolinks': [Flags.PERMISSIVEWWWAUTOLINKS, 0],
  '--fpermissive-email-autolinks': [Flags.PERMISSIVEEMAILAUTOLINKS, 0],
  '--fpermissive-autolinks': [Flags.PERMISSIVEAUTOLINKS, 0],
  '--ftables': [Flags.TABLES, 0],
  '--fspoilers': [Flags.SPOILERS, 0],
  '--fstrikethrough': [Flags.STRIKETHROUGH, 0],
  '--fsuperscripts': [Flags.SUPERSCRIPTS, 0],
  '--fsubscripts': [Flags.SUBSCRIPTS, 0],
  '--flatex-math': [Flags.LATEXMATHSPANS, 0],
  '--fwiki-links': [Flags.WIKILINKS, 0],
  '--ftasklists': [Flags.TASKLISTS, 0],
  '--funderline': [Flags.UNDERLINE, 0],
  '--ffootnotes': [Flags.FOOTNOTES, 0],
  '--fhard-soft-breaks': [Flags.HARD_SOFT_BREAKS, 0],
  '--fpreserve-blank-lines': [Flags.PRESERVEBLANKLINES, 0],
  '--xhtml': [0, HtmlFlags.XHTML],
};

let parserFlags = 0;
let rendererFlags = HtmlFlags.SKIP_UTF8_BOM;
for (const arg of process.argv.slice(2)) {
  const opt = OPTIONS[arg];
  if (!opt) {
    process.stderr.write(`md2html-wasm: unsupported option ${arg}\n`);
    process.exit(2);
  }
  parserFlags |= opt[0];
  rendererFlags |= opt[1];
}

const md4c = await loadMd4c(new URL('../dist/md4c.wasm', import.meta.url), {
  onLog: (_fd, msg) => process.stderr.write(`${msg}\n`),
});
process.stdout.write(md4c.toHtml(readFileSync(0), { parserFlags, rendererFlags }));
