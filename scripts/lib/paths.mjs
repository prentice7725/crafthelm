import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Root directory of the CraftHelm repository itself.
 */
export const CRAFTHELM_ROOT = path.resolve(__dirname, '..', '..');

/**
 * How to invoke the CLI from where the caller is. Inside the CraftHelm checkout the short relative
 * form works; from a target repository there is no `scripts/crafthelm.mjs`, so the absolute path is given.
 * @param {string} [cwd]
 * @returns {string}
 */
export function cliInvocation(cwd = process.cwd()) {
  const here = path.resolve(cwd);
  const same = process.platform === 'win32' ? here.toLowerCase() === CRAFTHELM_ROOT.toLowerCase() : here === CRAFTHELM_ROOT;
  return same ? 'node scripts/crafthelm.mjs' : `node "${path.join(CRAFTHELM_ROOT, 'scripts', 'crafthelm.mjs').replace(/\\/g, '/')}"`;
}

/**
 * Normalize a path to POSIX forward slashes and strip leading `./`.
 * @param {string} inputPath
 * @returns {string}
 */
export function toPosixPath(inputPath) {
  const normalized = String(inputPath).replace(/\\/g, '/').replace(/\/+/g, '/');
  return normalized.replace(/^\.\//, '');
}

/**
 * Name glob syntax this matcher does not implement. Such a pattern is matched literally, so it
 * silently matches nothing: harmless in `scope.allow`, but in `scope.protect` it protects nothing.
 * Square brackets are not reported: they are literal on purpose (`pages/[id].tsx`).
 * @param {string} pattern
 * @returns {string|null} what is unsupported, or null
 */
export function unsupportedGlobSyntax(pattern) {
  const norm = toPosixPath(pattern);
  if (norm.startsWith('!')) return 'negation ("!pattern")';
  if (/\{[^{}/]*,[^{}]*\}/.test(norm)) return 'brace alternation ("{a,b}")';
  return null;
}

/**
 * Convert a glob pattern into a RegExp. Supported: `**` (any depth), `*` (within one segment),
 * `?` (one character), and a trailing `/` (everything under that directory, see `matchGlob`).
 * Everything else is literal, including `[]`, `{}` and a leading `!`.
 * @param {string} pattern
 * @returns {RegExp}
 */
export function globToRegExp(pattern) {
  const norm = toPosixPath(pattern).replace(/^\//, '');
  let regex = '^';
  let i = 0;
  while (i < norm.length) {
    const ch = norm[i];
    if (ch === '*') {
      if (norm[i + 1] === '*') {
        if (norm[i + 2] === '/') {
          regex += '(?:.*/)?';
          i += 3;
        } else {
          regex += '.*';
          i += 2;
        }
      } else {
        regex += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      regex += '[^/]';
      i += 1;
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      regex += `\\${ch}`;
      i += 1;
    } else {
      regex += ch;
      i += 1;
    }
  }
  regex += '$';
  return new RegExp(regex);
}

/**
 * Check whether a relative POSIX path matches a glob pattern.
 * @param {string} relPath
 * @param {string} pattern
 * @returns {boolean}
 */
export function matchGlob(relPath, pattern) {
  const target = toPosixPath(relPath).replace(/^\//, '');
  const cleanPattern = toPosixPath(pattern).replace(/^\//, '');
  if (cleanPattern.endsWith('/')) {
    return target.startsWith(cleanPattern);
  }
  return globToRegExp(cleanPattern).test(target);
}

/**
 * Check whether a relative path matches any pattern in a list.
 * @param {string} relPath
 * @param {string[]} patterns
 * @returns {boolean}
 */
export function matchesAnyGlob(relPath, patterns = []) {
  return patterns.some((pattern) => matchGlob(relPath, pattern));
}

/**
 * Resolve `.crafthelm` paths inside a target repository.
 * @param {string} repoRoot
 */
export function getCraftHelmDir(repoRoot) {
  return path.join(path.resolve(repoRoot), '.crafthelm');
}

export function getContractPath(repoRoot, taskId) {
  return path.join(getCraftHelmDir(repoRoot), 'contracts', `${taskId}.json`);
}

export function getRunDir(repoRoot, runId) {
  return path.join(getCraftHelmDir(repoRoot), 'runs', runId);
}

export function getCheckpointPath(repoRoot, runId) {
  return path.join(getRunDir(repoRoot, runId), 'checkpoint.json');
}

export function getEvidenceManifestPath(repoRoot, runId) {
  return path.join(getRunDir(repoRoot, runId), 'evidence-manifest.json');
}

export function getVerificationStampPath(repoRoot, runId) {
  return path.join(getRunDir(repoRoot, runId), 'evidence', 'verification-stamp.json');
}

export function getReviewPackagePath(repoRoot, runId) {
  return path.join(getRunDir(repoRoot, runId), 'reports', 'review-package.md');
}

export function getReviewPackageMetaPath(repoRoot, runId) {
  return path.join(getRunDir(repoRoot, runId), 'reports', 'review-package.meta.json');
}

export function getEditorialReportPath(repoRoot, runId) {
  return path.join(getRunDir(repoRoot, runId), 'reports', 'editorial-report.json');
}

export function getApprovalDecisionPath(repoRoot, runId) {
  return path.join(getRunDir(repoRoot, runId), 'approvals', 'decision.json');
}

export function getApprovalHistoryPath(repoRoot, runId) {
  return path.join(getRunDir(repoRoot, runId), 'approvals', 'decisions-history.jsonl');
}

export function getSkillLockPath(repoRoot) {
  return path.join(getCraftHelmDir(repoRoot), 'skills.lock.json');
}

export function getMemoryDir(repoRoot) {
  return path.join(getCraftHelmDir(repoRoot), 'memory');
}

export function getMemoryDecisionsDir(repoRoot) {
  return path.join(getMemoryDir(repoRoot), 'decisions');
}

export function getMemoryIndexPath(repoRoot) {
  return path.join(getMemoryDir(repoRoot), 'index.sqlite');
}

export function getHandoffPacketPath(repoRoot, runId) {
  return path.join(getRunDir(repoRoot, runId), 'evidence', 'handoff-packet.json');
}

/**
 * Requirements of a contract that no applicable acceptance item refers to. A contract written
 * before requirements were recorded in it has none to report.
 * @param {{ requirements?: Array<{ id: string, statement: string }>, acceptance?: Array<{ requirement?: string, applicable?: boolean }> }} contract
 * @returns {Array<{ id: string, statement: string }>}
 */
export function requirementsWithoutAcceptance(contract) {
  const covered = new Set((contract?.acceptance ?? []).filter((ac) => ac && ac.applicable !== false).map((ac) => ac.requirement));
  return (contract?.requirements ?? []).filter((r) => !covered.has(r.id));
}
