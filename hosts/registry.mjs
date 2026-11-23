import * as antigravityAdapter from './antigravity/adapter.mjs';
import * as claudeAdapter from './claude/adapter.mjs';
import * as codexAdapter from './codex/adapter.mjs';
import { createGenericAdapter } from './generic/adapter.mjs';

export const BUILTIN_CLI_HOSTS = Object.freeze(['claude', 'codex', 'antigravity']);

const HOST_ALIASES = Object.freeze({
  agy: 'antigravity',
});

/**
 * Normalize a host identifier (`agy` -> `antigravity`, lowercase, defaults to `generic`).
 * @param {string} [host]
 * @returns {string}
 */
export function normalizeHostId(host) {
  const clean = String(host ?? '').trim().toLowerCase();
  if (!clean) return 'generic';
  return HOST_ALIASES[clean] ?? clean;
}

/**
 * Resolve the single-provider adapter for any host identifier without importing/invoking other providers.
 * @param {string} [host]
 * @param {{ hostConfig?: object }} [options]
 */
export function getHostAdapter(host, options = {}) {
  const hostId = normalizeHostId(host);
  if (hostId === 'claude') return { hostId, adapter: claudeAdapter };
  if (hostId === 'codex') return { hostId, adapter: codexAdapter };
  if (hostId === 'antigravity') return { hostId, adapter: antigravityAdapter };
  return { hostId, adapter: createGenericAdapter(hostId, options.hostConfig ?? {}) };
}
