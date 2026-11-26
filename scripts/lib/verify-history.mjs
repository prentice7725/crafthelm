import fs from 'node:fs';
import path from 'node:path';

/**
 * Verify history: one record per `verify` call, appended, never rewritten.
 *
 * Each verify overwrites the evidence manifest and the per-check logs, so once a repair lands
 * nothing shows what failed before it. This keeps a line per round with every check's outcome, and
 * a copy of the logs of the checks that failed in that round. A reviewer can then see what the
 * second attempt fixed, and that nothing that passed before fails now.
 *
 * It lives under `.crafthelm/runs/`, outside the target snapshot digest. Like the rest of the run
 * directory it is a record for people, not a control: whoever can write the directory can edit it.
 */

export const HISTORY_FILE = 'evidence/verify-history.jsonl';
const HISTORY_LOG_DIR = 'evidence/history';
const NOT_RUN = new Set(['NOT_APPLICABLE', 'UNVERIFIED', 'SKIPPED_UNIMPACTED']);
const FAILING = new Set(['FAIL', 'BLOCKED']);

/**
 * @param {string} runDir
 * @returns {object[]} rounds in the order they ran; a line that does not parse is skipped
 */
export function readVerifyHistory(runDir) {
  const file = path.join(runDir, HISTORY_FILE);
  if (!fs.existsSync(file)) return [];
  const rounds = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rounds.push(JSON.parse(line));
    } catch {
      // An interrupted append leaves a partial last line; the rounds before it still stand.
    }
  }
  return rounds;
}

function archiveLog(runDir, roundDir, rel) {
  if (!rel) return null;
  const from = path.join(runDir, rel);
  if (!fs.existsSync(from)) return null;
  const archivedRel = `${roundDir}/${path.posix.basename(rel)}`;
  fs.mkdirSync(path.join(runDir, roundDir), { recursive: true });
  fs.copyFileSync(from, path.join(runDir, archivedRel));
  return archivedRel;
}

/**
 * Append the round that just finished. Call after the check logs are written.
 * @param {string} runDir
 * @param {{ runId: string, targetSnapshotDigest: string, technicalStatus: string, scopeStatus: string, failureReasons: string[], checks: object[] }} round
 * @returns {object} the record that was appended
 */
