import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CRAFTHELM_ROOT, getContractPath, matchesAnyGlob, toPosixPath } from './paths.mjs';
import { STATES } from './state-machine.mjs';

/**
 * Scope guard: decide, before a file is written, whether the active execution contract allows it.
 *
 * `verify` already reports a write outside `scope.allow` or inside `scope.protect`, but only after
 * the fact. This is the same rule applied at the moment of the write, for hosts that can call a
 * hook before their file tools run (Claude Code `PreToolUse`). It imports nothing heavy: it runs
 * on every edit.
 *
 * Two things are closed whether or not a run is active: the run directories, apart from the files
 * an agent is meant to author there, and the files that decide what the agent may do (contracts and
 * the Claude settings that hold the permission rules and this hook).
 *
 * It is a seatbelt, not the control. It sees the host's file tools only, not a shell redirect or a
 * script that writes files, and a broken guard allows the write. `verify` remains the check that counts.
 */

const ENDED_STATES = new Set([STATES.ACCEPTED, STATES.REJECTED, STATES.CLOSED_UNACCEPTED, STATES.ABORTED]);

// A run directory is written by CraftHelm scripts: checkpoint, evidence, delegation records, reports,
// approvals. An agent editing those is editing its own evidence or approval, so the directory is
// closed by default and only the files an agent is meant to author are listed here.
const AGENT_AUTHORED_RUN_FILES = [
  // The advisory reviewer's findings, read by verify.
  'evidence/review.json',
  // Hand-over files for a script to read: a worker result packet for `delegate record`, a report draft.
  'inbox/**',
];

// Files that decide what an agent may do. They stay closed to file tools whether or not a run is
// active: a contract is approved through `contract approve` (which Claude Code asks a person about),
// and the settings files hold the permission rules and this hook itself.
const CONTROL_FILES = [
  '.crafthelm/contracts/**',
  '.claude/settings.json',
  '.claude/settings.local.json',
  // Policy that verify and the approval gate read from the protected base ref. Closed here so an
  // agent-edited copy cannot slip into the commit that later becomes that base ref.
  '.crafthelm/approvers.json',
  '.crafthelm/config.json',
  '.crafthelm/skills.lock.json',
];

/**
 * Drop the parts of a Windows path that name the same file under another spelling: trailing dots
 * and spaces on a segment, and an alternate data stream suffix (`settings.json::$DATA`).
 */
function stripWindowsAliases(abs) {
  if (process.platform !== 'win32') return abs;
  const { root } = path.parse(abs);
  const segments = abs.slice(root.length).split(/[\\/]+/)
    .map((segment) => segment.split(':')[0].replace(/[. ]+$/, ''))
    .filter(Boolean);
  return path.join(root, ...segments);
}

/**
 * The path as the disk spells it: the deepest existing ancestor is resolved through the filesystem
 * (true letter case, long names instead of 8.3 short names, symlinks followed), and the part that
 * does not exist yet is appended unchanged.
 */
function canonicalPath(abs) {
  let existing = abs;
  const pending = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return abs;
    pending.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return path.join(fs.realpathSync.native(existing), ...pending);
  } catch {
    return abs;
  }
}

