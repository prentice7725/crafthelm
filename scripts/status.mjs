import fs from 'node:fs';
import path from 'node:path';
import { statusCheckpoint } from './checkpoint.mjs';
import { checkContractReadiness } from './contract.mjs';
import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import { explainRun, formatExplainText } from './lib/explain-run.mjs';
import { computeSnapshotDigest } from './lib/git.mjs';
import { cliInvocation, getCheckpointPath, toPosixPath } from './lib/paths.mjs';
import { STATES } from './lib/state-machine.mjs';

export const TERMINAL_STATES = new Set([
  STATES.ACCEPTED,
  STATES.REJECTED,
  STATES.CLOSED_UNACCEPTED,
  STATES.ABORTED,
]);

function quoteArg(value) {
  const str = String(value ?? '.');
  return /\s/.test(str) ? `"${str}"` : str;
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Determine recommended next human/lead action and copy-ready CLI command for a run.
 * @param {{ run_id: string, state: string, snapshot_stale?: boolean }} runSummary
 * @param {string} [repoArg]
 * @returns {{ next_action: string, next_command: string }}
 */
export function recommendNextActionForRun(runSummary, repoArg = '.') {
  const runId = runSummary.run_id;
  const state = runSummary.state;
  const repoFlag = quoteArg(repoArg);

  if (state === STATES.READY_FOR_HUMAN_REVIEW) {
    if (runSummary.snapshot_stale) {
      return {
        next_action: '작업 트리가 변경되어 스냅샷이 stale 상태입니다. 재검증을 실행한 뒤 검토 보고서를 다시 발행하세요.',
        next_command: `${cliInvocation()} verify --repo ${repoFlag} --run-id ${runId}`,
      };
    }
    return {
      next_action: '기술 검증과 검토 보고서가 준비되었습니다. 사람의 최종 인수 결정을 기록하세요.',
      next_command: `${cliInvocation()} approve record --repo ${repoFlag} --run-id ${runId} --decision ACCEPTED --actor <name> --rationale "검토 완료"`,
    };
  }

  if (state === STATES.BLOCKED_HUMAN_ATTENTION) {
    return {
      next_action: '복구 한도를 넘어 사람의 판단이 필요합니다. evidence/escalation.json을 확인한 뒤 수동 수정 후 재개하거나 재계획하세요.',
      next_command: `${cliInvocation()} checkpoint resume --repo ${repoFlag} --run-id ${runId}`,
    };
  }

  if (state === STATES.REPLAN_REQUIRED) {
    return {
      next_action: '계약 또는 기준 문서(SOT)가 변경되어 재계획이 필요합니다.',
      next_command: `${cliInvocation()} checkpoint replan --repo ${repoFlag} --run-id ${runId} --reason "계약 변경 반영"`,
    };
  }

  if (state === STATES.PAUSED) {
    return {
      next_action: '일시 중지된 실행입니다. 핸드오프 패킷을 생성해 작업을 재개하세요.',
      next_command: `${cliInvocation()} checkpoint resume --repo ${repoFlag} --run-id ${runId}`,
    };
  }

  if (state === STATES.VERIFYING || state === STATES.REVIEW_PACKAGE_DRAFT) {
    return {
      next_action: '검증을 마무리하고 사람 검토용 보고서(review-package)를 발행하세요.',
      next_command: `${cliInvocation()} review-package --repo ${repoFlag} --run-id ${runId}`,
    };
  }

  if (state === STATES.REPAIRING || state === STATES.CHANGES_REQUESTED) {
    return {
      next_action: '실패 원인 또는 수정 요청 사항을 해결한 뒤 선택적 검증을 다시 실행하세요.',
      next_command: `${cliInvocation()} verify --repo ${repoFlag} --run-id ${runId} --selective`,
    };
  }

  if (TERMINAL_STATES.has(state)) {
    return {
      next_action: `실행(${runId})이 종료 상태(${state})입니다. 새 작업을 시작할 수 있습니다.`,
      next_command: `${cliInvocation()} start "<새 작업 설명>" --repo ${repoFlag}`,
    };
  }

  return {
    next_action: '허용된 범위(scope.allow) 내에서 구현을 진행한 뒤 결정적 검증을 실행하세요.',
    next_command: `${cliInvocation()} verify --repo ${repoFlag} --run-id ${runId} --selective`,
  };
}

function recommendForPendingContract(contractInfo, repoArg) {
  const repoFlag = quoteArg(repoArg);
  const contractPath = quoteArg(toPosixPath(path.resolve(repoArg, contractInfo.contract_path)));
  if (contractInfo.warnings.some(w => w.code === 'E2E_MISSING')) {
    return {
      next_action: `계약(${contractInfo.task_id})에 실행 가능한 E2E 인수 기준을 추가하세요.`,
      next_command: `${cliInvocation()} contract add-e2e ${contractPath} --e2e-cmd "<E2E 명령>"`,
    };
  }
  if (contractInfo.warnings.some(w => w.code === 'LITE_TARGETED_TEST_MISSING')) {
    return {
      next_action: `경량 계약(${contractInfo.task_id})에 이번 변경을 직접 검사하는 테스트 명령을 추가하세요. 범용 테스트 명령 하나로는 E2E 면제를 받을 수 없습니다.`,
      next_command: `${cliInvocation()} contract add-test ${contractPath} --test-cmd "<전용 테스트 명령>"`,
    };
  }
  if (!contractInfo.policy_ready) {
    return {
      next_action: contractInfo.warnings.map(w => w.guidance).join(' '),
      next_command: `${cliInvocation()} contract validate ${contractPath}`,
    };
  }
  if (!contractInfo.contract_approved) {
    return {
      next_action: `계약(${contractInfo.task_id})의 스키마·정책 준비가 끝났습니다. 명시적으로 계약을 승인하세요.`,
      next_command: `${cliInvocation()} contract approve ${contractPath} --actor operator`,
    };
  }
  return {
    next_action: `승인된 계약(${contractInfo.task_id})의 실행 체크포인트를 초기화하세요.`,
    next_command: `${cliInvocation()} checkpoint init --repo ${repoFlag} --contract ${contractPath} --run-id ${contractInfo.task_id}-RUN-001`,
  };
}

function collectWorkspaceRuns(repoRoot, repoArg) {
  const runsRoot = path.join(repoRoot, '.crafthelm', 'runs');
  if (!fs.existsSync(runsRoot)) return [];

  const runs = [];
  // One digest for the listing. Hashing the tree again for every run made status take minutes in a
  // repository with large files and a few past runs.
  let currentSnapshot = null;
  for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cpPath = getCheckpointPath(repoRoot, entry.name);
    if (!fs.existsSync(cpPath)) continue;

    const cpRaw = readJsonSafe(cpPath);
    currentSnapshot ??= computeSnapshotDigest(repoRoot);
    const summary = statusCheckpoint({ repo: repoRoot, runId: entry.name, currentSnapshot });
    const recommendation = recommendNextActionForRun(summary, repoArg);
    runs.push({
      ...summary,
      terminal: TERMINAL_STATES.has(summary.state),
      updated_at: cpRaw?.updated_at ?? null,
      next_action: recommendation.next_action,
      next_command: recommendation.next_command,
    });
  }

  runs.sort((a, b) => {
    const tA = a.updated_at ? Date.parse(a.updated_at) : 0;
    const tB = b.updated_at ? Date.parse(b.updated_at) : 0;
    if (tB !== tA) return tB - tA;
    return a.run_id.localeCompare(b.run_id);
  });
  return runs;
}

