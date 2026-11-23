import fs from 'node:fs';
import path from 'node:path';
import { normalizeHostId } from '../hosts/registry.mjs';
import { checkContractReadiness } from './contract.mjs';
import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import { sha256CanonicalJson } from './lib/crypto.mjs';
import { getGitHead, isGitRepo, runGit } from './lib/git.mjs';
import { hasMemorySources, listDecisions, searchMemory } from './lib/memory.mjs';
import { getContractPath, toPosixPath } from './lib/paths.mjs';
import { assertValidSchema } from './lib/schema.mjs';

/**
 * Allocate the next sequential task ID (`CH-T001`, `CH-T002`, ...) in the repository.
 * @param {string} repoRoot
 * @returns {string}
 */
export function allocateNextTaskId(repoRoot) {
  const resolved = path.resolve(repoRoot);
  let maxNum = 0;

  const contractsDir = path.join(resolved, '.crafthelm', 'contracts');
  if (fs.existsSync(contractsDir)) {
    for (const entry of fs.readdirSync(contractsDir)) {
      const m = /^CH-T(\d+)\.json$/.exec(entry);
      if (m) {
        const num = Number(m[1]);
        if (num > maxNum) maxNum = num;
      }
    }
  }

  const taskDocsRoot = path.join(resolved, 'docs', 'tasks');
  if (fs.existsSync(taskDocsRoot)) {
    for (const entry of fs.readdirSync(taskDocsRoot)) {
      const m = /^CH-T(\d+)$/.exec(entry);
      if (m) {
        const num = Number(m[1]);
        if (num > maxNum) maxNum = num;
      }
    }
  }

  return `CH-T${String(maxNum + 1).padStart(3, '0')}`;
}

/**
 * Inspect authoritative project sources before generating interview artifacts.
 * @param {string} repoRoot
 * @returns {{ sot_sources: string[], package_json: object|null, git_head: string, recent_commits: string[] }}
 */
export function discoverProjectSot(repoRoot) {
  const resolved = path.resolve(repoRoot);
  const candidates = ['README.md', 'AGENTS.md', 'CLAUDE.md', 'package.json'];
  const sotSources = [];
  for (const rel of candidates) {
    if (fs.existsSync(path.join(resolved, rel))) {
      sotSources.push(rel);
    }
  }
  const docsDir = path.join(resolved, 'docs');
  if (fs.existsSync(docsDir)) {
    for (const entry of fs.readdirSync(docsDir)) {
      if (entry.endsWith('.md')) {
        sotSources.push(`docs/${entry}`);
      }
    }
  }
  for (const dec of listDecisions({ repo: resolved, includeSuperseded: false })) {
    sotSources.push(dec.source_path);
  }

  let pkg = null;
  const pkgPath = path.join(resolved, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch {
      pkg = null;
    }
  }

  const gitHead = isGitRepo(resolved) ? getGitHead(resolved) : 'NO_GIT';
  let recentCommits = [];
  if (gitHead !== 'NO_GIT' && gitHead !== 'UNBORN') {
    const logRes = runGit(resolved, ['log', '-n', '5', '--oneline']);
    if (logRes.exitCode === 0) {
      recentCommits = logRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }
  }

  return {
    sot_sources: sotSources.sort(),
    package_json: pkg,
    git_head: gitHead,
    recent_commits: recentCommits,
  };
}

/**
 * Run Source-First interview intake, classify uncertainties, and emit docs + contract.
 * Returns status `INTERVIEW_REQUIRED` without guessing whenever any `BLOCKER` remains unresolved.
 * @param {object} options
 */
