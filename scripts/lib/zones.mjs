import fs from 'node:fs';
import path from 'node:path';
import { sha256Text } from './crypto.mjs';
import { isGitRepo, readFileAtRef } from './git.mjs';
import { matchesAnyGlob, toPosixPath, unsupportedGlobSyntax } from './paths.mjs';
import { assertValidSchema } from './schema.mjs';
import { writeAtomic } from './task-artifacts.mjs';

/**
 * Project zones: which paths a project treats as strict.
 *
 * CraftHelm put the same weight on every change. A project knows where a mistake is expensive (a
 * schema others read, money that moves, data that cannot be brought back) and where it is not
 * (wording, an internal report). It says so once, when the project is set up, through its design and
 * interview, and the answer is kept in `.crafthelm/zones.json`:
 *
 *   - a path listed under `strict` is a strict zone, with the reason it is one;
 *   - everything else is light;
 *   - a project that has not decided has no zones, which is a third state, not "everything light".
 *
 * CraftHelm ships the definition and what reads it. It ships no list of paths: that is each
 * project's decision.
 *
 * Like the approvers policy, the zones that count for a run are the ones committed at the run's
 * protected base ref, not the working copy, so a run cannot lighten its own review by editing the
 * file. The scope guard also closes the file to file tools.
 */

export const ZONES_POLICY_PATH = '.crafthelm/zones.json';

function normalizeStrict(list) {
  return (Array.isArray(list) ? list : [])
    .filter((entry) => entry && typeof entry.path === 'string' && entry.path.trim())
    .map((entry) => ({ path: toPosixPath(entry.path.trim()), reason: String(entry.reason ?? '').trim() }));
}

/**
 * The zones in force for a run: the file as committed at `baseRef`.
 * @param {string} repoRoot
 * @param {string} baseRef
 * @returns {{ present: boolean, source: string, strict: Array<{ path: string, reason: string }>, digest: string|null, decided_by?: string, decided_at?: string }}
 */
export function loadZonesPolicy(repoRoot, baseRef) {
  const absent = { present: false, source: 'none', strict: [], digest: null, light_contracts: 'ask', light_contracts_decided_by: null };
  if (!baseRef || baseRef === 'UNBORN' || baseRef === 'NO_GIT' || !isGitRepo(repoRoot)) return absent;
  const atRef = readFileAtRef(repoRoot, baseRef, ZONES_POLICY_PATH);
  if (!atRef.exists) return absent;
  let parsed;
  try { parsed = JSON.parse(atRef.content); } catch { return { ...absent, source: `unreadable_at:${baseRef}` }; }
  return {
    present: true,
    source: `base_ref_git_show:${baseRef}`,
    strict: normalizeStrict(parsed.strict),
    digest: sha256Text(atRef.content.replace(/\r\n/g, '\n')),
    decided_by: parsed.decided_by,
    decided_at: parsed.decided_at,
    // How a contract that cannot reach a strict zone is started: 'ask' the user each time (the
    // default), or under the project's 'standing' rule.
    light_contracts: parsed.light_contracts?.mode === 'standing' ? 'standing' : 'ask',
    light_contracts_decided_by: parsed.light_contracts?.decided_by ?? null,
  };
}

