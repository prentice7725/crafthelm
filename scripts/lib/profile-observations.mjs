import fs from 'node:fs';
import path from 'node:path';

/**
 * Profile observations: one line per `verify` call, appended, never rewritten.
 *
 * The evidence manifest is overwritten on every verify, so the round where an E2E check failed while
 * every other check passed disappears once the repair lands. That round is exactly the data the lite
 * limits need: it is a bug a lite run would have shipped with its E2E waived. This log keeps it.
 * It lives under `.crafthelm/runs/`, which is excluded from the target snapshot digest.
 */

export const OBSERVATIONS_FILE = 'profile-observations.jsonl';

const EXECUTED = new Set(['PASS', 'FAIL', 'BLOCKED']);

/**
 * @param {Array<{ kind: string, status: string }>} checks
 * @param {boolean} e2eExempted
 * @returns {{ e2e: 'PASS'|'FAIL'|'BLOCKED'|'NOT_RUN'|'WAIVED', other_checks: 'ALL_PASS'|'SOME_FAILED'|'NONE' }}
 */
export function summarizeCheckOutcome(checks, e2eExempted) {
  const e2e = checks.filter((c) => c.kind === 'e2e' && EXECUTED.has(c.status));
  const others = checks.filter((c) => c.kind !== 'e2e' && EXECUTED.has(c.status));
  let e2eOutcome = 'NOT_RUN';
  if (e2eExempted) e2eOutcome = 'WAIVED';
  else if (e2e.some((c) => c.status === 'FAIL')) e2eOutcome = 'FAIL';
  else if (e2e.some((c) => c.status === 'BLOCKED')) e2eOutcome = 'BLOCKED';
  else if (e2e.length > 0) e2eOutcome = 'PASS';
  const otherOutcome = others.length === 0 ? 'NONE' : others.every((c) => c.status === 'PASS') ? 'ALL_PASS' : 'SOME_FAILED';
  return { e2e: e2eOutcome, other_checks: otherOutcome };
}

/**
 * @param {string} runDir
 * @param {object} record
 */
export function appendProfileObservation(runDir, record) {
  const file = path.join(runDir, 'evidence', OBSERVATIONS_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * Read every observation under a repository's run directories. Malformed lines are counted, not thrown.
 * @param {string} repoRoot
 * @returns {{ records: object[], malformed: number }}
 */
export function readProfileObservations(repoRoot) {
  const runsDir = path.join(repoRoot, '.crafthelm', 'runs');
  const records = [];
  let malformed = 0;
  if (!fs.existsSync(runsDir)) return { records, malformed };
  for (const runId of fs.readdirSync(runsDir).sort()) {
    const file = path.join(runsDir, runId, 'evidence', OBSERVATIONS_FILE);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        malformed += 1;
      }
    }
  }
  return { records, malformed };
}
