import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getContractPath, toPosixPath } from './paths.mjs';

export const INTERVIEW_DOCS = ['requirements.md', 'decisions.md', 'open_questions.md', 'acceptance.md', 'interview_questions.md'];

export function writeAtomic(file, text) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, text, 'utf8');
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

// SQLite's OS lock is released even if the initializing CLI is interrupted.
// Keep the lock database: unlinking it could give two callers different locks.
export function withArtifactLock(file, action) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    return action();
  } finally {
    db.close();
  }
}

function receiptDir(repo) {
  return path.join(repo, '.crafthelm', 'runs', '.interviews');
}

export function withTaskWrite(repo, taskId, action) {
  return withArtifactLock(path.join(receiptDir(repo), `${taskId}.sqlite`), action);
}

function readOptionalJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return null;
    throw err;
  }
}

export function readTaskReceipt(repo, taskId) {
  const file = path.join(receiptDir(repo), `${taskId}.json`);
  const receipt = readOptionalJson(file);
  return typeof receipt?.docs_dir === 'string' && receipt.docs && typeof receipt.docs === 'object' ? receipt : null;
}

export function writeTaskReceipt(repo, taskId, receipt) {
  fs.mkdirSync(receiptDir(repo), { recursive: true });
  writeAtomic(path.join(receiptDir(repo), `${taskId}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
}

// Only hashes recorded for the producing task's contract and five interview documents
// are eligible. Never import scope, source, or arbitrary paths from a sibling run.
export function peerArtifactHashes(repo, currentTask) {
  const hashes = new Map();
  const dir = receiptDir(repo);
  const runs = path.dirname(dir);
  if (!fs.existsSync(runs)) return hashes;
  const contractsWithReceipts = new Set();
  for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\.json$/.test(file)) continue;
    const taskId = file.slice(0, -5);
    if (taskId === currentTask) continue;
    const receipt = readTaskReceipt(repo, taskId);
    if (!receipt) continue;
    contractsWithReceipts.add(taskId);
    hashes.set(`.crafthelm/contracts/${file}`, receipt.contract);
    for (const name of INTERVIEW_DOCS) {
      if (receipt.docs[name]) hashes.set(toPosixPath(path.join(receipt.docs_dir, name)), receipt.docs[name]);
    }
  }
  // Existing installations have no receipts. Their frozen task-local baselines
  // still attest to the default document paths and the contract for that run.
  for (const entry of fs.readdirSync(runs, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.interviews') continue;
    const file = path.join(runs, entry.name, 'checkpoint.json');
    const cp = readOptionalJson(file);
    if (!cp?.task_id || cp.task_id === currentTask || contractsWithReceipts.has(cp.task_id)) continue;
    const contract = toPosixPath(path.relative(repo, getContractPath(repo, cp.task_id)));
    for (const rel of [contract, ...INTERVIEW_DOCS.map(name => `docs/tasks/${cp.task_id}/${name}`)]) {
      if (cp.baseline_crafthelm_files?.[rel]) hashes.set(rel, cp.baseline_crafthelm_files[rel]);
    }
  }
  return hashes;
}