export function runInterview(options = {}) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const sot = discoverProjectSot(repoRoot);
  const input = options.inputData ?? (options.inputPath ? JSON.parse(fs.readFileSync(options.inputPath, 'utf8')) : {});

  let repoConfig = null;
  const repoConfigPath = path.join(repoRoot, '.crafthelm', 'config.json');
  if (fs.existsSync(repoConfigPath)) {
    try {
      repoConfig = JSON.parse(fs.readFileSync(repoConfigPath, 'utf8'));
    } catch {
      repoConfig = null;
    }
  }

  const taskId = options.taskId ?? input.task_id ?? allocateNextTaskId(repoRoot);
  const contractPath = getContractPath(repoRoot, taskId);
  if (fs.existsSync(contractPath) && !options.overwrite) {
    return {
      ok: false,
      status: 'TASK_EXISTS',
      task_id: taskId,
      contract_path: contractPath,
      message: `Task contract "${taskId}" already exists. Pass --overwrite to update it or omit --task-id to create a new task.`,
      artifacts_written: [],
    };
  }

  const requestText = options.request ?? input.request ?? '';
  const host = normalizeHostId(options.host ?? input.host ?? process.env.CRAFTHELM_HOST ?? repoConfig?.default_host ?? 'generic');
  const hostConfig = options.hostConfig ?? input.host_config ?? repoConfig?.host_config;
  const docsRelDir = toPosixPath(options.docsDir ?? input.docs_dir ?? `docs/tasks/${taskId}`);

  const uncertainties = Array.isArray(input.uncertainties) ? [...input.uncertainties] : [];
  if (!requestText.trim()) {
    uncertainties.push({
      id: 'U-REQ',
      level: 'BLOCKER',
      question: 'Task request statement is empty.',
      resolved: false,
    });
  }
  if (options.nonInteractive && (!Array.isArray(input.acceptance) || input.acceptance.length === 0)) {
    uncertainties.push({
      id: 'U-AC',
      level: 'BLOCKER',
      question: 'No measurable acceptance criteria provided for non-interactive interview.',
      resolved: false,
    });
  }
  if (options.nonInteractive && (!input.scope?.allow || input.scope.allow.length === 0)) {
    uncertainties.push({
      id: 'U-SCOPE',
      level: 'BLOCKER',
      question: 'Allowed write scope (`scope.allow`) must be confirmed before autonomous execution.',
      resolved: false,
    });
  }

  const unresolvedBlockers = uncertainties.filter(
    (u) => u.level === 'BLOCKER' && !u.resolved && !u.answer && !u.resolution,
  );
  const assumables = uncertainties.filter((u) => u.level === 'ASSUMABLE');
  const deferred = uncertainties.filter((u) => u.level === 'DEFERRED');

  if (unresolvedBlockers.length > 0) {
    return {
      ok: false,
      status: 'INTERVIEW_REQUIRED',
      task_id: taskId,
      sot_sources: sot.sot_sources,
      unresolved_blockers: unresolvedBlockers,
      assumables,
      deferred,
      artifacts_written: [],
    };
  }

  const methodology = {
    lifecycle: input.methodology?.lifecycle ?? 'incremental',
    specification: input.methodology?.specification ?? 'sdd',
    engineering: input.methodology?.engineering ?? 'tdd',
    execution: input.methodology?.execution ?? 'full',
  };

  const acceptance = Array.isArray(input.acceptance) && input.acceptance.length > 0
    ? input.acceptance
    : [
        {
          id: 'AC-01',
          requirement: 'REQ-01',
          kind: 'test',
          command: sot.package_json?.scripts?.test ? 'npm test' : 'node --test',
          expected_exit_code: 0,
        },
        ...(options.e2eCommand && String(options.e2eCommand).trim()
          ? [
              {
                id: 'AC-02',
                requirement: 'REQ-01',
                kind: 'e2e',
                command: String(options.e2eCommand).trim(),
                expected_exit_code: 0,
              },
            ]
          : []),
      ];

  const requirements = Array.isArray(input.requirements) && input.requirements.length > 0
    ? input.requirements
    : [
        {
          id: 'REQ-01',
          statement: requestText,
          source: input.source ?? 'user_interview',
          status: 'approved',
          assumption: 'none',
          approved_by: input.approved_by ?? 'pending_contract_approval',
        },
      ];

  const contract = {
    schema_version: '0.3',
    task_id: taskId,
    title: input.title ?? requestText.slice(0, 80),
    request: requestText,
    project_root: '.',
    host,
    ...(hostConfig ? { host_config: hostConfig } : {}),
    change_kind: options.changeKind ?? input.change_kind ?? 'feature',
    methodology,
    scope: {
      allow: input.scope?.allow ?? ['src/**', 'tests/**'],
      protect: input.scope?.protect ?? ['tests/acceptance/**', 'docs/approved/**', 'REVIEW.md', '.crafthelm/reliability-rules.json'],
    },
    approval: {
      contract_approved: Boolean(options.approveContract ?? input.contract_approved ?? false),
      ...(options.approveContract || input.contract_approved
        ? {
            contract_approved_by: input.approved_by ?? options.actor ?? 'operator',
            contract_approved_at: new Date().toISOString(),
          }
        : {}),
      require_on: input.approval?.require_on ?? ['scope_change', 'contract_change', 'deploy', 'external_transfer'],
    },
    budgets: {
      max_worker_retries_per_cause: Math.min(3, input.budgets?.max_worker_retries_per_cause ?? 3),
      max_lead_escalations: input.budgets?.max_lead_escalations ?? 3,
      max_wall_minutes: input.budgets?.max_wall_minutes ?? 120,
    },
    acceptance,
    source_policy: {
      authority: input.source_policy?.authority ?? ['project-sot', 'git-main'],
      source_refs: input.source_policy?.source_refs ?? (sot.sot_sources.length > 0 ? sot.sot_sources : ['README.md']),
    },
    editorial: {
      require_kouetsu: input.editorial?.require_kouetsu ?? true,
      language: input.editorial?.language ?? 'ko',
      preset: input.editorial?.preset ?? 'executive',
    },
    verification_policy: {
      policy_base_ref: input.verification_policy?.policy_base_ref ?? (sot.git_head !== 'NO_GIT' && sot.git_head !== 'UNBORN' ? sot.git_head : 'HEAD'),
      require_e2e_for_functional: input.verification_policy?.require_e2e_for_functional ?? true,
      ...(input.verification_policy?.reliability_rules_path ? { reliability_rules_path: input.verification_policy.reliability_rules_path } : {}),
      ...(input.verification_policy?.review_policy_path ? { review_policy_path: input.verification_policy.review_policy_path } : {}),
    },
  };

  assertValidSchema('execution', contract, `contract ${taskId}`);

  const docsAbsDir = path.join(repoRoot, docsRelDir);
  fs.mkdirSync(docsAbsDir, { recursive: true });

  const reqMd = [
    `# Requirements — ${taskId}`,
    '',
    `- Request: ${requestText}`,
    `- Host: ${host}`,
    `- SOT Sources Checked: ${sot.sot_sources.join(', ') || 'none'}`,
    '',
    '| ID | Statement | Source | Status | Assumption | Approved By |',
    '|---|---|---|---|---|---|',
    ...requirements.map((r) => `| ${r.id} | ${r.statement} | ${r.source} | ${r.status} | ${r.assumption ?? 'none'} | ${r.approved_by} |`),
    '',
  ].join('\n');

  const decMd = [
    `# Decisions — ${taskId}`,
    '',
    'Note: Contract approval authorizes scoped technical execution up to READY_FOR_HUMAN_REVIEW only. Final acceptance remains PENDING until human decision.',
    '',
    '| ID | Type | Decision / Assumption | Rationale | Source |',
    '|---|---|---|---|---|',
    ...assumables.map((a, idx) => `| DEC-${String(idx + 1).padStart(2, '0')} | ASSUMABLE | ${a.answer ?? a.default ?? a.question} | ${a.rationale ?? 'recorded assumption'} | interview |`),
    ...(assumables.length === 0 ? ['| DEC-00 | BASELINE | No extra assumable deviations recorded | — | interview |'] : []),
    '',
  ].join('\n');

  const openQMd = [
    `# Open Questions — ${taskId}`,
    '',
    ...(deferred.length > 0
      ? deferred.map((d) => `- [${d.id ?? 'DEFERRED'}] ${d.question} (owner: ${d.owner ?? 'operator'})`)
      : ['- No deferred questions recorded.']),
    '',
  ].join('\n');

  const accMd = [
    `# Acceptance Criteria — ${taskId}`,
    '',
    '| AC ID | Requirement | Kind | Command / Method | Expected |',
    '|---|---|---|---|---|',
    ...acceptance.map((ac) => `| ${ac.id} | ${ac.requirement} | ${ac.kind} | \`${ac.command ?? ac.manual_method}\` | ${ac.expected ?? `exit ${ac.expected_exit_code ?? 0}`} |`),
    '',
  ].join('\n');

  const writtenFiles = [];
  for (const [name, content] of [
    ['requirements.md', reqMd],
    ['decisions.md', decMd],
    ['open_questions.md', openQMd],
    ['acceptance.md', accMd],
  ]) {
    const outPath = path.join(docsAbsDir, name);
    fs.writeFileSync(outPath, content, 'utf8');
    writtenFiles.push(outPath);
  }

  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');
  writtenFiles.push(contractPath);

  const readiness = checkContractReadiness(contract);
  const nextQuestions = readiness.warnings.some((w) => w.code === 'E2E_MISSING')
    ? [
        '이 기능이 실제로 동작함을 확인할 E2E/스모크 명령은 무엇인가요? (--e2e-cmd "<명령>" 또는 계약 파일의 acceptance에 kind: "e2e" 항목 추가)',
      ]
    : [];

  const activeDecisions = listDecisions({ repo: repoRoot, includeSuperseded: false }).map((d) => ({
    id: d.id,
    title: d.title,
    source_path: d.source_path,
  }));
  const priorMemoryHits = requestText.trim() && hasMemorySources(repoRoot)
    ? searchMemory({ repo: repoRoot, query: requestText, limit: 5, docsDir: docsRelDir }).hits
    : [];

  return {
    ok: true,
    status: contract.approval.contract_approved ? 'CONTRACT_APPROVED' : 'CONTRACT_PENDING',
    task_id: taskId,
    docs_dir: docsRelDir,
    contract_path: contractPath,
    contract_sha256: sha256CanonicalJson(contract),
    policy_ready: readiness.policy_ready,
    warnings: readiness.warnings,
    next_questions: nextQuestions,
    sot_sources: sot.sot_sources,
    active_decisions: activeDecisions,
    prior_memory_hits: priorMemoryHits,
    unresolved_blockers: [],
    artifacts_written: writtenFiles,
  };
}

function printUsage() {
  process.stdout.write(
    [
      'CraftHelm Interview CLI (Source-First Intake & Execution Contract Generator)',
      '',
      'Usage: interview.mjs --request "<task description>" [--repo .] [--task-id <id>] [--change-kind feature|bugfix|refactor|docs|research] [--e2e-cmd "<cmd>"] [--host <host>] [--docs-dir <dir>] [--input <json>] [--overwrite] [--non-interactive] [--approve-contract --actor <name>]',
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
  const res = runInterview({
    repo: args.repo ?? '.',
    taskId: args['task-id'],
    request: args.request ?? args._[0],
    host: args.host,
    docsDir: args['docs-dir'],
    inputPath: args.input,
    changeKind: args['change-kind'],
    e2eCommand: args['e2e-cmd'],
    overwrite: Boolean(args.overwrite),
    nonInteractive: Boolean(args['non-interactive']),
    approveContract: Boolean(args['approve-contract']),
    actor: args.actor,
  });
  for (const w of res.warnings ?? []) {
    process.stderr.write(`[warning] ${w.code}: ${w.message}\n`);
  }
  process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  if (!res.ok) {
    process.exit(res.status === 'INTERVIEW_REQUIRED' ? 2 : 1);
  }
}
