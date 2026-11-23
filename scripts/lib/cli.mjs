import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Parse CLI arguments into flags (`--key val`, `--key=val`, `--flag`) and positionals (`_`).
 * Repeated `--key` flags are collected as arrays when `multiFlags` includes `key`.
 * @param {string[]} argv
 * @param {{ multiFlags?: string[] }} [options]
 * @returns {{ _: string[], [key: string]: unknown }}
 */
export function parseArgs(argv, options = {}) {
  const multi = new Set(options.multiFlags ?? []);
  const result = { _: [] };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      result._.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const eqIdx = token.indexOf('=');
      let key;
      let val;
      if (eqIdx !== -1) {
        key = token.slice(2, eqIdx);
        val = token.slice(eqIdx + 1);
      } else {
        key = token.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          val = next;
          i += 1;
        } else {
          val = true;
        }
      }
      if (multi.has(key)) {
        if (!Array.isArray(result[key])) result[key] = [];
        if (val !== true) result[key].push(val);
      } else {
        result[key] = val;
      }
    } else {
      result._.push(token);
    }
  }
  return result;
}

/**
 * Determine whether the current ES module is the executed entrypoint (case-insensitive on Windows).
 * @param {string} importMetaUrl
 * @returns {boolean}
 */
export function isMainModule(importMetaUrl) {
  if (!process.argv[1]) return false;
  const selfPath = path.resolve(fileURLToPath(importMetaUrl));
  const argPath = path.resolve(process.argv[1]);
  if (process.platform === 'win32') {
    return selfPath.toLowerCase() === argPath.toLowerCase();
  }
  return selfPath === argPath;
}

/**
 * Check whether `--help` or `-h` was requested before any `--` separator.
 * @param {string[]} [argv]
 * @returns {boolean}
 */
export function isHelpRequested(argv = []) {
  for (const token of argv) {
    if (token === '--') break;
    if (token === '--help' || token === '-h') return true;
  }
  return false;
}
