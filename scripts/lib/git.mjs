import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from './exec.mjs';
import { sha256File, sha256Text } from './crypto.mjs';
import { toPosixPath } from './paths.mjs';

const EXCLUDED_SNAPSHOT_DIRS = ['.git', '.crafthelm/runs', 'node_modules'];

function isExcludedFromSnapshot(posixRel) {
  const clean = toPosixPath(posixRel);
  if (EXCLUDED_SNAPSHOT_DIRS.some((dir) => clean === dir || clean.startsWith(`${dir}/`))) {
    return true;
  }
  return clean.startsWith('.crafthelm/memory/index.sqlite');
}

/**
 * Execute a git command inside `cwd`.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{ exitCode: number, stdout: string, stderr: string }}
 */
export function runGit(cwd, args) {
  return runCommand('git', args, { cwd });
}

/**
 * Check whether `cwd` is inside a git repository.
 * @param {string} cwd
 * @returns {boolean}
 */
export function isGitRepo(cwd) {
  const res = runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return res.exitCode === 0 && res.stdout.trim() === 'true';
}

/**
 * Resolve HEAD commit SHA (or 'UNBORN' if no commits exist yet).
 * @param {string} cwd
 * @returns {string}
 */
export function getGitHead(cwd) {
  const res = runGit(cwd, ['rev-parse', 'HEAD']);
  if (res.exitCode !== 0) {
    return 'UNBORN';
  }
  return res.stdout.trim();
}

/**
 * Resolve git tree hash for a ref (defaults to HEAD).
 * @param {string} cwd
 * @param {string} [ref]
 * @returns {string}
 */
export function getGitTreeHash(cwd, ref = 'HEAD') {
  const res = runGit(cwd, ['rev-parse', `${ref}^{tree}`]);
  if (res.exitCode !== 0) {
    return 'UNBORN_TREE';
  }
  return res.stdout.trim();
}

/**
 * List untracked, non-ignored files in POSIX format.
 * @param {string} cwd
 * @returns {string[]}
 */
export function getUntrackedFiles(cwd) {
  const res = runGit(cwd, ['ls-files', '--others', '--exclude-standard']);
  if (res.exitCode !== 0) return [];
  return res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(toPosixPath)
    .filter((p) => !isExcludedFromSnapshot(p))
    .sort();
}

/**
 * List all changed files relative to `baseRef` (working tree + staged + untracked).
 * Excludes `.crafthelm/runs/` runtime artifacts.
 * @param {string} cwd
 * @param {string} [baseRef]
 * @returns {string[]}
 */
export function getChangedFiles(cwd, baseRef = 'HEAD') {
  const files = new Set();
  if (baseRef && baseRef !== 'UNBORN') {
    const diffRes = runGit(cwd, ['diff', '--name-only', baseRef]);
    if (diffRes.exitCode === 0) {
      for (const line of diffRes.stdout.split(/\r?\n/)) {
        const clean = toPosixPath(line.trim());
        if (clean && !isExcludedFromSnapshot(clean)) {
          files.add(clean);
        }
      }
    }
  }
  const stagedRes = runGit(cwd, ['diff', '--cached', '--name-only']);
  if (stagedRes.exitCode === 0) {
    for (const line of stagedRes.stdout.split(/\r?\n/)) {
      const clean = toPosixPath(line.trim());
      if (clean && !isExcludedFromSnapshot(clean)) {
        files.add(clean);
      }
    }
  }
  for (const untracked of getUntrackedFiles(cwd)) {
    files.add(untracked);
  }
  return [...files].sort();
}

/**
 * Get unified diff text relative to `baseRef`, plus untracked file markers.
 * @param {string} cwd
 * @param {string} [baseRef]
 * @returns {string}
 */
export function getDiffText(cwd, baseRef = 'HEAD') {
  const parts = [];
  if (baseRef && baseRef !== 'UNBORN') {
    const diffRes = runGit(cwd, ['diff', baseRef, '--', '.', ':!.crafthelm/runs', ':!.crafthelm/memory/index.sqlite*']);
    if (diffRes.exitCode === 0 && diffRes.stdout.trim()) {
      parts.push(diffRes.stdout.replace(/\r\n/g, '\n'));
    }
  }
  const untracked = getUntrackedFiles(cwd);
  for (const rel of untracked) {
    const abs = path.join(cwd, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      const content = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
      // Same shape as `git diff` for a staged new file, hunk header included, so line-numbered
      // consumers (lite size limits, mutation probe, calibration) count it before and after `git add`.
      const lines = content.split('\n');
      if (content.endsWith('\n')) lines.pop();
      const hunk = lines.length > 0 ? `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n` : '';
      parts.push(`diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n${hunk}`);
    }
  }
  return parts.join('\n');
}

