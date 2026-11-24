import fs from 'node:fs';
import path from 'node:path';
import { normalizeHostId } from '../hosts/registry.mjs';
import { withNewRun } from './checkpoint.mjs';
import { runDoctor } from './doctor.mjs';
import { allocateNextTaskId, runInterview } from './interview.mjs';
import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import { DEFAULT_IGNORED_DIRS } from './lib/impact-languages.mjs';
import { classifyApprovalChannel } from './lib/human-gate.mjs';
import { toPosixPath } from './lib/paths.mjs';
import { detectRepoTestRunners } from './lib/test-runners.mjs';

const PREFERRED_HOST_ORDER = ['codex', 'claude', 'antigravity', 'generic'];

function quoteArg(value) {
  const str = String(value ?? '.');
  return /\s/.test(str) ? `"${str}"` : str;
}

function collectRepoFiles(repoRoot) {
  const results = [];
  const walk = (dir, prefix) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) results.push(toPosixPath(rel));
    }
  };
  walk(repoRoot, '');
  return results;
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function suggestCommandsFromRepo(repoRoot, repoFiles, runners) {
  const pkg = readJsonSafe(path.join(repoRoot, 'package.json'));
  const scripts = pkg?.scripts ?? {};

  let suggestedTest = null;
  const rawTestScript = scripts.test ? String(scripts.test).trim() : '';
  if (rawTestScript && !rawTestScript.includes('no test specified')) {
    suggestedTest = 'npm test';
  } else if (runners.includes('pytest')) {
    suggestedTest = 'pytest';
  } else if (runners.includes('go-test')) {
    suggestedTest = 'go test ./...';
  } else if (runners.includes('cargo-test')) {
    suggestedTest = 'cargo test';
  } else if (runners.includes('vitest')) {
    suggestedTest = 'npx vitest run';
  } else if (runners.includes('jest')) {
    suggestedTest = 'npx jest';
  } else if (runners.includes('node-test')) {
    suggestedTest = 'node --test';
  } else if (runners.includes('maven')) {
    suggestedTest = 'mvn test';
  } else if (runners.includes('gradle')) {
    suggestedTest = fs.existsSync(path.join(repoRoot, 'gradlew')) ? './gradlew test' : 'gradle test';
  } else if (runners.includes('dotnet-test')) {
    suggestedTest = 'dotnet test';
  } else if (runners.includes('rspec')) {
    suggestedTest = fs.existsSync(path.join(repoRoot, 'Gemfile')) ? 'bundle exec rspec' : 'rspec';
  } else if (runners.includes('phpunit')) {
    suggestedTest = 'phpunit';
  } else if (runners.includes('ctest')) {
    suggestedTest = 'ctest --output-on-failure';
  } else {
    suggestedTest = 'node --test';
  }

  let suggestedE2e = null;
  if (scripts.e2e) {
    suggestedE2e = 'npm run e2e';
  } else if (scripts['test:e2e']) {
    suggestedE2e = 'npm run test:e2e';
  } else if (scripts['test:smoke']) {
    suggestedE2e = 'npm run test:smoke';
  } else {
    const e2eFile = repoFiles
      .filter((rel) => /(?:^|\/)(?:tests?|e2e)\/.*(?:e2e|smoke).*\.(?:mjs|js|ts|py|go)$/i.test(rel))
      .sort()[0];
    if (e2eFile) {
      if (e2eFile.endsWith('.py')) suggestedE2e = `pytest ${e2eFile}`;
      else if (e2eFile.endsWith('.go')) suggestedE2e = `go test ./${path.posix.dirname(e2eFile)}`;
      else if (e2eFile.endsWith('.mjs') || e2eFile.endsWith('.js')) suggestedE2e = `node ${e2eFile}`;
    }
  }

  return {
    suggested_test_command: suggestedTest,
    suggested_e2e_command: suggestedE2e,
  };
}

