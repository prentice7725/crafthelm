import fs from 'node:fs';
import path from 'node:path';
import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import { sha256File } from './lib/crypto.mjs';
import { computeSnapshotDigest } from './lib/git.mjs';
import { runEditorialCheck, verifyKouetsuAsset } from './lib/kouetsu-check.mjs';
import {
  getCheckpointPath,
  getContractPath,
  getEditorialReportPath,
  getEvidenceManifestPath,
  getReviewPackageMetaPath,
  getReviewPackagePath,
  getRunDir,
  getVerificationStampPath,
} from './lib/paths.mjs';
import { assertValidSchema } from './lib/schema.mjs';
import { STATES, assertTransition } from './lib/state-machine.mjs';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function relFromReports(runRelPath) {
  if (!runRelPath) return 'none';
  if (runRelPath.startsWith('reports/')) {
    return `./${runRelPath.slice('reports/'.length)}`;
  }
  return `../${runRelPath}`;
}

function renderReviewPackageMarkdown({ contract, checkpoint, manifest, stamp, preset, impact }) {
  const e2eChecks = manifest.checks.filter((c) => c.kind === 'e2e');
  const e2eStatus = e2eChecks.length === 0
    ? 'UNVERIFIED'
    : e2eChecks.every((c) => c.status === 'PASS')
      ? 'PASS'
      : 'FAIL';
  const e2eLink = e2eChecks[0]?.stdout_file ? relFromReports(e2eChecks[0].stdout_file) : 'none';

  const unverifiedList = [...(stamp.unverified ?? [])];
  if (manifest.review?.status === 'NOT_RUN') {
    unverifiedList.push('AI 독립 리뷰 미실행(NOT_RUN)');
  }
  const unverifiedText = unverifiedList.length > 0 ? unverifiedList.join('; ') : '없음 (기계적 검증 범위 내)';

  const repairCounts = Object.entries(checkpoint.repair_rounds ?? {});
  const totalRepairs = repairCounts.reduce((acc, [, n]) => acc + n, 0);
  const repairLimit = contract.budgets?.max_worker_retries_per_cause ?? 3;

  const propCheck = manifest.checks.find((c) => c.kind === 'property');
  const diffCheck = manifest.checks.find((c) => c.kind === 'differential');
  const triggeredRules = manifest.reliability_checks.filter((r) => r.triggered);

  const acRows = manifest.checks.map((c) => {
    const evLink = c.stdout_file
      ? relFromReports(c.stdout_file)
      : c.diff_report_file
        ? relFromReports(c.diff_report_file)
        : 'none';
    const manualHint = c.status === 'UNVERIFIED'
      ? `직접 확인 필요 (${c.reason ?? 'manual'})`
      : c.status === 'SKIPPED_UNIMPACTED'
        ? `선택적 회귀 생략 (${c.selection_reason ?? 'unimpacted'})`
        : '기계적 검사 로그 및 기대 동작 일치 확인';
    return `| \`${c.id}\` | ${c.requirement ?? c.id} | ${c.kind} | ${c.status} | \`${evLink}\` | ${manualHint} |`;
  });

  const testLogLinks = manifest.checks
    .filter((c) => c.stdout_file)
    .map((c) => `\`${relFromReports(c.stdout_file)}\``)
    .join(', ') || '없음';

  const strength = manifest.evidence_strength ?? { level: 'unknown', signals: [] };
  const strengthLabel = {
    strong: '강함 (STRONG)',
    moderate: '보통 (MODERATE)',
    weak: '약함 (EVIDENCE_WEAK)',
    not_applicable: '해당 없음 (동작 변경 아님)',
    unknown: 'unknown (측정 기록 없음)',
  }[strength.level];
  const strengthKo = {
    NO_EXECUTED_PASSING_CHECK: ['실행되어 통과한 수용 기준이 없음', '변경된 동작을 직접 실행해 확인'],
    NO_TEST_REACHES_CHANGE: ['변경된 코드를 불러오거나 호출하는 테스트 파일이 없음', '통과한 테스트가 변경 코드를 실제로 실행하는지 직접 확인'],
    SINGLE_GENERIC_CHECK: ['실행된 검사가 범용 테스트 명령 하나뿐임', '이번 요청을 직접 단언하는 테스트가 있는지 확인'],
    NO_TEST_CHANGED: ['동작이 바뀌었는데 추가되거나 수정된 테스트가 없음', '기존 테스트가 새 동작을 단언하는지 확인하거나 테스트 추가 요청'],
    MUTANTS_SURVIVED: ['변경된 줄을 일부러 깨뜨렸는데도 통과한 검사가 실패하지 않은 경우가 있음', '`evidence/mutation-probe.json`의 살아남은 변이를 확인하고 해당 줄을 단언하는 테스트 요청'],
    IMPACT_INCONCLUSIVE: ['영향도 분석이 그래프를 만들지 못해 테스트 도달 여부를 알 수 없음', '변경된 코드 경로를 표본으로 직접 확인'],
  };
  const strengthSummary = strength.signals.length > 0
    ? strength.signals.map((s) => `\`${s.code}\``).join(', ')
    : '신호 없음';

  const delegation = manifest.delegation ?? { status: 'UNOBSERVED', record_count: 0, roles: [], tiers: [], models_requested: [] };
  const delegationLabel = {
    OBSERVED: '관측됨 (OBSERVED) — 스크립트가 워커를 실행하고 사용량을 기록',
    SELF_REPORTED: '자기 보고 (SELF_REPORTED) — 세션 내 워커가 결과 패킷만 제출, 실행은 관측되지 않음',
    MIXED: '혼합 (MIXED) — 관측 기록과 자기 보고가 섞여 있음',
    UNOBSERVED: '관측 안 됨 (UNOBSERVED) — 위임 기록 없음. 역할·모델 분리가 실제로 있었는지 알 수 없음',
  }[delegation.status];
  const delegationDetail = delegation.record_count > 0
    ? ` 기록 ${delegation.record_count}건, 역할 ${delegation.roles.join(', ') || 'none'}, 티어 ${delegation.tiers.join(', ') || 'none'}, 요청 모델 ${delegation.models_requested.join(', ') || 'unknown'}.`
    : '';

  const probe = manifest.mutation_probe ?? { status: 'NOT_REQUESTED', total: 0, killed: 0, survived: 0, evidence_file: null };
  const probeStatusText = probe.status === 'PROBED'
    ? `PROBED (제거 ${probe.killed}/${probe.total}, 생존 ${probe.survived})`
    : probe.status;

  const procProfile = manifest.process_profile ?? { profile: 'full', e2e_exempted: false };
  const profileText = procProfile.profile === 'lite'
    ? (procProfile.e2e_exempted
        ? `**경량 (lite)** — E2E 요구 면제 적용. 조건 충족: 소스 파일 ${procProfile.observed.changed_source_files}/${procProfile.limits.max_changed_source_files}개, 추가 줄 ${procProfile.observed.added_lines}/${procProfile.limits.max_added_lines}줄, 증거 강도 \`${procProfile.observed.evidence_strength}\`. 실제 실행 흐름은 검증되지 않았음`
        : '**경량 (lite)** — E2E 검사가 계약에 있어 면제를 쓰지 않음')
    : '**전체 (full)** — 면제 없음';

  const riskRows = [];
  if (procProfile.e2e_exempted) {
    riskRows.push('| medium | 경량 프로필로 E2E 실행 검증을 면제함 | 단위 검사가 놓친 통합 문제는 드러나지 않음 | 변경된 동작을 실제 실행 흐름에서 직접 확인 | 승인자 |');
  }
  for (const sig of strength.signals) {
    const [what, action] = strengthKo[sig.code] ?? [sig.detail, sig.human_check];
    riskRows.push(`| ${sig.weight === 'weak' ? 'medium' : 'low'} | 증거 강도 신호 (${sig.code}): ${what} | PASS가 이번 변경을 충분히 보증하지 못할 수 있음 | ${action} | 승인자 |`);
  }
  for (const item of unverifiedList) {
    riskRows.push(`| medium | 미검증 항목: ${item} | 사람이 직접 확인하지 않으면 누락 위험 | 승인 전 직접 확인 수행 | 승인자 |`);
  }
  for (const obs of manifest.reliability_checks.filter((r) => r.status === 'OBSERVED_FAIL')) {
    riskRows.push(`| low | observe 규칙 경고 (${obs.id}) | 동작 관찰 중(차단 미적용) | 필요 시 enforce 승격 검토 | 프로젝트 관리자 |`);
  }
  if (riskRows.length === 0) {
    riskRows.push('| none | 중대 미해결 기술 결함 미탐지 | 기계적 검증 범위 내 통과 | 최종 인수 범위 확인 | 승인자 |');
  }

  const firstExecCmd = manifest.checks.find((c) => c.command)?.command ?? 'not_available';
  const changedFilesSummary = manifest.scope.changed_files.length > 0
    ? manifest.scope.changed_files.map((f) => `\`${f}\``).join(', ')
    : '변경된 파일 없음';

  const regSel = manifest.regression_selection;
  const polyInfo = [];
  if (impact?.languages_detected?.length) polyInfo.push(`감지 언어: ${impact.languages_detected.join(', ')}`);
  if (impact?.test_runner) polyInfo.push(`러너: ${impact.test_runner}`);
  const polyText = polyInfo.length > 0 ? `, ${polyInfo.join(' · ')}` : '';
  const regLine = regSel
    ? `**회귀 테스트 선별:** 모드 \`${regSel.mode}\` (실행 ${regSel.executed_count}건, 미영향 생략 ${regSel.skipped_count}건${polyText}${regSel.fallback_reason ? `, 폴백 사유: ${regSel.fallback_reason}` : ''})  `
    : '**회귀 테스트 선별:** 전체 실행 (`full`)  ';
  const impactEvidenceRow = manifest.impact_analysis_file
    ? `| 변경 영향도 분석 | \`${relFromReports(manifest.impact_analysis_file)}\` | AST·콜 그래프 기반 변경 함수/클래스 및 테스트 선별 근거 |`
    : '| 변경 영향도 분석 | 미생성 | 영향도 분석 기록 없음 |';

  return [
    '# CraftHelm — 사람의 인수 검토 보고서 v0.3',
    '',
    '> **상태: 검토 대기 (READY_FOR_HUMAN_REVIEW)**  ',
    `> 프리셋: \`${preset}\` · 책임 경계: 자동 검사는 검사 조건만 확인합니다. AI의 검토 의견은 참고자료입니다. 인수 또는 반려는 승인자가 결정합니다.`,
    '',
    '## 1. 지금 결정해야 할 것',
    '',
    '| 항목 | 내용 |',
    '|---|---|',
    `| 작업 | \`${contract.task_id}\` — ${contract.title ?? contract.request} |`,
    `| 이번 승인 대상 | ${contract.scope.allow.join(', ')} (${manifest.scope.changed_files.length}개 파일 변경) |`,
    `| 실행 계약 승인 | \`${contract.approval?.contract_approved_by ?? 'unknown'}\` — 승인 경로: \`${contract.approval?.contract_approved_via ?? 'unknown'}\` (\`agent_session\`이면 AI 세션 안에서 실행된 승인) |`,
    `| 승인하면 달라지는 것 | ${contract.request} |`,
    `| 자동 검증 상태 | **${manifest.technical_status}** — 근거: \`../evidence-manifest.json\` |`,
    `| 검증 수준 | **${manifest.verification_level}** — \`none/partial/verified\`는 수행된 기술 검사의 범위만 의미 |`,
    `| 절차 프로필 | ${profileText} |`,
    `| 작업 위임 | **${delegationLabel}**.${delegationDetail} |`,
    `| 증거 강도 | **${strengthLabel}** — ${strengthSummary}. 통과한 검사가 이번 변경을 얼마나 직접 다루는지에 대한 기계적 등급 |`,
    `| 승인 대상 스냅샷 | \`${manifest.target_snapshot_digest}\` — 검증 스탬프: \`../${manifest.verification_stamp_file}\` |`,
    `| 실제 서비스/앱 실행 검증 | **${e2eStatus}** — 재현 링크: \`${e2eLink}\` |`,
    `| 아직 확인되지 않은 것 | ${unverifiedText} |`,
    '| 사람의 결정 | **미결정 (PENDING)** — `승인 / 수정 요청 / 추가 검증 / 반려` |',
    '',
    '**판단을 위해 확인할 핵심 질문:** 이번 변경 범위와 자동 실행 증거를 근거로 운영에 반영할지 결정해 주세요.',
    '',
    '## 2. 변경 내용',
    '',
    '### 변경 전',
    '',
    `기준선 \`${manifest.baseline_git_head}\` 상태에서 요청 작업(\`${contract.request}\`)이 미구현 또는 수정 전 상태였습니다.`,
    '',
    '### 변경 후',
    '',
    `작업자가 ${changedFilesSummary} 파일을 수정했고 상세 패치는 \`${relFromReports(manifest.scope.diff_file)}\`에 기록했습니다.`,
    '',
    `**영향 범위:** 허용 경로 \`${contract.scope.allow.join(', ')}\` 내 변경, 보호 경로 위반 ${manifest.scope.protected_violations.length}건.  `,
    `**호환성·되돌리기:** \`git checkout ${manifest.baseline_git_head}\` 또는 diff 되돌리기로 기준선 복구 가능합니다.`,
    '',
    '## 3. 요구사항과 검증 결과',
    '',
    '| 요구 ID / AC | 기대 동작 | 확인 방법 | 자동 검사 결과 | 근거 | 사람이 확인할 항목 |',
    '|---|---|---|---|---|---|',
    ...acRows,
    '',
    '> `PASS`는 기술 검사 결과이지 인간의 인수 승인을 뜻하지 않습니다. 수행하지 못한 검사는 `UNVERIFIED`로 기록합니다.',
    '',
    '## 4. 직접 확인할 시나리오',
    '',
    `1. **핵심 실행 흐름 확인** — 기준선 \`${manifest.baseline_git_head}\` 대비 변경 후 \`${firstExecCmd}\` 실행 시 계약의 모든 기대 동작이 재현되는지 확인합니다.`,
    '',
    `**자동 복구 시도:** ${totalRepairs}회 / 상한 ${repairLimit}회  `,
    '**실패가 지속되는 경우 사람에게 필요한 결정:** 에스컬레이션 없음',
    '',
    `**재현 환경:** Node.js ${process.version} (${process.platform})  `,
    `**재현 명령:** \`${firstExecCmd}\``,
    '',
    '## 5. 실행 검증의 범위와 한계',
    '',
    '| 검증 유형 | 적용 이유 | 상태 | 증거/반례 | 검토자가 재확인할 일 |',
    '|---|---|---|---|---|',
    `| E2E Smoke | ${e2eChecks.length > 0 ? '기능 동작 확인' : '계약에 미포함'} | ${e2eStatus} | \`${e2eLink}\` | 실제 실행 로그 확인 |`,
    `| Property | ${propCheck ? '불변식 검증' : '계약에 미포함'} | ${propCheck?.status ?? 'NOT_APPLICABLE'} | \`${propCheck?.counterexample_file ? relFromReports(propCheck.counterexample_file) : (propCheck?.stdout_file ? relFromReports(propCheck.stdout_file) : 'none')}\` | 경계값 시드 확인 |`,
    `| Differential | ${diffCheck ? '구버전 대조 검증' : '계약에 미포함'} | ${diffCheck?.status ?? 'NOT_APPLICABLE'} | \`${diffCheck?.diff_report_file ? relFromReports(diffCheck.diff_report_file) : 'none'}\` | 허용 차이 목록 확인 |`,
    `| Mutation Probe | 변경된 줄을 깨뜨린 뒤 통과 검사 재실행 | ${probeStatusText} | \`${probe.evidence_file ? relFromReports(probe.evidence_file) : 'none'}\` | 살아남은 변이가 가리키는 줄 확인 |`,
    `| Reliability Rules | ${triggeredRules.length > 0 ? triggeredRules.map((r) => r.id).join(', ') : '매칭 규칙 없음'} | ${triggeredRules.length > 0 ? triggeredRules.map((r) => r.status).join(', ') : 'SKIPPED'} | \`../${manifest.verification_stamp_file}\` | observe 경고 검토 |`,
    '',
    `**검증 정책 기준:** \`${stamp.policy_base_ref}\` / \`${stamp.policy_digest}\`  `,
    regLine,
    `**기준 미충족·차단 사유:** ${manifest.failure_reasons?.length ? manifest.failure_reasons.join('; ') : '없음'}  `,
    `**검증 대상이 달라졌는가:** ${stamp.stale ? '예 (STALE)' : '아니오 (동일 스냅샷 일치)'}`,
    '',
    '## 6. 위험 및 미해결 사항',
    '',
    '| 심각도 | 문제 | 영향 | 권고 | 결정권자 |',
    '|---|---|---|---|---|',
    ...riskRows,
    '',
    `${unverifiedList.length > 0 ? `미검증 항목 확인 필요: ${unverifiedText}` : '치명적 미해결 사항 없음 (기계적 검증 기준)'}`,
    '',
    '## 7. 근거 자료',
    '',
    '| 자료 | 식별자/경로 | 확인 사항 |',
    '|---|---|---|',
    `| 계약 기준선 | \`${manifest.contract_sha256}\` | 승인된 범위와 수용 기준 |`,
    `| 원본 코드 상태 | \`${manifest.baseline_git_head}\` | 변경 시작점 |`,
    `| 최종 코드 상태 | \`${manifest.final_tree_hash}\` | 이번 인수 대상 트리 |`,
    `| 변경 목록 | \`${relFromReports(manifest.scope.diff_file)}\` | 수정 범위 패치 |`,
    `| 자동 테스트 로그 | ${testLogLinks} | 실행 증거 |`,
    `| 검증 스탬프 | \`../${manifest.verification_stamp_file}\` | 코드 스냅샷·검증 정책·실행 검사 연결 |`,
    impactEvidenceRow,
    `| E2E 재현 또는 트레이스 | \`${e2eLink}\` | 사용자 흐름을 실제로 실행한 기록 |`,
    `| Reliability 검사 | \`../${manifest.verification_stamp_file}\` | 변경 사항에 대응하는 검증 규칙과 비발동 사유 |`,
    `| AI 리뷰 의견 | \`${manifest.review.findings_file ? relFromReports(manifest.review.findings_file) : '미실행(NOT_RUN)'}\` | 참고 의견이며 자동 확정 아님 |`,
    '| 문서 교열 보고 | `./editorial-report.json` | Kouetsu의 문서 교열 결과(사실 검증과 별개) |',
    '',
    '## 8. 검토자의 결정',
    '',
    '현재 상태: **미승인 (PENDING)**',
    '',
    '가능한 결정:',
    '',
    '- **인수 승인:** 변경 범위와 남은 위험을 확인하고 인수합니다.',
    '- **수정 요청:** 문제와 관련 요구 ID·재현 조건을 전달합니다.',
    '- **추가 검증:** 필요한 증거나 사용자 테스트를 지정합니다.',
    '- **반려:** 이번 산출물을 인수하지 않습니다.',
    '',
    `결정이 입력될 때만 사람 승인 레코드를 생성합니다 (\`node scripts/approval.mjs record --repo . --run-id ${manifest.run_id} --decision accept --actor <이름> --rationale "<사유>"\`). 이 명령은 AI 세션 밖의 터미널에서 승인자가 직접 실행해야 하며, AI 세션 안에서는 거부됩니다. AI가 이 칸을 임의로 채우거나 승인으로 해석하지 않습니다.`,
    '',
  ].join('\n');
}

