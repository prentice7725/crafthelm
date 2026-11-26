import fs from 'node:fs';
import path from 'node:path';
import { getCheckpointPath, getContractPath, getEvidenceManifestPath, getRunDir, toPosixPath } from './paths.mjs';
import { readVerifyHistory, summarizeVerifyHistory } from './verify-history.mjs';

/**
 * Explain a run's last verification from what verify already stored: which checks failed, the
 * command each ran, where its output is, and how many repair rounds are left. Read-only.
 */

const FAILING = new Set(['FAIL', 'BLOCKED']);
const EXCERPT_LINES = 12;
const EXCERPT_CHARS = 1200;

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// The end of the output is where a test runner prints the assertion that failed.
function tailOf(file) {
  if (!file || !fs.existsSync(file)) return '';
  const lines = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trimEnd().split('\n');
  return lines.slice(-EXCERPT_LINES).join('\n').slice(-EXCERPT_CHARS);
}

/**
 * @param {string} repoRoot
 * @param {string} runId
 * @returns {object}
 */
export function explainRun(repoRoot, runId) {
  const runDir = getRunDir(repoRoot, runId);
  const repoRel = (runRel) => (runRel ? toPosixPath(path.relative(repoRoot, path.join(runDir, runRel))) : null);
  const checkpoint = readJsonSafe(getCheckpointPath(repoRoot, runId)) ?? {};
  const manifest = readJsonSafe(getEvidenceManifestPath(repoRoot, runId));
  if (!manifest) {
    return { run_id: runId, verified: false, state: checkpoint.state ?? null };
  }
  const contract = readJsonSafe(getContractPath(repoRoot, checkpoint.task_id)) ?? {};
  const acById = new Map((contract.acceptance ?? []).map((ac) => [ac.id, ac]));
  // The feedback packet is only current when the manifest of the same round points at it.
  const packet = manifest.feedback_packet_file ? readJsonSafe(path.join(runDir, manifest.feedback_packet_file)) : null;

  const failedChecks = manifest.checks.filter((c) => FAILING.has(c.status)).map((c) => {
    const stderr = c.stderr_file ? path.join(runDir, c.stderr_file) : null;
    const stdout = c.stdout_file ? path.join(runDir, c.stdout_file) : null;
    return {
      id: c.id,
      kind: c.kind,
      status: c.status,
      requirement: c.requirement ?? null,
      command: c.command ?? null,
      exit_code: c.exit_code ?? null,
      expected_exit_code: acById.get(c.id)?.expected_exit_code ?? 0,
      reason: c.reason ?? null,
      stdout_file: repoRel(c.stdout_file),
      stderr_file: repoRel(c.stderr_file),
      output_tail: tailOf(stderr) || tailOf(stdout),
    };
  });

  const limit = Math.min(3, contract.budgets?.max_worker_retries_per_cause ?? 3);
  const repairRounds = Object.entries(checkpoint.repair_rounds ?? {}).map(([cause, used]) => ({
    cause,
    used,
    limit,
    remaining: Math.max(0, limit - used),
  }));
  const currentCause = packet?.root_cause_category ?? null;
  if (currentCause && !repairRounds.some((r) => r.cause === currentCause)) {
    repairRounds.push({ cause: currentCause, used: 0, limit, remaining: limit });
  }

  const history = summarizeVerifyHistory(readVerifyHistory(runDir));
  return {
    run_id: runId,
    verified: true,
    state: checkpoint.state ?? null,
    technical_status: manifest.technical_status,
    evidence_strength: manifest.evidence_strength?.level ?? null,
    failed_checks: failedChecks,
    // Reasons that are not a failed check: scope, policy, E2E, review.
    other_failure_reasons: (manifest.failure_reasons ?? []).filter((r) => !/^AC_(FAILED|BLOCKED):/.test(r)),
    scope: {
      out_of_scope_files: manifest.scope?.out_of_scope_files ?? [],
      protected_violations: manifest.scope?.protected_violations ?? [],
    },
    human_checks: (manifest.evidence_strength?.signals ?? []).map((s) => ({ code: s.code, human_check: s.human_check, refs: s.refs ?? [] })),
    current_cause: currentCause,
    escalated: Boolean(packet?.escalate_to_human),
    repair_rounds: repairRounds,
    verify_rounds: history.total_rounds,
    last_change: history.attempts.at(-1)?.changes ?? null,
    manifest_file: toPosixPath(path.relative(repoRoot, getEvidenceManifestPath(repoRoot, runId))),
  };
}

/**
 * @param {ReturnType<typeof explainRun>} explain
 * @returns {string}
 */
export function formatExplainText(explain) {
  if (!explain.verified) {
    return `실패 원인 (${explain.run_id}): 아직 verify를 실행한 기록이 없습니다.\n`;
  }
  const lines = [`검증 결과 (${explain.run_id}): ${explain.technical_status} — verify ${explain.verify_rounds}회 실행`, ''];
  if (explain.failed_checks.length === 0 && explain.other_failure_reasons.length === 0) {
    lines.push('- 실패한 검사가 없습니다.');
  }
  for (const c of explain.failed_checks) {
    lines.push(`${c.status} ${c.id} (${c.kind})${c.requirement ? ` — ${c.requirement}` : ''}`);
    lines.push(`  실행한 명령: ${c.command ?? '없음'}`);
    lines.push(`  종료 코드: ${c.exit_code ?? '없음'} (기대값 ${c.expected_exit_code})`);
    if (c.reason) lines.push(`  판정 사유: ${c.reason}`);
    if (c.stderr_file) lines.push(`  오류 로그: ${c.stderr_file}`);
    if (c.stdout_file) lines.push(`  출력 로그: ${c.stdout_file}`);
    if (c.output_tail) {
      lines.push('  출력 끝부분:');
      for (const line of c.output_tail.split('\n')) lines.push(`    ${line}`);
    }
    lines.push('');
  }
  if (explain.other_failure_reasons.length > 0) {
    lines.push('검사 밖의 실패 사유:');
    for (const reason of explain.other_failure_reasons) lines.push(`- ${reason}`);
    lines.push('');
  }
  if (explain.last_change) {
    const c = explain.last_change;
    const parts = [];
    if (c.fixed.length > 0) parts.push(`고쳐짐 ${c.fixed.join(', ')}`);
    if (c.regressed.length > 0) parts.push(`새로 실패 ${c.regressed.join(', ')}`);
    if (c.still_failing.length > 0) parts.push(`계속 실패 ${c.still_failing.join(', ')}`);
    if (parts.length > 0) lines.push(`직전 시도 대비: ${parts.join(' / ')}`);
  }
  for (const r of explain.repair_rounds) {
    const current = r.cause === explain.current_cause ? ' (이번 실패의 원인)' : '';
    lines.push(`복구 횟수 ${r.cause}${current}: ${r.used}/${r.limit} 사용, ${r.remaining}회 남음`);
  }
  if (explain.escalated) {
    lines.push('복구 한도를 넘었습니다. 다음 판단은 사람이 합니다.');
  }
  if (explain.human_checks.length > 0) {
    lines.push('', '통과와 별개로 사람이 확인할 것:');
    for (const h of explain.human_checks) {
      lines.push(`- ${h.code}: ${h.human_check}${h.refs.length > 0 ? ` (${h.refs.join(', ')})` : ''}`);
    }
  }
  lines.push('', `전체 기록: ${explain.manifest_file}`, '');
  return lines.join('\n');
}
