import fs from 'node:fs';
import path from 'node:path';
import { getClaudeGuardRules, readClaudeSettings } from './claude-permissions.mjs';
import { sha256CanonicalJson } from './crypto.mjs';
import { CRAFTHELM_ROOT, toPosixPath } from './paths.mjs';
import { writeAtomic } from './task-artifacts.mjs';

/**
 * Registration of CraftHelm's Claude Code hooks in a project's settings.
 *
 * - The scope guard (`PreToolUse`) refuses a file-tool write the active contract does not allow.
 * - The session status hook (`SessionStart`, `UserPromptSubmit`) puts the active run and its scope
 *   in front of the agent. A skill's instructions are read once, when it is invoked; nothing carries
 *   the procedure into the turns after that unless something repeats it.
 *
 * Project settings only (`<repo>/.claude/settings.json`): a hook in user settings would run in
 * every project. The commands point at this CraftHelm checkout, like the installed skill does, so
 * moving the checkout means re-running `init-host --host claude`.
 *
 * Like the permission guards, a hook in a settings file is a seatbelt: whoever can edit the file
 * can remove it. Nothing here deletes or reorders the user's own hooks.
 */

export const SCOPE_GUARD_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
const SCOPE_GUARD_MARKER = 'scripts/hooks/scope-guard.mjs';
const SESSION_STATUS_MARKER = 'scripts/hooks/session-status.mjs';

function hookCommand(marker, crafthelmRoot = CRAFTHELM_ROOT) {
  return `node "${toPosixPath(path.join(path.resolve(crafthelmRoot), marker))}"`;
}

/**
 * @param {string} [crafthelmRoot]
 * @returns {string}
 */
export function scopeGuardCommand(crafthelmRoot) {
  return hookCommand(SCOPE_GUARD_MARKER, crafthelmRoot);
}

/**
 * @param {string} [crafthelmRoot]
 * @returns {string}
 */
export function sessionStatusCommand(crafthelmRoot) {
  return hookCommand(SESSION_STATUS_MARKER, crafthelmRoot);
}

// Each registration: the events it listens on, the matcher (tool hooks only), and its script.
const HOOKS = {
  scope_guard: { marker: SCOPE_GUARD_MARKER, events: [{ event: 'PreToolUse', matcher: SCOPE_GUARD_MATCHER }] },
  session_status: { marker: SESSION_STATUS_MARKER, events: [{ event: 'SessionStart' }, { event: 'UserPromptSubmit' }] },
};

function findHooks(settings, event, marker) {
  const found = [];
  const groups = Array.isArray(settings?.hooks?.[event]) ? settings.hooks[event] : [];
  for (const group of groups) {
    for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
      if (typeof hook?.command === 'string' && toPosixPath(hook.command).includes(marker)) found.push(hook);
    }
  }
  return found;
}

function inspectHook(kind, options) {
  const { marker, events } = HOOKS[kind];
  const claudeDir = path.join(path.resolve(options.repoRoot), '.claude');
  const command = hookCommand(marker, options.crafthelmRoot);
  const settingsPath = path.join(claudeDir, 'settings.json');
  const files = [settingsPath, path.join(claudeDir, 'settings.local.json')].map((p) => readClaudeSettings(p));
  const firstError = files.find((f) => f.error)?.error ?? null;
  // Every event must carry the hook; one missing event means the registration is incomplete.
  const perEvent = events.map(({ event }) => {
    const hooks = files.flatMap((f) => findHooks(f.data, event, marker));
    if (hooks.some((h) => h.command === command)) return 'REGISTERED';
    return hooks.length > 0 ? 'STALE' : 'MISSING';
  });
  const status = perEvent.every((s) => s === 'REGISTERED') ? 'REGISTERED' : perEvent.includes('STALE') ? 'STALE' : 'MISSING';
  return { status, settings_path: settingsPath, command, error: firstError };
}

function applyHook(kind, options) {
  const { marker, events } = HOOKS[kind];
  const settingsPath = path.resolve(options.settingsPath);
  const command = hookCommand(marker, options.crafthelmRoot);
  const { data, error } = readClaudeSettings(settingsPath);
  if (error) return { settings_path: settingsPath, action: 'SKIPPED_INVALID', command, reason: error };

  const settings = structuredClone(data ?? {});
  const hooksRoot = settings.hooks;
  if (hooksRoot !== undefined && (typeof hooksRoot !== 'object' || hooksRoot === null || Array.isArray(hooksRoot))) {
    return { settings_path: settingsPath, action: 'SKIPPED_INVALID', command, reason: '"hooks" is not an object' };
  }
  for (const { event } of events) {
    if (hooksRoot?.[event] !== undefined && !Array.isArray(hooksRoot[event])) {
      return { settings_path: settingsPath, action: 'SKIPPED_INVALID', command, reason: `"hooks.${event}" is not an array` };
    }
  }

  let added = false;
  let updated = false;
  settings.hooks = { ...(hooksRoot ?? {}) };
  for (const { event, matcher } of events) {
    const existing = findHooks(settings, event, marker);
    if (existing.some((h) => h.command === command)) continue;
    if (existing.length > 0) {
      // An entry left by another checkout path is ours to repoint.
      for (const hook of existing) hook.command = command;
      updated = true;
    } else {
      settings.hooks[event] = [
        ...(settings.hooks[event] ?? []),
        { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] },
      ];
      added = true;
    }
  }
  if (!added && !updated) return { settings_path: settingsPath, action: 'UNCHANGED', command };
  if (options.dryRun) return { settings_path: settingsPath, action: added ? 'WOULD_ADD' : 'WOULD_UPDATE', command };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { settings_path: settingsPath, action: added ? 'ADDED' : 'UPDATED', command };
}