/** The working copy, for showing and editing. It is not what a run is judged by. */
export function readWorkingZones(repoRoot) {
  const file = path.join(repoRoot, ZONES_POLICY_PATH);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Which zone a set of changed files falls in.
 * @param {ReturnType<typeof loadZonesPolicy>} policy
 * @param {string[]} changedFiles
 * @returns {{ classification: 'undefined'|'strict'|'light', strict_files: Array<{ path: string, pattern: string, reason: string }>, policy_source: string, policy_digest: string|null }}
 */
export function classifyZone(policy, changedFiles) {
  const base = { policy_source: policy.source, policy_digest: policy.digest };
  if (!policy.present) return { classification: 'undefined', strict_files: [], ...base };
  const strictFiles = [];
  for (const rel of changedFiles.map(toPosixPath)) {
    const hit = policy.strict.find((entry) => matchesAnyGlob(rel, [entry.path]));
    if (hit) strictFiles.push({ path: rel, pattern: hit.path, reason: hit.reason });
  }
  return { classification: strictFiles.length > 0 ? 'strict' : 'light', strict_files: strictFiles, ...base };
}

/**
 * Write the project's zones. `strict` may be empty: a project can decide that it has no strict
 * zone, and that is a decision too.
 * @param {string} repoRoot
 * @param {{ strict: Array<{ path: string, reason: string }>, actor: string, basis?: string, channel?: string }} options
 */
export function writeZones(repoRoot, options) {
  const actor = typeof options.actor === 'string' ? options.actor.trim() : '';
  if (!actor) throw new Error('zones set needs --actor <name>: the person who decided the zones.');
  const strict = normalizeStrict(options.strict);
  for (const entry of strict) {
    if (!entry.reason) throw new Error(`ZONE_REASON_REQUIRED: strict zone "${entry.path}" needs the reason it is strict, as "<path>::<reason>".`);
    const unsupported = unsupportedGlobSyntax(entry.path);
    if (unsupported) throw new Error(`ZONE_PATTERN_UNSUPPORTED: "${entry.path}" uses ${unsupported}, which CraftHelm paths do not support.`);
  }
  const seen = new Set();
  for (const entry of strict) {
    if (seen.has(entry.path)) throw new Error(`ZONE_DUPLICATE: "${entry.path}" is listed twice.`);
    seen.add(entry.path);
  }
  const zones = {
    schema_version: '0.1',
    strict,
    decided_by: actor,
    decided_at: new Date().toISOString(),
    decided_via: options.channel ?? 'programmatic',
    ...(typeof options.basis === 'string' && options.basis.trim() ? { basis: options.basis.trim() } : {}),
  };
  assertValidSchema('zones', zones, ZONES_POLICY_PATH);
  const file = path.join(repoRoot, ZONES_POLICY_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify(zones, null, 2)}\n`);
  return zones;
}

/**
 * Where a project stands: no zones, zones only in the working copy, or zones committed.
 * @param {string} repoRoot
 * @returns {{ status: 'UNDEFINED'|'NOT_COMMITTED'|'DIFFERS_FROM_HEAD'|'COMMITTED', working: object|null, committed: ReturnType<typeof loadZonesPolicy> }}
 */
export function inspectZones(repoRoot) {
  const working = readWorkingZones(repoRoot);
  const committed = loadZonesPolicy(repoRoot, 'HEAD');
  let status = 'UNDEFINED';
  if (working && !committed.present) status = 'NOT_COMMITTED';
  else if (working && committed.present) {
    const text = fs.readFileSync(path.join(repoRoot, ZONES_POLICY_PATH), 'utf8').replace(/\r\n/g, '\n');
    status = sha256Text(text) === committed.digest ? 'COMMITTED' : 'DIFFERS_FROM_HEAD';
  } else if (!working && committed.present) status = 'DIFFERS_FROM_HEAD';
  return { status, working, committed };
}

/**
 * Switch how light contracts are started, keeping the strict zones as they are. Redefining the
 * zones with `writeZones` puts the switch back to 'ask': a new set of zones is a new decision.
 * @param {string} repoRoot
 * @param {{ mode: 'ask'|'standing', actor: string, channel?: string }} options
 */
export function setLightContracts(repoRoot, options) {
  const actor = typeof options.actor === 'string' ? options.actor.trim() : '';
  if (!actor) throw new Error('zones set-light needs --actor <name>: the person who decided it.');
  if (options.mode !== 'ask' && options.mode !== 'standing') throw new Error('zones set-light needs --mode ask or --mode standing.');
  const zones = readWorkingZones(repoRoot);
  if (!zones) throw new Error('ZONES_UNDEFINED: this project has not decided its strict zones. A standing rule for light contracts needs to know what is strict first: run zones set.');
  zones.light_contracts = { mode: options.mode, decided_by: actor, decided_at: new Date().toISOString(), decided_via: options.channel ?? 'programmatic' };
  assertValidSchema('zones', zones, ZONES_POLICY_PATH);
  writeAtomic(path.join(repoRoot, ZONES_POLICY_PATH), `${JSON.stringify(zones, null, 2)}\n`);
  return zones;
}

// The part of a pattern before its first wildcard: every path the pattern matches starts with it.
function literalPrefix(pattern) {
  const norm = toPosixPath(pattern);
  const at = norm.search(/[*?]/);
  return at < 0 ? norm : norm.slice(0, at);
}

/**
 * The pairs of scope pattern and strict zone that could match the same file. Two patterns are kept
 * apart only when their fixed beginnings diverge; anything less certain counts as reachable, so
 * `src/**` reaches `src/schemas/**` and a pattern starting with a wildcard reaches everything.
 * @param {string[]} scopeAllow
 * @param {Array<{ path: string, reason: string }>} strict
 */
export function scopeMayTouchStrict(scopeAllow, strict) {
  const pairs = [];
  for (const allow of scopeAllow ?? []) {
    const a = literalPrefix(allow);
    for (const zone of strict) {
      const z = literalPrefix(zone.path);
      if (a.startsWith(z) || z.startsWith(a)) pairs.push({ allow, strict: zone.path });
    }
  }
  return pairs;
}

/**
 * May a contract be started under the project's standing rule, without asking the user?
 * Judged by the zones committed at HEAD, where the run's baseline will be.
 * @returns {{ eligible: boolean, reasons: string[], overlaps: Array<{ allow: string, strict: string }>, policy: ReturnType<typeof loadZonesPolicy> }}
 */
export function assessStandingStart(repoRoot, contract) {
  const policy = loadZonesPolicy(repoRoot, 'HEAD');
  const reasons = [];
  const allow = Array.isArray(contract.scope?.allow) ? contract.scope.allow : [];
  let overlaps = [];
  if (!policy.present) reasons.push('ZONES_UNDEFINED');
  else {
    if (policy.light_contracts !== 'standing') reasons.push('LIGHT_CONTRACTS_ASK');
    if (allow.length === 0) reasons.push('SCOPE_EMPTY');
    overlaps = scopeMayTouchStrict(allow, policy.strict);
    if (overlaps.length > 0) reasons.push('SCOPE_MAY_TOUCH_STRICT');
  }
  return { eligible: reasons.length === 0, reasons, overlaps, policy };
}
