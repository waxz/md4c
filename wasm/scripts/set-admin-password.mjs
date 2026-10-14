#!/usr/bin/env node
// Set (or change) the blog owner's admin password.
//
//   node scripts/set-admin-password.mjs             # prompts, input hidden
//   printf '%s' "$PW" | node scripts/set-admin-password.mjs   # from stdin
//
// Stores only a salted scrypt hash in $BLOG_DATA_DIR/admin.json (mode 600).
// Restart the server afterwards to log out existing sessions.

import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, writeAdminRecord } from '../server/auth.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = resolve(process.env.BLOG_DATA_DIR ?? join(root, 'data'));

async function readHidden(prompt) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    let data = '';
    for await (const chunk of stdin) data += chunk;
    return data.replace(/\r?\n$/, '');
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((done) => {
    let pw = '';
    stdin.on('data', function onData(ch) {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        stdout.write('\n');
        done(pw);
      } else if (ch === '\u0003') {
        process.exit(130);
      } else if (ch === '\u007f') {
        pw = pw.slice(0, -1);
      } else {
        pw += ch;
      }
    });
  });
}

const password = await readHidden('New admin password: ');
if (password.length < 12) {
  console.error('Password must be at least 12 characters.');
  process.exit(1);
}
if (process.stdin.isTTY && (await readHidden('Repeat password: ')) !== password) {
  console.error('Passwords do not match.');
  process.exit(1);
}
await mkdir(dataDir, { recursive: true });
await writeAdminRecord(join(dataDir, 'admin.json'), await hashPassword(password));
console.log(`Admin password saved to ${join(dataDir, 'admin.json')}`);
