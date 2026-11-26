import fs from 'node:fs';
import path from 'node:path';
import { readClaudeSettings } from './claude-permissions.mjs';
import { CRAFTHELM_ROOT, toPosixPath } from './paths.mjs';
import { writeAtomic } from './task-artifacts.mjs';

/**
 * Registration of the scope guard as a Claude Code `PreToolUse` hook.
 *
 * Project settings only (`<repo>/.claude/settings.json`): a hook in user settings would run on
 * every edit in every project. The command points at this CraftHelm checkout, like the installed
 * skill does, so moving the checkout means re-running `init-host --host claude`.
 *
 * Like the permission guards, a hook in a settings file is a seatbelt: whoever can edit the file
 * can remove it. Nothing here deletes or reorders the user's own hooks.
 */

export const SCOPE_GUARD_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
const SCOPE_GUARD_MARKER = 'scripts/hooks/scope-guard.mjs';

/**
 * @param {string} [crafthelmRoot]
 * @returns {string}
 */
export function scopeGuardCommand(crafthelmRoot = CRAFTHELM_ROOT) {
  return `node "${toPosixPath(path.join(path.resolve(crafthelmRoot), SCOPE_GUARD_MARKER))}"`;
}

function findGuardHooks(settings) {
  const found = [];
  const groups = Array.isArray(settings?.hooks?.PreToolUse) ? settings.hooks.PreToolUse : [];
  for (const group of groups) {
    for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
      if (typeof hook?.command === 'string' && toPosixPath(hook.command).includes(SCOPE_GUARD_MARKER)) {
        found.push({ group, hook });
      }
    }
  }
  return found;
}

/**
 * Check whether a project's Claude settings register the scope guard of this checkout.
 * @param {{ repoRoot: string, crafthelmRoot?: string }} options
 * @returns {{ status: 'REGISTERED'|'STALE'|'MISSING', settings_path: string, command: string, error: string|null }}
 */
export function inspectClaudeScopeHook(options) {
  const claudeDir = path.join(path.resolve(options.repoRoot), '.claude');
  const command = scopeGuardCommand(options.crafthelmRoot);
  const settingsPath = path.join(claudeDir, 'settings.json');
  let status = 'MISSING';
  let firstError = null;
  for (const p of [settingsPath, path.join(claudeDir, 'settings.local.json')]) {
    const { data, error } = readClaudeSettings(p);
    firstError = firstError ?? error;
    const hooks = findGuardHooks(data);
    if (hooks.some((h) => h.hook.command === command)) status = 'REGISTERED';
    else if (hooks.length > 0 && status === 'MISSING') status = 'STALE';
  }
  return { status, settings_path: settingsPath, command, error: firstError };
}

/**
 * Register the scope guard in one settings file. Adds a hook group, or repoints a guard entry left
 * by another checkout path. Other hooks are untouched. A file that is not valid JSON is left alone.
 * @param {{ settingsPath: string, dryRun?: boolean, crafthelmRoot?: string }} options
 * @returns {{ settings_path: string, action: 'ADDED'|'UPDATED'|'WOULD_ADD'|'WOULD_UPDATE'|'UNCHANGED'|'SKIPPED_INVALID', command: string, reason?: string }}
 */
export function applyClaudeScopeHook(options) {
  const settingsPath = path.resolve(options.settingsPath);
  const command = scopeGuardCommand(options.crafthelmRoot);
  const { data, error } = readClaudeSettings(settingsPath);
  if (error) return { settings_path: settingsPath, action: 'SKIPPED_INVALID', command, reason: error };

  const settings = structuredClone(data ?? {});
  const hooksRoot = settings.hooks;
  if (hooksRoot !== undefined && (typeof hooksRoot !== 'object' || hooksRoot === null || Array.isArray(hooksRoot))) {
    return { settings_path: settingsPath, action: 'SKIPPED_INVALID', command, reason: '"hooks" is not an object' };
  }
  if (hooksRoot?.PreToolUse !== undefined && !Array.isArray(hooksRoot.PreToolUse)) {
    return { settings_path: settingsPath, action: 'SKIPPED_INVALID', command, reason: '"hooks.PreToolUse" is not an array' };
  }

  const existing = findGuardHooks(settings);
  if (existing.some((h) => h.hook.command === command)) {
    return { settings_path: settingsPath, action: 'UNCHANGED', command };
  }
  const updating = existing.length > 0;
  if (options.dryRun) {
    return { settings_path: settingsPath, action: updating ? 'WOULD_UPDATE' : 'WOULD_ADD', command };
  }
  if (updating) {
    for (const { hook } of existing) hook.command = command;
  } else {
    settings.hooks = { ...(hooksRoot ?? {}) };
    settings.hooks.PreToolUse = [
      ...(hooksRoot?.PreToolUse ?? []),
      { matcher: SCOPE_GUARD_MATCHER, hooks: [{ type: 'command', command }] },
    ];
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { settings_path: settingsPath, action: updating ? 'UPDATED' : 'ADDED', command };
}