// On a case-insensitive filesystem `.claude/Settings.json` is `.claude/settings.json`.
function isCaseInsensitive(repoRoot) {
  return fs.existsSync(path.join(repoRoot, '.CRAFTHELM')) && fs.existsSync(path.join(repoRoot, '.crafthelm'));
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Nearest ancestor of `startDir` that CraftHelm has set up: a `.crafthelm` directory holding a config,
 * contracts or runs. A bare `.crafthelm` (a home directory that only keeps an approver key) is not one.
 * @param {string} startDir
 * @returns {string|null}
 */
export function findCraftHelmRepo(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const base = path.join(dir, '.crafthelm');
    if (['config.json', 'contracts', 'runs'].some((name) => fs.existsSync(path.join(base, name)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Runs that have not ended, with the scope of their contract.
 * @param {string} repoRoot
 * @returns {Array<{ run_id: string, task_id: string, state: string, allow: string[], protect: string[] }>}
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
      state: checkpoint.state,
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
  const abs = canonicalPath(stripWindowsAliases(path.resolve(params.cwd ?? process.cwd(), params.filePath)));
  const repoRoot = findCraftHelmRepo(path.dirname(abs));
  if (!repoRoot) return { decision: 'allow', code: 'NOT_A_CRAFTHELM_REPO', reason: 'no .crafthelm directory above this path' };
  const rel = toPosixPath(path.relative(repoRoot, abs));
  const allow = (code, reason) => ({ decision: 'allow', code, reason, repo: repoRoot, path: rel });
  const deny = (code, reason) => ({ decision: 'deny', code, reason, repo: repoRoot, path: rel });

  // Paths and patterns are compared the way the filesystem compares names. A file that does not
  // exist yet has no on-disk spelling to recover, so on a case-insensitive disk both sides are folded.
  const fold = (params.caseInsensitive ?? isCaseInsensitive(repoRoot)) ? (text) => text.toLowerCase() : (text) => text;
  const key = fold(rel);
  const matches = (target, patterns) => matchesAnyGlob(target, patterns.map(fold));

  const runFile = /^\.crafthelm\/runs\/([^/]+)\/(.+)$/.exec(key);
  if (runFile) {
    if (matches(runFile[2], AGENT_AUTHORED_RUN_FILES)) {
      return allow('RUN_WORKSPACE', 'run directory file an agent is meant to author');
    }
    return deny(
      'SCRIPT_OWNED_ARTIFACT',
      `${rel} is written only by CraftHelm scripts (verify, checkpoint, delegate, review-package, approve). Run the script instead of editing its output; a human acceptance record is never written by an agent.`,
    );
  }
  if (matches(key, CONTROL_FILES)) {
    return deny(
      'CONTROL_FILE',
      `${rel} decides what this session may do, so file tools do not write it. Change a contract through the contract commands (contract add-e2e, add-test, approve) or a new interview; settings are edited by a person.`,
    );
  }

  const scopes = listActiveScopes(repoRoot);
  if (scopes.length === 0) {
    // Opt-in per repository: with `require_run_for_edits` in .crafthelm/config.json, a change needs
    // an open run. Off by default, because it also stops a one-line fix nobody wanted a contract for.
    if (readJsonSafe(path.join(repoRoot, '.crafthelm', 'config.json'))?.require_run_for_edits !== true) {
      return allow('NO_ACTIVE_RUN', 'no run in progress');
    }
    if ((params.isIgnored ?? isGitIgnored)(repoRoot, rel)) return allow('GIT_IGNORED', 'ignored by git, not part of the verified tree');
    return deny(
      'RUN_REQUIRED',
      `${rel}: this repository requires an open CraftHelm run before files are changed (require_run_for_edits). Start one with: node "${toPosixPath(path.join(CRAFTHELM_ROOT, 'scripts', 'crafthelm.mjs'))}" start "<task>" --repo "${toPosixPath(repoRoot)}". The user approves the contract.`,
    );
  }

  const protectedBy = scopes.filter((s) => matches(key, s.protect));
  if (protectedBy.length > 0) {
    return deny(
      'PROTECTED_PATH',
      `${rel} is under scope.protect of ${protectedBy.map((s) => s.task_id).join(', ')}. verify would fail with PROTECTED_PATH_VIOLATION. Leave it unchanged, or stop and ask for the contract to be re-planned.`,
    );
  }
  if (scopes.some((s) => matches(key, s.allow))) return allow('IN_SCOPE', 'inside scope.allow');

  // verify reads the tree through git, so an ignored file is outside what it checks.
  if ((params.isIgnored ?? isGitIgnored)(repoRoot, rel)) return allow('GIT_IGNORED', 'ignored by git, not part of the verified tree');

  const allowed = [...new Set(scopes.flatMap((s) => s.allow))].join(', ');
  return deny(
    'OUT_OF_SCOPE',
    `${rel} is outside scope.allow (${allowed}) of the active run ${scopes.map((s) => s.run_id).join(', ')}. verify would fail with SCOPE_VIOLATION. Keep the change inside the scope, or stop and ask for the contract to be re-planned.`,
  );
}

const WAITING_ON_A_PERSON = {
  [STATES.READY_FOR_HUMAN_REVIEW]: 'It is waiting for the human acceptance decision. Do not edit files, and never record the decision yourself.',
  [STATES.BLOCKED_HUMAN_ATTENTION]: 'The repair limit is used up. Stop and report to the user; the next step is their decision.',
  [STATES.BLOCKED]: 'It is blocked. Stop and report the reason to the user.',
  [STATES.REPLAN_REQUIRED]: 'The contract or its sources changed. Stop and ask the user to re-plan.',
};

/**
 * The lines a session should be reminded of: which run is open, what it may touch, what comes next.
 * Reads checkpoints and contracts only. With no run in progress it speaks at session start and is
 * silent on later prompts.
 * @param {{ cwd: string, event?: string, crafthelmRoot?: string }} params
 * @returns {string} empty when there is nothing to say
 */
export function describeSessionStatus(params) {
  const repoRoot = findCraftHelmRepo(params.cwd);
  if (!repoRoot) return '';
  const cli = `node "${toPosixPath(path.join(path.resolve(params.crafthelmRoot ?? CRAFTHELM_ROOT), 'scripts', 'crafthelm.mjs'))}"`;
  const repoFlag = `--repo "${toPosixPath(repoRoot)}"`;
  const scopes = listActiveScopes(repoRoot);
  if (scopes.length === 0) {
    if (params.event !== 'SessionStart') return '';
    const required = readJsonSafe(path.join(repoRoot, '.crafthelm', 'config.json'))?.require_run_for_edits === true;
    return `CraftHelm: this repository uses CraftHelm and no run is in progress.${required ? ' File edits are blocked until one is open.' : ''} Before changing code, start one with: ${cli} start "<task>" ${repoFlag}. The user approves the contract; you do not.`;
  }
  const lines = [];
  for (const run of scopes) {
    lines.push(`CraftHelm: run ${run.run_id} (task ${run.task_id}) is ${run.state}.`);
    lines.push(`  Write only inside scope.allow: ${run.allow.join(', ') || '(nothing)'}.${run.protect.length > 0 ? ` Never inside scope.protect: ${run.protect.join(', ')}.` : ''}`);
    lines.push(`  ${WAITING_ON_A_PERSON[run.state] ?? `After editing, verify with: ${cli} verify ${repoFlag} --run-id ${run.run_id} --selective`}`);
    lines.push(`  What failed and what is next: ${cli} status ${repoFlag} --run-id ${run.run_id} --explain`);
  }
  return lines.join('\n');
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