/**
 * Read a file strictly from an immutable git ref (e.g., approved `policy_base_ref`).
 * Never falls back to working tree edits.
 * @param {string} cwd
 * @param {string} ref
 * @param {string} relPath
 * @returns {{ exists: boolean, content: string|null, error?: string }}
 */
export function readFileAtRef(cwd, ref, relPath) {
  if (!ref || ref === 'UNBORN') {
    return { exists: false, content: null, error: 'Base ref is UNBORN' };
  }
  const posixPath = toPosixPath(relPath);
  const res = runGit(cwd, ['show', `${ref}:${posixPath}`]);
  if (res.exitCode !== 0) {
    return { exists: false, content: null, error: res.stderr.trim() || `Not found at ${ref}:${posixPath}` };
  }
  return { exists: true, content: res.stdout.replace(/\r\n/g, '\n') };
}

/**
 * Compute an immutable snapshot digest of the target repo's current working state.
 * Binds `HEAD` + tracked/untracked/deleted files while excluding `.crafthelm/runs/`, `.git/`, and `node_modules/`.
 * @param {string} cwd
 * @returns {string}
 */
export function computeSnapshotDigest(cwd) {
  const repoRoot = path.resolve(cwd);
  const head = isGitRepo(repoRoot) ? getGitHead(repoRoot) : 'NO_GIT';
  const fileSet = new Set();

  if (isGitRepo(repoRoot)) {
    const trackedRes = runGit(repoRoot, ['ls-files', '--cached', '--others', '--exclude-standard']);
    if (trackedRes.exitCode === 0) {
      for (const line of trackedRes.stdout.split(/\r?\n/)) {
        const clean = toPosixPath(line.trim());
        if (clean && !isExcludedFromSnapshot(clean)) {
          fileSet.add(clean);
        }
      }
    }
  }

  // Also walk filesystem in case untracked hidden/explicit files are missed or non-git directory
  walkWorkspaceFiles(repoRoot, '', fileSet);

  const sorted = [...fileSet].sort();
  const lines = [`HEAD:${head}\n`];
  for (const rel of sorted) {
    const abs = path.join(repoRoot, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      lines.push(`${rel}:${sha256File(abs)}\n`);
    } else {
      lines.push(`${rel}:DELETED\n`);
    }
  }
  return sha256Text(lines.join(''));
}

function walkWorkspaceFiles(rootDir, relPrefix, fileSet) {
  if (!fs.existsSync(rootDir)) return;
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (isExcludedFromSnapshot(rel)) continue;
    if (entry.isDirectory()) {
      walkWorkspaceFiles(path.join(rootDir, entry.name), rel, fileSet);
    } else if (entry.isFile()) {
      fileSet.add(toPosixPath(rel));
    }
  }
}

/**
 * Extract changed symbol names from unified diff hunk headers and added/removed function/class/export lines.
 * @param {string} diffText
 * @returns {string[]}
 */
export function extractChangedSymbols(diffText) {
  const symbols = new Set();
  const lines = String(diffText || '').split(/\r?\n/);
  for (const line of lines) {
    const hunkMatch = line.match(/^@@[^@]+@@\s*(.+)$/);
    if (hunkMatch) {
      const tokens = hunkMatch[1].match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
      for (const t of tokens) symbols.add(t);
    }
    if (/^[+-](?![+-]{2})/.test(line)) {
      const defMatch = line.match(
        /^[+-]\s*(?:export\s+|pub(?:\([^)]*\))?\s+|public\s+|private\s+|protected\s+|internal\s+|override\s+|suspend\s+|open\s+|static\s+|final\s+|abstract\s+|async\s+)*(?:function|class|const|let|var|def|fn|func|fun|interface|record|struct|enum|trait|impl|module|type)\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)/,
      );
      if (defMatch) symbols.add(defMatch[1]);
    }
  }
  return [...symbols].sort();
}