export function appendVerifyRound(runDir, round) {
  const number = readVerifyHistory(runDir).reduce((max, r) => Math.max(max, r.round ?? 0), 0) + 1;
  const roundDir = `${HISTORY_LOG_DIR}/round-${String(number).padStart(3, '0')}`;
  const record = {
    schema_version: '0.3',
    run_id: round.runId,
    round: number,
    recorded_at: new Date().toISOString(),
    target_snapshot_digest: round.targetSnapshotDigest,
    technical_status: round.technicalStatus,
    scope_status: round.scopeStatus,
    failure_reasons: round.failureReasons,
    checks: round.checks.map((c) => {
      const failed = FAILING.has(c.status);
      return {
        id: c.id,
        kind: c.kind,
        status: c.status,
        exit_code: c.exit_code ?? null,
        reason: c.reason ?? null,
        command: c.command ?? null,
        duration_ms: c.duration_ms ?? null,
        stdout_sha256: c.stdout_sha256 ?? null,
        stderr_sha256: c.stderr_sha256 ?? null,
        // Only failing output is kept: it is what the next round overwrites and a reviewer asks for.
        archived_stdout: failed ? archiveLog(runDir, roundDir, c.stdout_file) : null,
        archived_stderr: failed ? archiveLog(runDir, roundDir, c.stderr_file) : null,
      };
    }),
  };
  const file = path.join(runDir, HISTORY_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

function outcomeKey(round) {
  return JSON.stringify([round.target_snapshot_digest, round.technical_status, round.checks.map((c) => [c.id, c.status])]);
}

/**
 * Fold repeated runs and name what changed between attempts.
 *
 * Consecutive rounds on the same snapshot with the same outcome are one attempt: re-running verify
 * without changing anything is not a second try. Between attempts each check is classified by its
 * status before and after.
 * @param {object[]} rounds
 * @returns {{ total_rounds: number, attempts: Array<{ attempt: number, rounds: number[], first_recorded_at: string, last_recorded_at: string, target_snapshot_digest: string, technical_status: string, failure_reasons: string[], checks: object[], changes: null|{ snapshot_changed: boolean, fixed: string[], regressed: string[], still_failing: string[], newly_run: string[], no_longer_run: string[] } }> }}
 */
export function summarizeVerifyHistory(rounds) {
  const attempts = [];
  for (const round of rounds) {
    const last = attempts.at(-1);
    if (last && last.key === outcomeKey(round)) {
      last.rounds.push(round.round);
      last.last_recorded_at = round.recorded_at;
      // The latest copy of a failing log is the one worth pointing at.
      last.checks = round.checks;
      continue;
    }
    attempts.push({
      key: outcomeKey(round),
      attempt: attempts.length + 1,
      rounds: [round.round],
      first_recorded_at: round.recorded_at,
      last_recorded_at: round.recorded_at,
      target_snapshot_digest: round.target_snapshot_digest,
      technical_status: round.technical_status,
      failure_reasons: round.failure_reasons ?? [],
      checks: round.checks,
      changes: null,
    });
  }
  for (let i = 1; i < attempts.length; i++) {
    const before = new Map(attempts[i - 1].checks.map((c) => [c.id, c.status]));
    const after = new Map(attempts[i].checks.map((c) => [c.id, c.status]));
    const changes = {
      snapshot_changed: attempts[i].target_snapshot_digest !== attempts[i - 1].target_snapshot_digest,
      fixed: [],
      regressed: [],
      still_failing: [],
      newly_run: [],
      no_longer_run: [],
    };
    for (const [id, now] of after) {
      const was = before.get(id);
      const wasRun = was !== undefined && !NOT_RUN.has(was);
      const nowRun = !NOT_RUN.has(now);
      if (FAILING.has(was) && now === 'PASS') changes.fixed.push(id);
      else if (was === 'PASS' && FAILING.has(now)) changes.regressed.push(id);
      else if (FAILING.has(was) && FAILING.has(now)) changes.still_failing.push(id);
      else if (!wasRun && nowRun) changes.newly_run.push(id);
      else if (wasRun && !nowRun) changes.no_longer_run.push(id);
    }
    for (const [id, was] of before) {
      if (!after.has(id) && !NOT_RUN.has(was)) changes.no_longer_run.push(id);
    }
    attempts[i].changes = changes;
  }
  return {
    total_rounds: rounds.length,
    attempts: attempts.map(({ key, ...attempt }) => attempt),
  };
}

/**
 * @param {string} runId
 * @param {ReturnType<typeof summarizeVerifyHistory>} summary
 * @returns {string}
 */
export function formatVerifyHistoryText(runId, summary) {
  if (summary.attempts.length === 0) {
    return `검증 이력 (${runId}): 기록된 verify 실행이 없습니다.\n`;
  }
  const lines = [`검증 이력 (${runId}) — verify ${summary.total_rounds}회, 시도 ${summary.attempts.length}건`, ''];
  for (const a of summary.attempts) {
    const roundsText = a.rounds.length === 1
      ? `${a.rounds[0]}회차`
      : `${a.rounds[0]}~${a.rounds.at(-1)}회차 (같은 스냅샷에서 같은 결과로 ${a.rounds.length}번 실행)`;
    lines.push(`시도 ${a.attempt}: ${a.technical_status} — ${roundsText}, ${a.last_recorded_at}`);
    lines.push(`  스냅샷 ${a.target_snapshot_digest.slice(0, 12)}`);
    if (a.changes) {
      const c = a.changes;
      if (!c.snapshot_changed) lines.push('  직전 시도와 같은 스냅샷 (코드는 그대로이고 결과만 달라짐)');
      if (c.fixed.length > 0) lines.push(`  고쳐짐 (FAIL → PASS): ${c.fixed.join(', ')}`);
      if (c.regressed.length > 0) lines.push(`  새로 실패 (PASS → FAIL): ${c.regressed.join(', ')}`);
      if (c.still_failing.length > 0) lines.push(`  계속 실패: ${c.still_failing.join(', ')}`);
      if (c.newly_run.length > 0) lines.push(`  이번에 처음 실행: ${c.newly_run.join(', ')}`);
      if (c.no_longer_run.length > 0) lines.push(`  이번에는 실행 안 됨: ${c.no_longer_run.join(', ')}`);
    }
    for (const check of a.checks.filter((x) => FAILING.has(x.status))) {
      lines.push(`  ${check.status} ${check.id} (${check.kind}): ${check.reason ?? '사유 없음'}`);
      const logs = [check.archived_stderr, check.archived_stdout].filter(Boolean);
      if (logs.length > 0) lines.push(`    당시 출력: ${logs.join(', ')}`);
    }
    const other = a.failure_reasons.filter((r) => !/^AC_(FAILED|BLOCKED):/.test(r));
    if (other.length > 0) lines.push(`  그 밖의 실패 사유: ${other.join('; ')}`);
    lines.push('');
  }
  return lines.join('\n');
}
