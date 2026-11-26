import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CRAFTHELM_ROOT } from './paths.mjs';
import { writeAtomic } from './task-artifacts.mjs';

/**
 * Claude Code permission guards for the human approval gate.
 *
 * `hosts/claude/settings.example.json` is the single source. The guard set is every `ask` rule there
 * (contract and stage approvals) plus the `deny` rules that touch approval (`approve record`,
 * `approve keygen`). General-purpose rules in the example (`git push`, `rm -rf`, the allow list) are
 * left to the user and never written into their settings.
 *
 * Claude Code merges user, project and local settings and gives `deny` precedence over `ask` over
 * `allow`, so a guard counts as present when any of those files lists it.
 */

const EXAMPLE_PATH = path.join(CRAFTHELM_ROOT, 'hosts', 'claude', 'settings.example.json');
const APPROVAL_DENY_PATTERN = /approv|keygen/i;

/**
 * @returns {{ deny: string[], ask: string[] }}
 */
export function getClaudeGuardRules() {
  const example = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'));
  return {
    deny: (example.permissions?.deny ?? []).filter((r) => APPROVAL_DENY_PATTERN.test(r)),
    ask: [...(example.permissions?.ask ?? [])],
  };
}

/**
 * The settings file a given install scope writes to.
 * @param {{ scope?: 'user'|'project', homeDir?: string, repoRoot?: string }} options
 */
export function resolveClaudeSettingsPath(options = {}) {
  const scope = options.scope ?? 'user';
  if (scope === 'project') {
    return path.join(path.resolve(options.repoRoot ?? '.'), '.claude', 'settings.json');
  }
  return path.join(options.homeDir ?? os.homedir(), '.claude', 'settings.json');
}

/**
 * Read one Claude settings file without throwing: a missing, unreadable or invalid file is reported.
 * @param {string} settingsPath
 * @returns {{ exists: boolean, data: object|null, error: string|null }}
 */
export function readClaudeSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return { exists: false, data: null, error: null };
  let raw;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch (err) {
    // A permission error or a directory in the file's place is reported, never thrown at doctor or start.
    return { exists: true, data: null, error: `unreadable: ${err.code ?? err.message}` };
  }
  if (!raw.trim()) return { exists: true, data: {}, error: null };
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { exists: true, data: null, error: 'settings root is not a JSON object' };
    }
    return { exists: true, data, error: null };
  } catch (err) {
    return { exists: true, data: null, error: `invalid JSON: ${err.message}` };
  }
}

/**
 * Check whether the approval guards are in effect across the Claude settings files that apply.
 * @param {{ homeDir?: string, repoRoot?: string }} [options]
 * @returns {{ status: 'GUARDED'|'MISSING', files: Array<{ path: string, exists: boolean, error: string|null }>, missing: { deny: string[], ask: string[] } }}
 */
export function inspectClaudePermissionGuards(options = {}) {
  const guards = getClaudeGuardRules();
  const candidates = [resolveClaudeSettingsPath({ scope: 'user', homeDir: options.homeDir })];
  if (options.repoRoot) {
    const claudeDir = path.join(path.resolve(options.repoRoot), '.claude');
    candidates.push(path.join(claudeDir, 'settings.json'), path.join(claudeDir, 'settings.local.json'));
  }
  const present = { deny: new Set(), ask: new Set() };
  const files = [];
  for (const p of candidates) {
    const { exists, data, error } = readClaudeSettings(p);
    files.push({ path: p, exists, error });
    for (const kind of ['deny', 'ask']) {
      for (const rule of data?.permissions?.[kind] ?? []) present[kind].add(rule);
    }
  }
  // A rule denied anywhere is at least as strong as asking for it.
  const missing = {
    deny: guards.deny.filter((r) => !present.deny.has(r)),
    ask: guards.ask.filter((r) => !present.ask.has(r) && !present.deny.has(r)),
  };
  const status = missing.deny.length === 0 && missing.ask.length === 0 ? 'GUARDED' : 'MISSING';
  return { status, files, missing };
}

/**
 * Add any missing approval guards to one settings file. Only adds rules; nothing is removed or reordered.
 * A file that is not valid JSON is left untouched and reported.
 * @param {{ settingsPath: string, dryRun?: boolean }} options
 * @returns {{ settings_path: string, action: 'ADDED'|'WOULD_ADD'|'UNCHANGED'|'SKIPPED_INVALID', added: { deny: string[], ask: string[] }, reason?: string }}
 */
export function applyClaudePermissionGuards(options) {
  const settingsPath = path.resolve(options.settingsPath);
  const guards = getClaudeGuardRules();
  const { data, error } = readClaudeSettings(settingsPath);
  if (error) {
    return { settings_path: settingsPath, action: 'SKIPPED_INVALID', added: { deny: [], ask: [] }, reason: error };
  }
  const settings = data ?? {};
  const permissions = settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : {};
  const deny = Array.isArray(permissions.deny) ? permissions.deny : [];
  const ask = Array.isArray(permissions.ask) ? permissions.ask : [];
  const added = {
    deny: guards.deny.filter((r) => !deny.includes(r)),
    ask: guards.ask.filter((r) => !ask.includes(r) && !deny.includes(r)),
  };
  if (added.deny.length === 0 && added.ask.length === 0) {
    return { settings_path: settingsPath, action: 'UNCHANGED', added };
  }
  if (options.dryRun) {
    return { settings_path: settingsPath, action: 'WOULD_ADD', added };
  }
  const next = {
    ...settings,
    permissions: { ...permissions, ask: [...ask, ...added.ask], deny: [...deny, ...added.deny] },
  };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  // Temp file plus rename: an interrupted install must not leave the user's settings file truncated.
  writeAtomic(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  return { settings_path: settingsPath, action: 'ADDED', added };
}