function validateReportLinksAndAcParity(markdownText, manifest, reportPath, runDir) {
  const brokenLinks = [];
  const acMismatches = [];
  const reportDir = path.dirname(reportPath);

  // Check Markdown links [label](target)
  const mdLinkRegex = /\[[^\]]+\]\(([^)]+)\)/g;
  for (const match of markdownText.matchAll(mdLinkRegex)) {
    const target = match[1].trim();
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    const resolved = path.resolve(reportDir, target);
    if (!fs.existsSync(resolved)) {
      brokenLinks.push(target);
    }
  }

  // Check backticked relative evidence/reports paths
  const codePathRegex = /`((?:\.\.?\/)?(?:evidence|reports|approvals)\/[^`\s]+)`/g;
  for (const match of markdownText.matchAll(codePathRegex)) {
    const target = match[1].trim();
    const resolvedFromReports = path.resolve(reportDir, target);
    const resolvedFromRun = path.resolve(runDir, target);
    if (!fs.existsSync(resolvedFromReports) && !fs.existsSync(resolvedFromRun)) {
      brokenLinks.push(target);
    }
  }

  // Parse Section 3 AC table rows and verify parity with Evidence Manifest (H04)
  const sec3Match = markdownText.match(/##\s*3\.[^\n]*\n([\s\S]*?)(?=\n##\s*4\.|\n$)/);
  const parsedRows = new Map();
  if (sec3Match) {
    for (const line of sec3Match[1].split('\n')) {
      if (!line.trim().startsWith('|') || line.includes('---') || line.includes('요구 ID')) continue;
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.length >= 5) {
        const acId = cells[0].replace(/`/g, '').trim();
        const rowStatus = cells[3].replace(/[*`]/g, '').trim();
        const rowEvidence = cells[4].replace(/`/g, '').trim();
        parsedRows.set(acId, { status: rowStatus, evidence: rowEvidence });
      }
    }
  }

  for (const check of manifest.checks) {
    const row = parsedRows.get(check.id);
    if (!row) {
      acMismatches.push(`Missing AC "${check.id}" in Section 3 table`);
      continue;
    }
    if (row.status !== check.status) {
      acMismatches.push(`AC "${check.id}" status mismatch: report="${row.status}" vs manifest="${check.status}"`);
    }
    if (check.stdout_file && row.evidence !== 'none') {
      const expectedRel = relFromReports(check.stdout_file);
      if (row.evidence !== expectedRel && row.evidence !== check.stdout_file) {
        acMismatches.push(`AC "${check.id}" evidence link mismatch: report="${row.evidence}" vs manifest="${expectedRel}"`);
      }
    }
  }

  return {
    brokenLinks: [...new Set(brokenLinks)],
    acMismatches,
  };
}

