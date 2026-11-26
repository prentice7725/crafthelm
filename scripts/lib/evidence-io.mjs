import fs from 'node:fs';
import path from 'node:path';
import { sha256File } from './crypto.mjs';
import { writeAtomic } from './task-artifacts.mjs';

/**
 * Evidence files: how command output is stored, and how a later step checks it is still what ran.
 *
 * Output is written by the verification script, never by the agent, with secret-looking values
 * blanked first so a run directory can be shared. The hash of each stored log goes into the evidence
 * manifest; review-package and approve re-hash the logs and refuse a mismatch.
 *
 * Limit: the manifest lives in the same writable run directory as the logs. The hashes catch an
 * edited log, not someone who rewrites the log and the manifest together.
 */

/**
 * Write JSON through a temp file and rename, so an interrupted write never leaves half a file.
 * @param {string} filePath
 * @param {unknown} data
 */
export function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

const SECRET_ENV_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL/i;
const MIN_SECRET_LENGTH = 8;

// Token shapes that are secrets wherever they appear, whether or not they came from the environment.
const KNOWN_TOKEN_SHAPES = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,}/g],
  ['github-token', /\bgithub_pat_[A-Za-z0-9_]{40,}/g],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
];

/**
 * Blank secret-looking values in command output before it is stored as evidence.
 * Covers the values of environment variables whose names look like credentials, and a few
 * well-known token shapes. It is a net, not a guarantee: a secret in neither set passes through.
 * @param {string} text
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ text: string, count: number }}
 */
export function redactSecrets(text, env = process.env) {
  let out = String(text ?? '');
  let count = 0;
  const fromEnv = Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === 'string' && value.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [name, value] of fromEnv) {
    const parts = out.split(value);
    if (parts.length > 1) {
      count += parts.length - 1;
      out = parts.join(`[REDACTED:${name}]`);
    }
  }
  for (const [label, shape] of KNOWN_TOKEN_SHAPES) {
    out = out.replace(shape, () => {
      count += 1;
      return `[REDACTED:${label}]`;
    });
  }
  return { text: out, count };
}

/**
 * Store one command output stream under the run directory.
 * @param {string} runDir
 * @param {string} rel run-relative path
 * @param {string} text
 * @returns {{ sha256: string, redactions: number }}
 */
export function storeCommandOutput(runDir, rel, text) {
  const abs = path.join(runDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const redacted = redactSecrets(text);
  fs.writeFileSync(abs, redacted.text, 'utf8');
  return { sha256: sha256File(abs), redactions: redacted.count };
}

/**
 * Re-hash the stored logs of every check that recorded a hash.
 * Checks from manifests written before hashes existed carry none and are not compared.
 * @param {string} runDir
 * @param {{ checks?: Array<{ id: string, stdout_file?: string, stderr_file?: string, stdout_sha256?: string, stderr_sha256?: string }> }} manifest
 * @returns {string[]} one line per log that is missing or no longer matches
 */
export function findAlteredEvidenceLogs(runDir, manifest) {
  const altered = [];
  for (const check of manifest.checks ?? []) {
    for (const stream of ['stdout', 'stderr']) {
      const rel = check[`${stream}_file`];
      const expected = check[`${stream}_sha256`];
      if (!rel || !expected) continue;
      const abs = path.join(runDir, rel);
      if (!fs.existsSync(abs)) {
        altered.push(`${check.id}: ${rel} is missing`);
      } else if (sha256File(abs) !== expected) {
        altered.push(`${check.id}: ${rel} changed after verification`);
      }
    }
  }
  return altered;
}
