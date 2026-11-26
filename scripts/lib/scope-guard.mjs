import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getContractPath, matchesAnyGlob, toPosixPath } from './paths.mjs';
import { STATES } from './state-machine.mjs';

/**
 * Scope guard: decide, before a file is written, whether the active execution contract allows it.
 *
 * `verify` already reports a write outside `scope.allow` or inside `scope.protect`, but only after
 * the fact. This is the same rule applied at the moment of the write, for hosts that can call a
 * hook before their file tools run (Claude Code `PreToolUse`). It imports nothing heavy: it runs
 * on every edit.
 *
 * It is a seatbelt, not the control. It sees the host's file tools only, not a shell redirect or a
 * script that writes files, and a broken guard allows the write. `verify` remains the check that counts.
 */

const ENDED_STATES = new Set([STATES.ACCEPTED, STATES.REJECTED, STATES.CLOSED_UNACCEPTED, STATES.ABORTED]);

// Written by CraftHelm scripts only. An agent editing these is editing its own evidence or approval.
const SCRIPT_OWNED_RUN_FILES = [
  'approvals/**',
  'checkpoint.json',
  'evidence-manifest.json',
  'evidence/verification-stamp.json',
  'evidence/tests/**',
  'evidence/rules/**',
];

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Nearest ancestor of `startDir` that holds a `.crafthelm` directory.
 * @param {string} startDir
 * @returns {string|null}
 */
export function findCraftHelmRepo(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.crafthelm'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Runs that have not ended, with the scope of their contract.
 * @param {string} repoRoot
 * @returns {Array<{ run_id: string, task_id: string, allow: string[], protect: string[] }>}
 */
export function listActiveScopes(repoRoot) {
  const runsDir = path.join(repoRoot, '.crafthelm', 'runs');
  if (!fs.existsSync(runsDir)) return [];
  const scopes = [];
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const checkpoint = readJsonSafe(path.join(runsDir, entry.name, 'checkpoint.json'));
    if (!checkpoint?.task_id || ENDED_STATES.has(checkpoint.state)) continue;
    const contract = readJsonSafe(getContractPath(repoRoot, checkpoint.task_id));
    if (!Array.isArray(contract?.scope?.allow)) continue;
    scopes.push({
      run_id: entry.name,
      task_id: checkpoint.task_id,
      allow: contract.scope.allow,
      protect: Array.isArray(contract.scope.protect) ? contract.scope.protect : [],
    });
  }
  return scopes;
}

function isGitIgnored(repoRoot, rel) {
  const res = spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd: repoRoot, windowsHide: true, timeout: 5000 });
  return res.status === 0;
}

/**
 * Decide whether a write to `filePath` may go ahead.
 * @param {{ filePath: string, cwd?: string, isIgnored?: (repoRoot: string, rel: string) => boolean }} params
 * @returns {{ decision: 'allow'|'deny', code: string, reason: string, repo?: string, path?: string }}
 */
export function evaluateWrite(params) {
  const abs = path.resolve(params.cwd ?? process.cwd(), params.filePath);
  const repoRoot = findCraftHelmRepo(path.dirname(abs));
  if (!repoRoot) return { decision: 'allow', code: 'NOT_A_CRAFTHELM_REPO', reason: 'no .crafthelm directory above this path' };
  const rel = toPosixPath(path.relative(repoRoot, abs));
  const allow = (code, reason) => ({ decision: 'allow', code, reason, repo: repoRoot, path: rel });
  const deny = (code, reason) => ({ decision: 'deny', code, reason, repo: repoRoot, path: rel });

  const runFile = /^\.crafthelm\/runs\/([^/]+)\/(.+)$/.exec(rel);
  if (runFile) {
    if (matchesAnyGlob(runFile[2], SCRIPT_OWNED_RUN_FILES)) {
      return deny(
        'SCRIPT_OWNED_ARTIFACT',
        `${rel} is written only by CraftHelm scripts (verify, checkpoint, approve). Run the script instead of editing its output; a human acceptance record is never written by an agent.`,
      );
    }
    return allow('RUN_WORKSPACE', 'run directory file that is not script-owned');
  }

  const scopes = listActiveScopes(repoRoot);
  if (scopes.length === 0) return allow('NO_ACTIVE_RUN', 'no run in progress');

  const protectedBy = scopes.filter((s) => matchesAnyGlob(rel, s.protect));
  if (protectedBy.length > 0) {
    return deny(
      'PROTECTED_PATH',
      `${rel} is under scope.protect of ${protectedBy.map((s) => s.task_id).join(', ')}. verify would fail with PROTECTED_PATH_VIOLATION. Leave it unchanged, or stop and ask for the contract to be re-planned.`,
    );
  }
  if (scopes.some((s) => matchesAnyGlob(rel, s.allow))) return allow('IN_SCOPE', 'inside scope.allow');

  // verify reads the tree through git, so an ignored file is outside what it checks.
  if ((params.isIgnored ?? isGitIgnored)(repoRoot, rel)) return allow('GIT_IGNORED', 'ignored by git, not part of the verified tree');

  const allowed = [...new Set(scopes.flatMap((s) => s.allow))].join(', ');
  return deny(
    'OUT_OF_SCOPE',
    `${rel} is outside scope.allow (${allowed}) of the active run ${scopes.map((s) => s.run_id).join(', ')}. verify would fail with SCOPE_VIOLATION. Keep the change inside the scope, or stop and ask for the contract to be re-planned.`,
  );
}

/**
 * Evaluate a Claude Code `PreToolUse` payload. Tools without a file path are allowed.
 * @param {{ tool_name?: string, tool_input?: { file_path?: string, notebook_path?: string }, cwd?: string }} payload
 */
export function evaluateHookPayload(payload) {
  const filePath = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
  if (typeof filePath !== 'string' || !filePath) {
    return { decision: 'allow', code: 'NO_FILE_PATH', reason: 'tool call carries no file path' };
  }
  return evaluateWrite({ filePath, cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined });
}