/**
 * Check whether a project's Claude settings register the scope guard of this checkout.
 * @param {{ repoRoot: string, crafthelmRoot?: string }} options
 * @returns {{ status: 'REGISTERED'|'STALE'|'MISSING', settings_path: string, command: string, error: string|null }}
 */
export function inspectClaudeScopeHook(options) {
  return inspectHook('scope_guard', options);
}

/**
 * Register the scope guard in one settings file. Adds a hook group, or repoints a guard entry left
 * by another checkout path. Other hooks are untouched. A file that is not valid JSON is left alone.
 * @param {{ settingsPath: string, dryRun?: boolean, crafthelmRoot?: string }} options
 * @returns {{ settings_path: string, action: 'ADDED'|'UPDATED'|'WOULD_ADD'|'WOULD_UPDATE'|'UNCHANGED'|'SKIPPED_INVALID', command: string, reason?: string }}
 */
export function applyClaudeScopeHook(options) {
  return applyHook('scope_guard', options);
}

/**
 * Check whether a project's Claude settings register the session status hook on both of its events.
 * @param {{ repoRoot: string, crafthelmRoot?: string }} options
 */
export function inspectClaudeStatusHook(options) {
  return inspectHook('session_status', options);
}

/**
 * Register the session status hook (`SessionStart` and `UserPromptSubmit`) in one settings file.
 * @param {{ settingsPath: string, dryRun?: boolean, crafthelmRoot?: string }} options
 */
export function applyClaudeStatusHook(options) {
  return applyHook('session_status', options);
}

// A settings object with CraftHelm's own guards taken out: the guard rules as the example file
// spells them, and hook entries that are exactly what this checkout registers, in a group that
// carries nothing else. Anything that only resembles a guard stays, and so shows up as a difference.
function withoutCraftHelmGuards(settings, crafthelmRoot) {
  const guards = getClaudeGuardRules();
  const out = structuredClone(settings ?? {});
  const found = { ask: [], deny: [], hooks: [] };
  if (out.permissions && typeof out.permissions === 'object' && !Array.isArray(out.permissions)) {
    for (const list of ['ask', 'deny']) {
      if (!Array.isArray(out.permissions[list])) continue;
      found[list] = out.permissions[list].filter((rule) => guards[list].includes(rule));
      out.permissions[list] = out.permissions[list].filter((rule) => !guards[list].includes(rule));
      if (out.permissions[list].length === 0) delete out.permissions[list];
    }
    if (Object.keys(out.permissions).length === 0) delete out.permissions;
  }
  if (out.hooks && typeof out.hooks === 'object' && !Array.isArray(out.hooks)) {
    for (const { marker, events } of Object.values(HOOKS)) {
      const command = hookCommand(marker, crafthelmRoot);
      for (const { event, matcher } of events) {
        if (!Array.isArray(out.hooks[event])) continue;
        out.hooks[event] = out.hooks[event].filter((group) => {
          const ours = group && typeof group === 'object'
            && Object.keys(group).sort().join(',') === (matcher ? 'hooks,matcher' : 'hooks')
            && (matcher ? group.matcher === matcher : true)
            && Array.isArray(group.hooks) && group.hooks.length === 1
            && sha256CanonicalJson(group.hooks[0]) === sha256CanonicalJson({ type: 'command', command });
          if (ours) found.hooks.push(`${event}:${marker}`);
          return !ours;
        });
        if (out.hooks[event].length === 0) delete out.hooks[event];
      }
    }
    if (Object.keys(out.hooks).length === 0) delete out.hooks;
  }
  return { rest: out, found };
}

/**
 * True when `current` is `baseline` with CraftHelm guards added and nothing else changed: no guard
 * the baseline had is missing, and every other key, rule and hook is the same. This is what
 * `init-host --host claude` or `install-skills` does to a project's settings when a newer checkout
 * has more guard rules. Only additions pass, since a guard can only narrow what a session may do.
 * @param {object|null} baseline
 * @param {object|null} current
 * @param {{ crafthelmRoot?: string }} [options]
 * @returns {boolean}
 */
export function isOnlyClaudeGuardAddition(baseline, current, options = {}) {
  if (!baseline || !current || typeof baseline !== 'object' || typeof current !== 'object') return false;
  const before = withoutCraftHelmGuards(baseline, options.crafthelmRoot);
  const after = withoutCraftHelmGuards(current, options.crafthelmRoot);
  if (sha256CanonicalJson(before.rest) !== sha256CanonicalJson(after.rest)) return false;
  const kept = ['ask', 'deny', 'hooks'].every((kind) => before.found[kind].every((item) => after.found[kind].includes(item)));
  const grew = ['ask', 'deny', 'hooks'].some((kind) => after.found[kind].length > before.found[kind].length);
  return kept && grew;
}
