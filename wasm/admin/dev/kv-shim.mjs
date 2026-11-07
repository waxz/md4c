// A stand-in for a Workers KV namespace binding, for tests and local
// development: get(key[, type]) / put(key, value) / delete(key), kept in
// memory, or in a JSON file when `file` is given (so it survives restarts).

import { readFileSync, writeFileSync } from 'node:fs';

export function kvNamespace(file) {
  let data = {};
  if (file) {
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch {}
  }
  const save = () => file && writeFileSync(file, JSON.stringify(data, null, 2));
  return {
    async get(key, type) {
      const v = Object.hasOwn(data, key) ? data[key] : null;
      return v !== null && (type === 'json' || type?.type === 'json') ? JSON.parse(v) : v;
    },
    async put(key, value) {
      data[key] = String(value);
      save();
    },
    async delete(key) {
      delete data[key];
      save();
    },
  };
}