function selectHostFromDoctor(requestedHost, repoDefaultHost, doctor) {
  if (requestedHost) return normalizeHostId(requestedHost);
  if (repoDefaultHost) return normalizeHostId(repoDefaultHost);
  for (const candidate of PREFERRED_HOST_ORDER) {
    if (doctor.hosts?.[candidate]?.status === 'AVAILABLE') {
      return candidate;
    }
  }
  return 'generic';
}

function normalizeScopeAllow(rawScopeAllow) {
  if (!rawScopeAllow) return null;
  const items = (Array.isArray(rawScopeAllow) ? rawScopeAllow : [rawScopeAllow])
    .flatMap((entry) => String(entry).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

/**
 * Combined onboarding entrypoint: probe environment (`doctor`), detect repo test runners,
 * run `interview` without overwriting prior tasks, and return a single next command.
 * @param {object} [options]
 */
export function startTask(options = {}) {
  const repoArg = options.repo ?? '.';
  const repoRoot = path.resolve(repoArg);
  const repoConfig = readJsonSafe(path.join(repoRoot, '.crafthelm', 'config.json'));

  const doctor = runDoctor({
    host: options.host ?? repoConfig?.default_host ?? 'auto',
    repo: repoRoot,
    cli: options.cli,
    ...(options.doctorOptions ?? {}),
  });

  const selectedHost = selectHostFromDoctor(options.host, repoConfig?.default_host, doctor);
  const hostCaps = doctor.hosts?.[selectedHost] ?? null;

  const repoFiles = collectRepoFiles(repoRoot);
  const runnersInfo = detectRepoTestRunners(repoRoot, repoFiles);
  const cmdHints = suggestCommandsFromRepo(repoRoot, repoFiles, runnersInfo.runners);

  const detected = {
    selected_host: selectedHost,
    host_status: hostCaps?.status ?? 'UNAVAILABLE',
    runtime_node: doctor.runtime.node,
    git_available: doctor.runtime.git_available,
    languages: runnersInfo.languages,
    test_runners: runnersInfo.runners,
    suggested_test_command: cmdHints.suggested_test_command,
    suggested_e2e_command: cmdHints.suggested_e2e_command,
  };

  const requestText = String(options.request ?? '').trim();
  if (!requestText) {
    return {
      ok: false,
      status: 'REQUEST_REQUIRED',
      repo: repoRoot,
      detected,
      message: '작업 설명을 입력해 주세요. 예: crafthelm start "로그인 토큰 만료 버그 수정"',
      next_action: '아래 명령에 작업 설명을 넣어 인터뷰와 계약 생성을 시작하세요.',
      next_command: `node scripts/crafthelm.mjs start "<작업 설명>" --repo ${quoteArg(repoArg)}`,
    };
  }

  const scopeAllow = normalizeScopeAllow(options.scopeAllow);
  const e2eCommand = options.e2eCommand ? String(options.e2eCommand).trim() : '';
  const inputData = {};
  if (scopeAllow) {
    inputData.scope = {
      allow: scopeAllow,
      protect: ['tests/acceptance/**', 'docs/approved/**', 'REVIEW.md', '.crafthelm/reliability-rules.json'],
    };
  }
  // --test-cmd: the test written for this change (kind "unit"). A lite contract without E2E needs it,
  // because the umbrella command alone is graded SINGLE_GENERIC_CHECK (weak) and loses the exemption.
  const testCommand = options.testCommand ? String(options.testCommand).trim() : '';
  if (testCommand || !['npm test', 'node --test'].includes(cmdHints.suggested_test_command)) {
    const checks = [
      { kind: 'test', command: cmdHints.suggested_test_command },
      ...(testCommand ? [{ kind: 'unit', command: testCommand }] : []),
      ...(e2eCommand ? [{ kind: 'e2e', command: e2eCommand }] : []),
    ];
    inputData.acceptance = checks.map((c, i) => ({
      id: `AC-${String(i + 1).padStart(2, '0')}`,
      requirement: 'REQ-01',
      kind: c.kind,
      command: c.command,
      expected_exit_code: 0,
    }));
  }

  const taskId = options.taskId ?? allocateNextTaskId(repoRoot);
  const runId = options.runId ?? `${taskId}-RUN-001`;
  const interviewOptions = {
    repo: repoRoot,
    taskId,
    request: requestText,
    host: selectedHost,
    changeKind: options.changeKind,
    e2eCommand: e2eCommand || undefined,
    docsDir: options.docsDir,
    overwrite: Boolean(options.overwrite),
    approveContract: Boolean(options.approveContract),
    approvalChannel: options.approvalChannel,
    actor: options.actor,
    ...(options.strictInterview ? { strictInterview: true } : {}),
    ...(options.processProfile ? { processProfile: options.processProfile } : {}),
    ...(Object.keys(inputData).length > 0 ? { inputData } : {}),
  };
  const finish = initialize => finishStart({ options, repoArg, repoRoot, requestText, detected, cmdHints, runId, interviewOptions, initialize });
  if (!options.initRun || !options.approveContract) return finish();
  try {
    return withNewRun(repoRoot, runId, finish);
  } catch (err) {
    if (err.code !== 'RUN_EXISTS') throw err;
    return {
      ok: false, status: 'RUN_EXISTS', repo: repoRoot, detected,
      run: { run_id: runId, initialized: false, reason: 'RUN_EXISTS' },
      next_action: '기존 실행을 이어가세요.',
      next_command: `node scripts/crafthelm.mjs checkpoint resume --repo ${quoteArg(repoArg)} --run-id ${quoteArg(runId)}`,
    };
  }
}

function finishStart({ options, repoArg, repoRoot, requestText, detected, cmdHints, runId, interviewOptions, initialize }) {
  const iv = runInterview(interviewOptions);

  if (!iv.ok) {
    return {
      ok: false,
      status: iv.status,
      repo: repoRoot,
      detected,
      interview: iv,
      message: iv.message ?? '인터뷰 단계를 완료하려면 추가 정보가 필요합니다.',
      next_action:
        iv.status === 'TASK_EXISTS'
          ? '기존 작업 계약이 이미 있습니다. 새 ID로 만들려면 --task-id를 빼고 실행하거나, 덮어쓰려면 --overwrite를 추가하세요.'
          : '누락된 필수 항목(BLOCKER)을 보완해 다시 실행하세요.',
      next_command:
        iv.status === 'TASK_EXISTS'
          ? `node scripts/crafthelm.mjs start ${quoteArg(requestText)} --repo ${quoteArg(repoArg)} --task-id ${iv.task_id} --overwrite`
          : `node scripts/crafthelm.mjs start ${quoteArg(requestText)} --repo ${quoteArg(repoArg)}`,
    };
  }

  const contractDisplayPath = repoArg === '.'
    ? toPosixPath(path.relative(repoRoot, iv.contract_path))
    : toPosixPath(iv.contract_path);

  // --init-run: freeze the run baseline in the same call when the contract is already approved and ready.
  let run = null;
  if (options.initRun && iv.policy_ready && iv.status === 'CONTRACT_APPROVED') {
    const cp = initialize({ contract: iv.contract_path, docsDir: options.docsDir });
    run = { run_id: runId, initialized: true, state: cp.state, baseline_git_head: cp.baseline_git_head };
  } else if (options.initRun) {
    run = {
      run_id: runId,
      initialized: false,
      reason: !iv.policy_ready ? 'CONTRACT_POLICY_NOT_READY' : 'CONTRACT_NOT_APPROVED',
    };
  }

  let nextAction;
  let nextCommand;
  if (run?.initialized) {
    nextAction = '계약 승인과 실행 기준선 동결까지 끝났습니다. 허용 범위(scope.allow) 안에서 코드를 수정한 뒤 아래 명령으로 검증과 검토 보고서 발행을 한 번에 실행하세요.';
    nextCommand = `node scripts/crafthelm.mjs feedback --repo ${quoteArg(repoArg)} --run-id ${runId} --selective`;
  } else if (iv.warnings?.some((w) => w.code === 'LITE_PROFILE_NOT_ELIGIBLE')) {
    nextAction = '경량 프로필(lite)은 버그 수정(bugfix)에만 쓸 수 있습니다. 프로필을 빼고 다시 실행하세요.';
    nextCommand = `node scripts/crafthelm.mjs start ${quoteArg(requestText)} --repo ${quoteArg(repoArg)} --task-id ${iv.task_id} --overwrite`;
  } else if (iv.warnings?.some((w) => w.code === 'LITE_TARGETED_TEST_MISSING')) {
    nextAction = '경량 프로필(lite)은 E2E 대신 이번 변경을 직접 검사하는 테스트에 기대므로, 범용 테스트 명령 하나로는 면제를 받을 수 없습니다. 변경한 코드를 호출하는 테스트의 실행 명령을 계약에 추가하세요.';
    nextCommand = `node scripts/crafthelm.mjs contract add-test ${quoteArg(contractDisplayPath)} --test-cmd ${quoteArg('<전용 테스트 명령>')}`;
  } else if (!iv.policy_ready) {
    const hintE2e = cmdHints.suggested_e2e_command ?? '<E2E 또는 스모크 실행 명령>';
    nextAction = '기능 변경 계약에 E2E/스모크 확인 명령이 빠졌습니다. 아래 명령에 실제 동작 확인 명령을 지정해 계약을 보완하세요.';
    nextCommand = `node scripts/crafthelm.mjs contract add-e2e ${quoteArg(contractDisplayPath)} --e2e-cmd ${quoteArg(hintE2e)}`;
  } else if (iv.status === 'CONTRACT_PENDING') {
    nextAction = options.initRun
      ? '계약 스키마와 E2E 검증 기준이 준비되었습니다. 아래 명령으로 계약 승인과 실행 기준선 동결을 한 번에 수행하세요.'
      : '계약 스키마와 E2E 검증 기준이 준비되었습니다. 아래 명령으로 계약을 승인하세요.';
    nextCommand = `node scripts/crafthelm.mjs contract approve ${quoteArg(contractDisplayPath)} --actor operator${options.initRun ? ` --init-run --repo ${quoteArg(repoArg)}` : ''}`;
  } else {
    nextAction = '계약이 승인되었습니다. 아래 명령으로 실행 체크포인트를 초기화하세요.';
    nextCommand = `node scripts/crafthelm.mjs checkpoint init --repo ${quoteArg(repoArg)} --contract ${quoteArg(contractDisplayPath)} --run-id ${iv.task_id}-RUN-001`;
  }

  return {
    ok: true,
    status: iv.status,
    repo: repoRoot,
    task_id: iv.task_id,
    docs_dir: iv.docs_dir,
    contract_path: iv.contract_path,
    policy_ready: iv.policy_ready,
    warnings: iv.warnings,
    next_questions: iv.next_questions,
    generated_questions: iv.generated_questions,
    uncertainty_coverage: iv.uncertainty_coverage,
    detected,
    ...(run ? { run } : {}),
    next_action: nextAction,
    next_command: nextCommand,
  };
}

/**
 * Format `crafthelm start` output as concise Korean onboarding guidance.
 * @param {ReturnType<typeof startTask>} result
 * @returns {string}
 */
export function formatStartText(result) {
  const lines = [
    `CraftHelm 작업 시작 (${result.status}) — ${result.repo}`,
    '',
    `- 선택 호스트: ${result.detected.selected_host} (${result.detected.host_status})`,
    `- 감지 언어/러너: ${result.detected.languages.join(', ') || 'none'} | ${result.detected.test_runners.join(', ') || 'default'}`,
    `- 추천 테스트 명령: ${result.detected.suggested_test_command}${result.detected.suggested_e2e_command ? ` | E2E 후보: ${result.detected.suggested_e2e_command}` : ''}`,
  ];

  if (result.task_id) {
    lines.push(
      `- 작업 ID: ${result.task_id}`,
      `- 계약 파일: ${result.contract_path}`,
      `- 문서 폴더: ${result.docs_dir}`,
    );
  }
  if (result.run) {
    lines.push(
      result.run.initialized
        ? `- 실행 ID: ${result.run.run_id} (기준선 동결 완료)`
        : `- 실행 ID: ${result.run.run_id} (기준선 미생성: ${result.run.reason})`,
    );
  }
  if (result.next_questions?.length > 0) {
    lines.push('', '확인 필요 질문:');
    for (const q of result.next_questions) {
      lines.push(`- ${q}`);
    }
  }
  const generatedQuestions = result.generated_questions ?? result.interview?.generated_questions ?? [];
  if (generatedQuestions.length > 0) {
    lines.push('', '인터뷰에서 답하지 않은 생성 질문 (미답변 시 가정으로 진행):');
    for (const q of generatedQuestions) {
      lines.push(`- [${q.level}] ${q.id}: ${q.question}`);
    }
  }
  if (!result.ok && result.message) {
    lines.push('', `안내: ${result.message}`);
  }
  lines.push('', `다음 행동: ${result.next_action}`, `다음 명령: ${result.next_command}`, '');
  return lines.join('\n');
}

function printUsage() {
  process.stdout.write(
    [
      'CraftHelm Start CLI (Doctor + Repo Detection + Interview Onboarding)',
      '',
      'Usage: start.mjs "<task description>" [--repo .] [--host <host>] [--change-kind feature|bugfix|refactor|docs|research] [--e2e-cmd "<cmd>"] [--test-cmd "<cmd>"] [--scope-allow <globs>] [--task-id <id>] [--overwrite] [--approve-contract --actor <name>] [--init-run [--run-id <id>]] [--strict-interview] [--profile full|lite] [--json]',
      '',
      '  --profile lite   Small bugfix only: waives the E2E requirement while the diff stays within the lite limits',
      '                   and a tailored test reaches the change. verify fails with LITE_PROFILE_EXCEEDED otherwise.',
      '',
      '  --init-run   Also freeze the run baseline (checkpoint init) when the contract is approved and policy-ready,',
      '               so a small task needs only: start -> edit -> feedback -> human approve record.',
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
  const args = parseArgs(argv, { multiFlags: ['scope-allow'] });
  const requestArg = args.request ?? (args._.length > 0 ? args._.join(' ') : '');

  try {
    const res = startTask({
      repo: args.repo ?? '.',
      request: requestArg,
      host: args.host,
      cli: args.cli,
      taskId: args['task-id'],
      changeKind: args['change-kind'],
      e2eCommand: args['e2e-cmd'],
      testCommand: typeof args['test-cmd'] === 'string' ? args['test-cmd'] : undefined,
      scopeAllow: args['scope-allow'],
      docsDir: args['docs-dir'],
      overwrite: Boolean(args.overwrite),
      approveContract: Boolean(args['approve-contract']),
      approvalChannel: args['approve-contract'] ? classifyApprovalChannel() : undefined,
      actor: args.actor,
      initRun: Boolean(args['init-run']),
      strictInterview: Boolean(args['strict-interview']),
      processProfile: typeof args.profile === 'string' ? args.profile : undefined,
      runId: typeof args['run-id'] === 'string' ? args['run-id'] : undefined,
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else {
      process.stdout.write(formatStartText(res));
    }
    if (!res.ok) {
      process.exit(res.status === 'REQUEST_REQUIRED' || res.status === 'INTERVIEW_REQUIRED' ? 2 : 1);
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
