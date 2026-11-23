import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeHostId } from '../hosts/registry.mjs';
import { runDoctor } from './doctor.mjs';
import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import { runGit } from './lib/git.mjs';
import { runInterview } from './interview.mjs';
import { approveContractFile } from './contract.mjs';
import { initCheckpoint } from './checkpoint.mjs';
import { recordRedEvidence, runVerify } from './verify.mjs';
import { publishReviewPackage } from './review-package.mjs';
import { recordHumanDecision } from './approval.mjs';
import { lockApprovedSkills } from './skills.mjs';

/**
 * Create Section 14.2 compliant metrics object where unmeasured provider metrics are strictly `"unknown"`.
 */
function buildMetricsRecord(overrides = {}) {
  return {
    lead_input_equivalent_tokens: 'unknown',
    total_provider_tokens: 'unknown',
    measured_or_estimated_cost: 'unknown',
    wall_time_ms: overrides.wall_time_ms ?? 0,
    worker_calls: overrides.worker_calls ?? 0,
    lead_interventions: overrides.lead_interventions ?? 0,
    retries: overrides.retries ?? 0,
    acceptance_pass_rate: overrides.acceptance_pass_rate ?? 0,
    hidden_test_pass_rate: overrides.hidden_test_pass_rate ?? 'unknown',
    escaped_regression_count: overrides.escaped_regression_count ?? 0,
    wrong_complete_count: overrides.wrong_complete_count ?? 0,
    false_acceptance_count: overrides.false_acceptance_count ?? 0,
    scope_violation_count: overrides.scope_violation_count ?? 0,
    human_rework_minutes: 'unknown',
    review_package_preparation_minutes: overrides.review_package_preparation_minutes ?? 'unknown',
    human_review_minutes: 'unknown',
    reviewer_questions_count: 'unknown',
    evidence_broken_links_count: overrides.evidence_broken_links_count ?? 0,
    critical_missed_disclosures_count: overrides.critical_missed_disclosures_count ?? 0,
    human_changes_requested_rate: overrides.human_changes_requested_rate ?? 0,
    verification_level: overrides.verification_level ?? 'none',
    e2e_pass_rate: overrides.e2e_pass_rate ?? 'unknown',
    property_counterexample_count: overrides.property_counterexample_count ?? 0,
    differential_mismatch_count: overrides.differential_mismatch_count ?? 0,
    flaky_test_count: 0,
    recheck_after_mutation_count: overrides.recheck_after_mutation_count ?? 0,
    stale_review_rejection_count: overrides.stale_review_rejection_count ?? 0,
    review_raw_recall: 'unknown',
    review_verified_recall: 'unknown',
    review_final_recall: 'unknown',
    false_positive_rate: 'unknown',
    must_fix_precision: 'unknown',
    stable_change_overflag_rate: 'unknown',
    kouetsu_blindspot_count: overrides.kouetsu_blindspot_count ?? 0,
    kouetsu_inconsistency_count: overrides.kouetsu_inconsistency_count ?? 0,
    reviewer_actionability_score: 'unknown',
    interview_turns: overrides.interview_turns ?? 1,
    unresolved_blockers: overrides.unresolved_blockers ?? 0,
    skill_trigger_precision: 'unknown',
  };
}

function setupTempGitFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-bench-'));
  runGit(dir, ['init', '-b', 'main']);
  runGit(dir, ['config', 'user.name', 'CraftHelm Benchmark']);
  runGit(dir, ['config', 'user.email', 'bench@crafthelm.local']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'Initial benchmark baseline']);
  return dir;
}

/**
 * Run deterministic golden tasks E01-E04 and E10 for M0 validation (Section 14 & 19).
 */