function collectPendingContracts(repoRoot, runTaskIds) {
  const contractsDir = path.join(repoRoot, '.crafthelm', 'contracts');
  if (!fs.existsSync(contractsDir)) return [];

  const pending = [];
  for (const file of fs.readdirSync(contractsDir).sort()) {
    if (!file.endsWith('.json')) continue;
    const absPath = path.join(contractsDir, file);
    const contract = readJsonSafe(absPath);
    if (!contract?.task_id) continue;
    if (runTaskIds.has(contract.task_id)) continue;

    const readiness = checkContractReadiness(contract);
    pending.push({
      task_id: contract.task_id,
      title: contract.title ?? contract.request ?? contract.task_id,
      contract_path: toPosixPath(path.relative(repoRoot, absPath)),
      contract_approved: Boolean(contract.approval?.contract_approved),
      policy_ready: readiness.policy_ready,
      warnings: readiness.warnings,
    });
  }
  return pending;
}

/**
 * Inspect CraftHelm workspace status without modifying any files.
 * Auto-selects when exactly 1 active run exists, lists choices when multiple exist,
 * and suggests the exact next command.
 * @param {{ repo?: string, runId?: string, includeTerminal?: boolean }} [options]
 */
export function getWorkspaceStatus(options = {}) {
  const repoArg = options.repo ?? '.';
  const repoRoot = path.resolve(repoArg);

  if (options.runId) {
    const summary = statusCheckpoint({ repo: repoRoot, runId: options.runId });
    const cpRaw = readJsonSafe(getCheckpointPath(repoRoot, options.runId));
    const recommendation = recommendNextActionForRun(summary, repoArg);
    const selectedRun = {
      ...summary,
      terminal: TERMINAL_STATES.has(summary.state),
      updated_at: cpRaw?.updated_at ?? null,
      next_action: recommendation.next_action,
      next_command: recommendation.next_command,
    };
    return {
      ok: true,
      repo: repoRoot,
      mode: 'single_run',
      selected_run: selectedRun,
      active_runs: selectedRun.terminal ? [] : [selectedRun],
      terminal_runs: selectedRun.terminal ? [selectedRun] : [],
      pending_contracts: [],
      next_action: recommendation.next_action,
      next_command: recommendation.next_command,
    };
  }

  const allRuns = collectWorkspaceRuns(repoRoot, repoArg);
  const activeRuns = allRuns.filter((r) => !r.terminal);
  const terminalRuns = allRuns.filter((r) => r.terminal);
  const runTaskIds = new Set(allRuns.map((r) => r.task_id));
  const pendingContracts = collectPendingContracts(repoRoot, runTaskIds);

  if (activeRuns.length === 1) {
    const selected = activeRuns[0];
    return {
      ok: true,
      repo: repoRoot,
      mode: 'single_active_run',
      selected_run: selected,
      active_runs: activeRuns,
      terminal_runs: terminalRuns,
      pending_contracts: pendingContracts,
      next_action: selected.next_action,
      next_command: selected.next_command,
    };
  }

  if (activeRuns.length > 1) {
    const newest = activeRuns[0];
    return {
      ok: true,
      repo: repoRoot,
      mode: 'multiple_active_runs',
      selected_run: null,
      active_runs: activeRuns,
      terminal_runs: terminalRuns,
      pending_contracts: pendingContracts,
      next_action: `진행 중인 실행이 ${activeRuns.length}개 있습니다. --run-id <id>로 확인할 실행을 지정하세요.`,
      next_command: `${cliInvocation()} status --repo ${quoteArg(repoArg)} --run-id ${newest.run_id}`,
    };
  }

  if (pendingContracts.length === 1) {
    const contractInfo = pendingContracts[0];
    const rec = recommendForPendingContract(contractInfo, repoArg);
    return {
      ok: true,
      repo: repoRoot,
      mode: 'pending_contract',
      selected_run: null,
      active_runs: [],
      terminal_runs: terminalRuns,
      pending_contracts: pendingContracts,
      next_action: rec.next_action,
      next_command: rec.next_command,
    };
  }

  if (pendingContracts.length > 1) {
    const first = pendingContracts[0];
    const rec = recommendForPendingContract(first, repoArg);
    return {
      ok: true,
      repo: repoRoot,
      mode: 'multiple_pending_contracts',
      selected_run: null,
      active_runs: [],
      terminal_runs: terminalRuns,
      pending_contracts: pendingContracts,
      next_action: `실행 대기 중인 계약이 ${pendingContracts.length}개 있습니다(${pendingContracts.map((c) => c.task_id).join(', ')}).`,
      next_command: rec.next_command,
    };
  }

  return {
    ok: true,
    repo: repoRoot,
    mode: 'idle',
    selected_run: null,
    active_runs: [],
    terminal_runs: terminalRuns,
    pending_contracts: [],
    next_action: '진행 중인 작업이 없습니다. crafthelm start로 새 작업을 시작하세요.',
    next_command: `${cliInvocation()} start "<작업 설명>" --repo ${quoteArg(repoArg)}`,
  };
}

