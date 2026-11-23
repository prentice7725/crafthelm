import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Compute SHA-256 hex digest of a Buffer or Uint8Array.
 * @param {Buffer|Uint8Array} buffer
 * @returns {string}
 */
export function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Compute SHA-256 hex digest of a UTF-8 string.
 * @param {string} text
 * @returns {string}
 */
export function sha256Text(text) {
  return sha256Buffer(Buffer.from(String(text), 'utf8'));
}

/**
 * Compute SHA-256 hex digest of a file on disk.
 * @param {string} filePath
 * @returns {string}
 */
export function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

/**
 * Serialize a value into deterministic JSON with sorted object keys.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const entries = keys
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Compute SHA-256 hex digest of a canonicalized JSON value.
 * @param {unknown} value
 * @returns {string}
 */
export function sha256CanonicalJson(value) {
  return sha256Text(canonicalJson(value));
}

/**
 * Collect sorted POSIX relative file paths under a directory.
 * Excludes volatile runtime directories like `.git` and `.in_use`.
 * @param {string} baseDir
 * @param {{ excludeDirs?: string[], excludeFiles?: string[] }} [options]
 * @returns {string[]}
 */
export function collectRelativeFiles(baseDir, options = {}) {
  const excludeDirs = new Set(options.excludeDirs ?? ['.git', '.in_use', 'node_modules']);
  const excludeFiles = new Set(options.excludeFiles ?? []);
  const results = [];

  function walk(currentDir, relPrefix) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!excludeDirs.has(entry.name)) {
          walk(path.join(currentDir, entry.name), rel);
        }
      } else if (entry.isFile()) {
        if (!excludeFiles.has(entry.name)) {
          results.push(rel);
        }
      }
    }
  }

  if (fs.existsSync(baseDir)) {
    walk(baseDir, '');
  }
  return results.sort();
}

/**
 * Compute deterministic per-file hashes and aggregate digest for a file set.
 * @param {string} baseDir
 * @param {string[]} relPaths
 * @returns {{ filesDigest: string, fileHashes: Record<string, string> }}
 */
export function hashFileSet(baseDir, relPaths) {
  const sorted = [...new Set(relPaths.map((p) => p.replace(/\\/g, '/')))].sort();
  const fileHashes = {};
  const lines = [];
  for (const rel of sorted) {
    const abs = path.join(baseDir, rel);
    const digest = sha256File(abs);
    fileHashes[rel] = digest;
    lines.push(`${rel}:${digest}\n`);
  }
  return {
    filesDigest: sha256Text(lines.join('')),
    fileHashes,
  };
}