export function runDeterministicBenchmark(options = {}) {
  const host = normalizeHostId(options.host ?? 'generic');
  const results = [];
  const tempDirs = [];

  try {
    // E01: Simple 1-file edit
    {
      const t0 = Date.now();
      const repo = setupTempGitFixture({
        'README.md': '# E01 Demo\n',
        'src/greet.mjs': 'export function greet(name) { return `hi ${name}`; }\n',
        'tests/unit.test.mjs': "import assert from 'node:assert/strict'; import { greet } from '../src/greet.mjs'; assert.equal(greet('world'), 'hi world');\n",
        'tests/e2e.test.mjs': "import assert from 'node:assert/strict'; import { greet } from '../src/greet.mjs'; assert.equal(greet('crafthelm'), 'hi crafthelm');\n",
      });
      tempDirs.push(repo);
      const iv = runInterview({
        repo,
        taskId: 'E01',
        request: 'Adjust greeting prefix to hello',
        host,
        inputData: {
          scope: { allow: ['src/**', 'tests/**'], protect: ['README.md'] },
          acceptance: [
            { id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node tests/unit.test.mjs', expected_exit_code: 0 },
            { id: 'AC-02', requirement: 'REQ-01', kind: 'e2e', command: 'node tests/e2e.test.mjs', expected_exit_code: 0 },
          ],
        },
      });
      approveContractFile(iv.contract_path, 'bench-operator');
      lockApprovedSkills({ repo, host });
      initCheckpoint({ repo, contract: iv.contract_path, runId: 'E01-RUN' });
      fs.writeFileSync(path.join(repo, 'src/greet.mjs'), 'export function greet(name) { return `hello ${name}`; }\n', 'utf8');
      fs.writeFileSync(path.join(repo, 'tests/unit.test.mjs'), "import assert from 'node:assert/strict'; import { greet } from '../src/greet.mjs'; assert.equal(greet('world'), 'hello world');\n", 'utf8');
      fs.writeFileSync(path.join(repo, 'tests/e2e.test.mjs'), "import assert from 'node:assert/strict'; import { greet } from '../src/greet.mjs'; assert.equal(greet('crafthelm'), 'hello crafthelm');\n", 'utf8');
      const v = runVerify({ repo, runId: 'E01-RUN' });
      const pkg = publishReviewPackage({ repo, runId: 'E01-RUN' });
      const acc = recordHumanDecision({ repo, runId: 'E01-RUN', decision: 'accept', actor: 'bench-human', rationale: 'E01 verified' });
      results.push({
        id: 'E01',
        name: '1-file simple change',
        passed: v.ok && pkg.ok && acc.state === 'ACCEPTED',
        arm: 'B_crafthelm_deterministic',
        metrics: buildMetricsRecord({
          wall_time_ms: Date.now() - t0,
          acceptance_pass_rate: 1,
          verification_level: v.verification_level,
          e2e_pass_rate: 1,
        }),
      });
    }

    // E02: Multi-file feature addition with RED-First + E2E
    {
      const t0 = Date.now();
      const repo = setupTempGitFixture({
        'README.md': '# E02 Demo\n',
        'src/store.mjs': 'export const items = [];\n',
        'tests/feature.test.mjs': "import assert from 'node:assert/strict'; import { add } from '../src/math.mjs'; assert.equal(add(2, 3), 5);\n",
        'tests/e2e.test.mjs': "import assert from 'node:assert/strict'; import { runFlow } from '../src/flow.mjs'; assert.equal(runFlow(2, 3), 'sum=5');\n",
      });
      tempDirs.push(repo);
      const iv = runInterview({
        repo,
        taskId: 'E02',
        request: 'Add multi-file math and flow helper',
        host,
        inputData: {
          scope: { allow: ['src/**', 'tests/**'], protect: ['README.md'] },
          acceptance: [
            { id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node tests/feature.test.mjs', expected_exit_code: 0, require_red_first: true },
            { id: 'AC-02', requirement: 'REQ-01', kind: 'e2e', command: 'node tests/e2e.test.mjs', expected_exit_code: 0 },
          ],
        },
      });
      approveContractFile(iv.contract_path, 'bench-operator');
      lockApprovedSkills({ repo, host });
      initCheckpoint({ repo, contract: iv.contract_path, runId: 'E02-RUN' });
      const red = recordRedEvidence({ repo, runId: 'E02-RUN', acId: 'AC-01' });
      fs.writeFileSync(path.join(repo, 'src/math.mjs'), 'export function add(a, b) { return a + b; }\n', 'utf8');
      fs.writeFileSync(path.join(repo, 'src/flow.mjs'), "import { add } from './math.mjs'; export function runFlow(a, b) { return `sum=${add(a, b)}`; }\n", 'utf8');
      const v = runVerify({ repo, runId: 'E02-RUN' });
      const pkg = publishReviewPackage({ repo, runId: 'E02-RUN' });
      results.push({
        id: 'E02',
        name: 'Multi-file feature with RED/GREEN',
        passed: red.ok && v.ok && pkg.ok && pkg.state === 'READY_FOR_HUMAN_REVIEW',
        arm: 'B_crafthelm_deterministic',
        metrics: buildMetricsRecord({
          wall_time_ms: Date.now() - t0,
          acceptance_pass_rate: 1,
          verification_level: v.verification_level,
          e2e_pass_rate: 1,
        }),
      });
    }

    // E03: Existing code refactor preserving baseline GREEN
    {
      const t0 = Date.now();
      const repo = setupTempGitFixture({
        'README.md': '# E03 Demo\n',
        'src/calc.mjs': 'export function total(xs) { let s = 0; for (const x of xs) s += x; return s; }\n',
        'tests/preserve.test.mjs': "import assert from 'node:assert/strict'; import { total } from '../src/calc.mjs'; assert.equal(total([1, 2, 3]), 6);\n",
      });
      tempDirs.push(repo);
      const iv = runInterview({
        repo,
        taskId: 'E03',
        request: 'Refactor total calculation preserving behavior',
        host,
        inputData: {
          change_kind: 'refactor',
          methodology: { lifecycle: 'incremental', specification: 'existing', engineering: 'characterization_first', execution: 'full' },
          scope: { allow: ['src/**'], protect: ['tests/preserve.test.mjs'] },
          acceptance: [
            { id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node tests/preserve.test.mjs', expected_exit_code: 0 },
          ],
        },
      });
      approveContractFile(iv.contract_path, 'bench-operator');
      lockApprovedSkills({ repo, host });
      initCheckpoint({ repo, contract: iv.contract_path, runId: 'E03-RUN' });
      fs.writeFileSync(path.join(repo, 'src/calc.mjs'), 'export function total(xs) { return xs.reduce((a, b) => a + b, 0); }\n', 'utf8');
      const v = runVerify({ repo, runId: 'E03-RUN' });
      results.push({
        id: 'E03',
        name: 'Refactor baseline GREEN preservation',
        passed: v.ok && v.technical_status === 'VERIFIED',
        arm: 'B_crafthelm_deterministic',
        metrics: buildMetricsRecord({
          wall_time_ms: Date.now() - t0,
          acceptance_pass_rate: 1,
          verification_level: v.verification_level,
        }),
      });
    }

    // E04: Ambiguous request -> INTERVIEW_REQUIRED
    {
      const t0 = Date.now();
      const repo = setupTempGitFixture({ 'README.md': '# E04 Demo\n' });
      tempDirs.push(repo);
      const iv = runInterview({
        repo,
        taskId: 'E04',
        request: 'Build auth flow',
        host,
        nonInteractive: true,
        inputData: {
          uncertainties: [{ id: 'BLK-1', level: 'BLOCKER', question: 'OAuth or local session?', resolved: false }],
        },
      });
      results.push({
        id: 'E04',
        name: 'Ambiguous request blocker identification',
        passed: !iv.ok && iv.status === 'INTERVIEW_REQUIRED' && iv.unresolved_blockers.length >= 1,
        arm: 'B_crafthelm_deterministic',
        metrics: buildMetricsRecord({
          wall_time_ms: Date.now() - t0,
          unresolved_blockers: iv.unresolved_blockers.length,
        }),
      });
    }

    // E10: Missing tool / single-model honesty (no false PASS)
    {
      const t0 = Date.now();
      const missingDoc = runDoctor({
        host: 'claude',
        runner: () => ({ exitCode: 127, stdout: '', stderr: 'not found' }),
        resolve: () => ({ found: false, path: null, kind: null }),
      });
      const singleDoc = runDoctor({
        host: 'codex',
        singleModel: true,
        runner: (cmd, args) => {
          if (args[0] === '--version') return { exitCode: 0, stdout: 'codex-cli 0.169.0\n', stderr: '' };
          return { exitCode: 0, stdout: 'exec review sandbox --model\n', stderr: '' };
        },
        resolve: () => ({ found: true, path: 'codex.cmd', kind: 'cmd' }),
      });
      results.push({
        id: 'E10',
        name: 'Missing CLI / single-model honest limitation reporting',
        passed:
          !missingDoc.ok &&
          missingDoc.hosts.claude.status === 'UNAVAILABLE' &&
          singleDoc.ok &&
          singleDoc.hosts.codex.independent_cross_model_review === 'UNAVAILABLE_SINGLE_PROVIDER' &&
          singleDoc.hosts.codex.worker_roles.reviewer.independent_cross_model_review === 'UNVERIFIED',
        arm: 'C_single_model_honesty',
        metrics: buildMetricsRecord({
          wall_time_ms: Date.now() - t0,
          acceptance_pass_rate: 1,
        }),
      });
    }
  } finally {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  return {
    schema_version: '0.3',
    mode: 'deterministic',
    host,
    generated_at: new Date().toISOString(),
    note: 'Token and dollar cost fields are reported as "unknown" unless directly measured from live host output.',
    all_passed: results.every((r) => r.passed),
    results,
  };
}

export function formatBenchmarkMarkdown(report) {
  const lines = [
    '# CraftHelm M0-01 Benchmark Report',
    '',
    `- Mode: \`${report.mode}\` | Host: \`${report.host}\` | Generated: \`${report.generated_at}\``,
    `- Summary: **${report.all_passed ? 'ALL_PASSED' : 'FAILURES_PRESENT'}**`,
    `- Measurement Policy: ${report.note}`,
    '',
    '| ID | Task | Arm | Passed | Wall Time (ms) | Verification Level | Lead Input Tokens | Total Cost |',
    '|---|---|---|---|---|---|---|---|',
    ...report.results.map(
      (r) => `| ${r.id} | ${r.name} | ${r.arm} | ${r.passed ? 'PASS' : 'FAIL'} | ${r.metrics.wall_time_ms} | ${r.metrics.verification_level} | ${r.metrics.lead_input_equivalent_tokens} | ${r.metrics.measured_or_estimated_cost} |`,
    ),
    '',
  ];
  return lines.join('\n');
}

function printUsage() {
  process.stdout.write(
    [
      'CraftHelm Deterministic Benchmark CLI (E01-E04, E10 Harness)',
      '',
      'Usage: benchmark.mjs [--host generic|claude|codex|antigravity|custom] [--output <report.md>]',
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
  const report = runDeterministicBenchmark({ host: args.host ?? 'generic' });
  if (args.output) {
    const outPath = path.resolve(args.output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, formatBenchmarkMarkdown(report), 'utf8');
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.all_passed ? 0 : 1);
}