/**
 * Format status inspection result as human-readable Korean summary text.
 * @param {ReturnType<typeof getWorkspaceStatus>} result
 * @returns {string}
 */
export function formatStatusText(result) {
  const lines = [`CraftHelm 상태 (${result.mode}) — ${result.repo}`, ''];

  if (result.selected_run) {
    const r = result.selected_run;
    lines.push(
      `- 선택된 실행: ${r.run_id} (작업 ${r.task_id}, 호스트 ${r.host})`,
      `- 현재 상태: ${r.state} | 단계: ${r.current_stage} | 스냅샷 stale: ${r.snapshot_stale ? '예(재검증 필요)' : '아니오'}`,
    );
    if (r.blocked_reason) {
      lines.push(`- 차단 사유: ${r.blocked_reason}`);
    }
  } else if (result.active_runs.length > 1) {
    lines.push('활성 실행 목록:');
    for (const r of result.active_runs) {
      lines.push(`- ${r.run_id} | ${r.task_id} | ${r.state} (${r.current_stage})${r.snapshot_stale ? ' [STALE]' : ''}`);
    }
  } else if (result.pending_contracts.length > 0) {
    lines.push('실행 대기 중인 계약:');
    for (const c of result.pending_contracts) {
      lines.push(
        `- ${c.task_id}: ${c.title} | 승인=${c.contract_approved ? '완료' : '대기'} | E2E준비=${c.policy_ready ? '준비됨' : '누락'}`,
      );
    }
  } else {
    lines.push('- 활성 실행과 대기 계약이 없습니다.');
  }

  if (result.terminal_runs.length > 0 && !result.selected_run) {
    lines.push('', `최근 종료된 실행 (${result.terminal_runs.length}건):`);
    for (const t of result.terminal_runs.slice(0, 3)) {
      lines.push(`- ${t.run_id} (${t.task_id}): ${t.state}`);
    }
  }

  lines.push('', `다음 행동: ${result.next_action}`, `추천 명령: ${result.next_command}`, '');
  return lines.join('\n');
}

function printUsage() {
  process.stdout.write(
    [
      'CraftHelm Status CLI (Inspect Active Run, Pending Contracts & Next Action)',
      '',
      'Usage: status.mjs [--repo .] [--run-id <id>] [--explain] [--json]',
      '',
      '  --explain  Show why the last verify failed: failed checks, their commands, log paths, repair rounds left.',
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
    const res = getWorkspaceStatus({
      repo: args.repo ?? '.',
      runId: args['run-id'],
    });
    // --explain needs one run: the one named, or the only active one.
    const explain = args.explain && res.selected_run ? explainRun(res.repo, res.selected_run.run_id) : null;
    if (args.json) {
      process.stdout.write(`${JSON.stringify(explain ? { ...res, explain } : res, null, 2)}\n`);
    } else {
      process.stdout.write(formatStatusText(res));
      if (explain) process.stdout.write(formatExplainText(explain));
      else if (args.explain) process.stdout.write('--explain은 실행 하나를 대상으로 합니다. --run-id <id>로 실행을 지정하세요.\n');
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