/**
 * Publish the 8-section Human Review Package, validate links/AC parity, and execute Kouetsu editorial gate.
 * Stops strictly at `READY_FOR_HUMAN_REVIEW`; never creates `approvals/decision.json`.
 */
export function publishReviewPackage(options) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const runId = options.runId;
  const preset = options.preset ?? 'executive';
  const runDir = getRunDir(repoRoot, runId);

  const checkpointPath = getCheckpointPath(repoRoot, runId);
  const checkpoint = readJson(checkpointPath);
  const contract = readJson(options.contract ? path.resolve(options.contract) : getContractPath(repoRoot, checkpoint.task_id));
  const manifestPath = getEvidenceManifestPath(repoRoot, runId);
  const stampPath = getVerificationStampPath(repoRoot, runId);

  if (!fs.existsSync(manifestPath) || !fs.existsSync(stampPath)) {
    throw new Error('MISSING_EVIDENCE: Run scripts/verify.mjs before publishing review package.');
  }

  const manifest = readJson(manifestPath);
  const stamp = readJson(stampPath);
  const currentSnapshot = computeSnapshotDigest(repoRoot);

  // V03 / E19: Reject stale snapshots immediately
  if (currentSnapshot !== stamp.target_snapshot_digest || stamp.stale || manifest.review?.status === 'STALE') {
    stamp.stale = true;
    manifest.technical_status = 'STALE';
    writeJson(stampPath, stamp);
    writeJson(manifestPath, manifest);
    return {
      ok: false,
      error_code: 'STALE_SNAPSHOT',
      message: 'Target code snapshot changed since verification stamp; re-run verify.mjs before publishing review package.',
      expected_snapshot: stamp.target_snapshot_digest,
      current_snapshot: currentSnapshot,
    };
  }

  if (manifest.technical_status === 'FAILED' || manifest.technical_status === 'BLOCKED') {
    return {
      ok: false,
      error_code: 'TECHNICAL_VERIFICATION_NOT_PASSED',
      technical_status: manifest.technical_status,
      failure_reasons: manifest.failure_reasons ?? [],
      message: `Cannot publish acceptance review package when technical_status is ${manifest.technical_status}.`,
    };
  }

  const reportPath = getReviewPackagePath(repoRoot, runId);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  const impactAbs = manifest.impact_analysis_file ? path.join(runDir, manifest.impact_analysis_file) : null;
  const impact = impactAbs && fs.existsSync(impactAbs) ? readJson(impactAbs) : null;

  const markdownText = options.draftOverride
    ? fs.readFileSync(path.resolve(options.draftOverride), 'utf8').replace(/\r\n/g, '\n')
    : renderReviewPackageMarkdown({ contract, checkpoint, manifest, stamp, preset, impact });

  fs.writeFileSync(reportPath, markdownText, 'utf8');

  const requireKouetsu = contract.editorial?.require_kouetsu !== false;
  const editorialReportPath = getEditorialReportPath(repoRoot, runId);
  let editorialReport;

  if (options.noKouetsu) {
    editorialReport = {
      schema_version: '0.3',
      run_id: runId,
      host: contract.host,
      kouetsu_skill_id: 'kouetsu',
      kouetsu_version: '1.0.2',
      kouetsu_digest: null,
      executed: false,
      status: 'MISSING',
      language: contract.editorial?.language ?? 'ko',
      separate_reader_review: 'UNAVAILABLE',
      layers: { content: 'SKIPPED', clarity: 'SKIPPED', surface: 'SKIPPED' },
      findings: [{ layer: 'content', tag: 'kouetsu_skipped', severity: 'error', message: 'Kouetsu editorial check disabled or skipped (--no-kouetsu)' }],
      confirmation_markers: [],
      critical_confirmations: [],
      checked_at: new Date().toISOString(),
    };
    assertValidSchema('editorial-report', editorialReport, editorialReportPath);
    writeJson(editorialReportPath, editorialReport);
    if (requireKouetsu) {
      return {
        ok: false,
        error_code: 'KOUETSU_MISSING_BLOCKED',
        editorial_status: 'MISSING',
        editorial_report_file: 'reports/editorial-report.json',
        message: 'Kouetsu editorial check did not run and contract requires Kouetsu; READY_FOR_HUMAN_REVIEW blocked.',
      };
    }
  } else {
    const asset = verifyKouetsuAsset(contract.host, {
      kouetsuRoot: options.kouetsuRoot,
      homeDir: options.homeDir,
      repoRoot,
    });
    editorialReport = runEditorialCheck(markdownText, {
      runId,
      host: contract.host,
      language: contract.editorial?.language ?? 'ko',
      kouetsuAsset: asset,
      manifest,
      separateReaderResult: options.separateReaderResult,
    });
    assertValidSchema('editorial-report', editorialReport, editorialReportPath);
    writeJson(editorialReportPath, editorialReport);

    if (!asset.found || asset.status === 'TAMPERED') {
      return {
        ok: false,
        error_code: asset.status === 'TAMPERED' ? 'KOUETSU_TAMPERED_BLOCKED' : 'KOUETSU_MISSING_BLOCKED',
        editorial_status: editorialReport.status,
        editorial_report_file: 'reports/editorial-report.json',
        message: `Kouetsu asset status is ${asset.status}; cannot mark READY_FOR_HUMAN_REVIEW.`,
      };
    }
  }

  // H04 / E13: Verify link existence and AC/Evidence parity AFTER editorial report file exists
  const parity = validateReportLinksAndAcParity(markdownText, manifest, reportPath, runDir);
  if (parity.brokenLinks.length > 0 || parity.acMismatches.length > 0) {
    return {
      ok: false,
      error_code: 'REVIEW_PACKAGE_VALIDATION_FAILED',
      broken_links: parity.brokenLinks,
      ac_mismatches: parity.acMismatches,
      message: 'Review package has broken artifact links or AC status mismatches against Evidence Manifest.',
    };
  }

  // H07: Critical confirmation markers block acceptance submission
  if (editorialReport.critical_confirmations.length > 0) {
    assertTransition(checkpoint.state, STATES.BLOCKED);
    checkpoint.state = STATES.BLOCKED;
    checkpoint.blocked_reason = `Critical confirmation needed: ${editorialReport.critical_confirmations.join('; ')}`;
    checkpoint.updated_at = new Date().toISOString();
    assertValidSchema('checkpoint', checkpoint, `checkpoint ${runId}`);
    writeJson(checkpointPath, checkpoint);
    manifest.human_review.status = 'BLOCKED';
    manifest.human_review.editorial_report_file = 'reports/editorial-report.json';
    writeJson(manifestPath, manifest);

    return {
      ok: false,
      error_code: 'CRITICAL_CONFIRMATION_BLOCKED',
      state: STATES.BLOCKED,
      critical_confirmations: editorialReport.critical_confirmations,
      editorial_report_file: 'reports/editorial-report.json',
    };
  }

  if (editorialReport.status !== 'PASS') {
    return {
      ok: false,
      error_code: 'EDITORIAL_GATE_FAILED',
      editorial_status: editorialReport.status,
      findings: editorialReport.findings,
      editorial_report_file: 'reports/editorial-report.json',
    };
  }

  const reportSha = sha256File(reportPath);
  const sectionsPresent = [];
  for (let i = 1; i <= 8; i++) {
    const m = markdownText.match(new RegExp(`^##\\s*${i}\\.\\s+(.+)$`, 'm'));
    if (m) sectionsPresent.push(`${i}. ${m[1].trim()}`);
  }

  const meta = {
    schema_version: '0.3',
    run_id: runId,
    task_id: contract.task_id,
    preset,
    report_file: 'reports/review-package.md',
    report_sha256: reportSha,
    target_snapshot_digest: currentSnapshot,
    verification_stamp_file: manifest.verification_stamp_file,
    editorial_report_file: 'reports/editorial-report.json',
    sections_present: sectionsPresent,
    broken_links: [],
    ac_mismatches: [],
    critical_confirmations: [],
    generated_at: new Date().toISOString(),
  };
  assertValidSchema('review-package', meta, `review-package.meta ${runId}`);
  writeJson(getReviewPackageMetaPath(repoRoot, runId), meta);

  manifest.human_review = {
    status: 'READY_FOR_HUMAN_REVIEW',
    package_file: 'reports/review-package.md',
    package_sha256: reportSha,
    editorial_report_file: 'reports/editorial-report.json',
  };
  assertValidSchema('evidence', manifest, `evidence-manifest ${runId}`);
  writeJson(manifestPath, manifest);

  // Transition checkpoint strictly up to READY_FOR_HUMAN_REVIEW
  if (checkpoint.state !== STATES.REVIEW_PACKAGE_DRAFT && checkpoint.state !== STATES.READY_FOR_HUMAN_REVIEW) {
    assertTransition(checkpoint.state, STATES.REVIEW_PACKAGE_DRAFT);
    checkpoint.state = STATES.REVIEW_PACKAGE_DRAFT;
  }
  assertTransition(checkpoint.state, STATES.READY_FOR_HUMAN_REVIEW);
  checkpoint.state = STATES.READY_FOR_HUMAN_REVIEW;
  checkpoint.current_stage = 'review_package';
  delete checkpoint.blocked_reason;
  checkpoint.updated_at = new Date().toISOString();
  assertValidSchema('checkpoint', checkpoint, `checkpoint ${runId}`);
  writeJson(checkpointPath, checkpoint);

  return {
    ok: true,
    run_id: runId,
    state: STATES.READY_FOR_HUMAN_REVIEW,
    report_file: 'reports/review-package.md',
    report_sha256: reportSha,
    editorial_report_file: 'reports/editorial-report.json',
    editorial_status: editorialReport.status,
    target_snapshot_digest: currentSnapshot,
    human_decision: 'PENDING',
  };
}

function printUsage() {
  process.stdout.write(
    [
      'CraftHelm Review Package CLI (Generate Verified 8-Section Markdown Report + Kouetsu Check)',
      '',
      'Usage: review-package.mjs --repo <path> --run-id <id> [--contract <path>] [--preset <name>] [--no-kouetsu] [--kouetsu-root <path>]',
      '',
    ].join('\n'),
  );
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (isHelpRequested(argv)) {
    printUsage();
    process.exit(0);
  }
  const args = parseArgs(argv);
  try {
    const res = publishReviewPackage({
      repo: args.repo,
      runId: args['run-id'],
      contract: args.contract,
      preset: args.preset,
      noKouetsu: Boolean(args['no-kouetsu']),
      kouetsuRoot: args['kouetsu-root'],
      draftOverride: args['draft-override'],
    });
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    if (!res.ok) process.exit(1);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
