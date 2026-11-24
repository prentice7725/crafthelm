import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getHostAdapter } from '../../hosts/registry.mjs';
import { initCheckpoint } from '../checkpoint.mjs';
import { runDelegation, summarizeDelegations } from '../delegate.mjs';
import { runFeedbackLoop } from '../feedback-loop.mjs';
import { runInterview } from '../interview.mjs';
import { runShellCommand } from './exec.mjs';
import { runGit } from './git.mjs';
import { routeTask } from './model-router.mjs';

/**
 * Live A/B/C benchmark: replaces "unknown" cost fields with numbers read from real host output.
 *
 * Arms (docs/benchmarking.md):
 * - A: the host's top model does the task alone, no CraftHelm.
 * - B: CraftHelm contract + worker on the routed (cheaper) tier + deterministic verification.
 * - C: CraftHelm with the worker on the host's default single model.
 *
 * What is and is not measured: every arm records the tokens and cost the host CLI reports for the
 * worker invocation, wall time, and a hidden check the worker never saw. In B and C this harness plays
 * the lead deterministically, so an interactive lead's own tokens are NOT part of the number; they stay
 * "unknown". B/C figures are therefore a lower bound on a real CraftHelm session, and the report says so.
 */

export const LIVE_ARMS = Object.freeze(['A', 'B', 'C']);

const VISIBLE_TEST = 'tests/visible.test.mjs';

export const LIVE_TASKS = Object.freeze([
  {
    id: 'L01',
    name: 'Bugfix: inclusive range bounds',
    change_kind: 'bugfix',
    request: 'inRange(x, lo, hi) in src/range.mjs must treat both bounds as inclusive. Fix it.',
    files: {
      'README.md': '# L01\n',
      'src/range.mjs': 'export function inRange(x, lo, hi) {\n  return x > lo && x < hi;\n}\n',
      [VISIBLE_TEST]: "import assert from 'node:assert/strict';\nimport { inRange } from '../src/range.mjs';\nassert.equal(inRange(1, 1, 3), true);\n",
    },
    hidden_check: "import assert from 'node:assert/strict';\nimport { inRange } from '../src/range.mjs';\nassert.equal(inRange(1, 1, 3), true);\nassert.equal(inRange(3, 1, 3), true);\nassert.equal(inRange(2, 1, 3), true);\nassert.equal(inRange(0, 1, 3), false);\nassert.equal(inRange(4, 1, 3), false);\n",
  },
  {
    id: 'L02',
    name: 'Feature: slugify',
    change_kind: 'feature',
    request: 'Add and export slugify(text) in src/slug.mjs: lower-case, trim, collapse runs of non-alphanumeric characters into a single "-", and strip leading/trailing "-".',
    files: {
      'README.md': '# L02\n',
      'src/slug.mjs': 'export const SEPARATOR = \'-\';\n',
      [VISIBLE_TEST]: "import assert from 'node:assert/strict';\nimport { slugify } from '../src/slug.mjs';\nassert.equal(slugify('Hello World'), 'hello-world');\n",
    },
    hidden_check: "import assert from 'node:assert/strict';\nimport { slugify } from '../src/slug.mjs';\nassert.equal(slugify('Hello World'), 'hello-world');\nassert.equal(slugify('  A  --  B  '), 'a-b');\nassert.equal(slugify('Crème brûlée!'), 'cr-me-br-l-e');\nassert.equal(slugify('x'), 'x');\n",
  },
  {
    id: 'L03',
    name: 'Refactor: extract shared helper, preserve behaviour',
    change_kind: 'refactor',
    request: 'In src/stats.mjs, total() and average() duplicate the summing loop. Extract and export a sum(list) helper that both use. Behaviour must not change.',
    files: {
      'README.md': '# L03\n',
      'src/stats.mjs': 'export function total(list) {\n  let acc = 0;\n  for (const n of list) acc += n;\n  return acc;\n}\n\nexport function average(list) {\n  if (list.length === 0) return 0;\n  let acc = 0;\n  for (const n of list) acc += n;\n  return acc / list.length;\n}\n',
      [VISIBLE_TEST]: "import assert from 'node:assert/strict';\nimport { average, total } from '../src/stats.mjs';\nassert.equal(total([1, 2, 3]), 6);\nassert.equal(average([2, 4]), 3);\nassert.equal(average([]), 0);\n",
    },
    hidden_check: "import assert from 'node:assert/strict';\nimport * as stats from '../src/stats.mjs';\nassert.equal(typeof stats.sum, 'function');\nassert.equal(stats.sum([1, 2, 3]), 6);\nassert.equal(stats.total([1, 2, 3]), 6);\nassert.equal(stats.average([2, 4]), 3);\nassert.equal(stats.average([]), 0);\n",
  },
]);

function setupFixture(task) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `crafthelm-live-${task.id}-`));
  runGit(dir, ['init', '-b', 'main']);
  runGit(dir, ['config', 'user.name', 'CraftHelm Benchmark']);
  runGit(dir, ['config', 'user.email', 'bench@crafthelm.local']);
  for (const [rel, content] of Object.entries(task.files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'Live benchmark baseline']);
  return dir;
}

function runHiddenCheck(repo, task) {
  const rel = 'tests/hidden.check.mjs';
  fs.writeFileSync(path.join(repo, rel), task.hidden_check, 'utf8');
  const res = runShellCommand(`node ${rel}`, { cwd: repo });
  return res.exitCode === 0;
}

const UNKNOWN_USAGE = Object.freeze({ status: 'unknown', input_tokens: 'unknown', output_tokens: 'unknown', cache_tokens: 'unknown', cost_usd: 'unknown' });

function workerPrompt(task, contract) {
  return [
    `Task ${contract.task_id}: ${task.request}`,
    `Edit only files matching: ${contract.scope.allow.join(', ')}.`,
    `Acceptance commands that must exit 0: ${contract.acceptance.map((a) => a.command).join(' ; ')}.`,
    'Do not edit tests. When done, reply with a one-paragraph summary only.',
  ].join('\n');
}

function runArmA(task, ctx) {
  const repo = setupFixture(task);
  const started = Date.now();
  try {
    const route = routeTask({ task_type: 'architecture', host: ctx.hostId }, { host: ctx.hostId, capabilities: ctx.capabilities, ...ctx.execOpts });
    const dispatched = ctx.adapter.dispatch(
      { prompt: `${task.request}\nRun \`node ${VISIBLE_TEST}\` to check your work.`, cwd: repo, model: route.model_hint, permissionMode: ctx.permissionMode },
      { ...ctx.execOpts, execute: true, capabilities: ctx.capabilities, timeoutMs: ctx.timeoutMs },
    );
    const result = ctx.adapter.collectResult(dispatched);
    return {
      model_requested: route.model_hint ?? null,
      worker_status: result.status,
      usage: result.usage ?? UNKNOWN_USAGE,
      hidden_check_passed: runHiddenCheck(repo, task),
      crafthelm_state: null,
      wall_time_ms: Date.now() - started,
    };
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

async function runCraftHelmArm(task, ctx, { singleModel }) {
  const repo = setupFixture(task);
  const started = Date.now();
  const runId = `${task.id}-RUN`;
  try {
    const iv = runInterview({
      repo,
      taskId: task.id,
      request: task.request,
      host: ctx.hostId,
      changeKind: task.change_kind,
      approveContract: true,
      actor: 'benchmark-harness',
      inputData: {
        scope: { allow: ['src/**'], protect: ['tests/**'] },
        acceptance: [
          { id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: `node ${VISIBLE_TEST}`, expected_exit_code: 0 },
          { id: 'AC-02', requirement: 'REQ-01', kind: 'e2e', command: `node ${VISIBLE_TEST}`, expected_exit_code: 0 },
        ],
        editorial: { require_kouetsu: false },
      },
    });
    if (!iv.ok) throw new Error(`Live benchmark interview failed for ${task.id}: ${iv.status}`);
    initCheckpoint({ repo, contract: iv.contract_path, runId });
    const contract = JSON.parse(fs.readFileSync(iv.contract_path, 'utf8'));

    const capabilities = singleModel ? { ...ctx.capabilities, supports_multi_model: false } : ctx.capabilities;
    const delegated = runDelegation({
      repo,
      runId,
      role: 'builder',
      taskType: task.change_kind === 'refactor' ? 'refactor' : 'implement',
      prompt: workerPrompt(task, contract),
      execute: true,
      permissionMode: ctx.permissionMode,
      timeoutMs: ctx.timeoutMs,
      capabilities,
      ...ctx.execOpts,
    });

    // Deterministic verification only: no repair rounds, no review package (cost of development, not of reporting).
    const loop = await runFeedbackLoop({ repo, runId, publishOnPass: false, maxRounds: 0, capabilities });
    const summary = summarizeDelegations(repo, runId);
    return {
      model_requested: delegated.model_requested ?? null,
      worker_status: delegated.status,
      usage: delegated.usage ?? UNKNOWN_USAGE,
      hidden_check_passed: runHiddenCheck(repo, task),
      crafthelm_state: loop.ok ? 'VERIFIED' : (loop.status ?? 'FAILED'),
      delegation_status: summary.status,
      wall_time_ms: Date.now() - started,
    };
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

function sumOrUnknown(values) {
  return values.length > 0 && values.every((v) => typeof v === 'number') ? values.reduce((a, b) => a + b, 0) : 'unknown';
}

/**
 * Run the live A/B/C comparison. Spends real tokens unless a fake `runner` is injected (tests).
 * @param {{ host: string, arms?: string[], taskIds?: string[], acceptCost?: boolean, permissionMode?: string, timeoutMs?: number, runner?: Function, resolve?: Function, env?: NodeJS.ProcessEnv }} options
 */
export async function runLiveBenchmark(options) {
  if (!options.acceptCost) {
    throw new Error('LIVE_BENCHMARK_COST_NOT_ACCEPTED: the live benchmark invokes the host CLI and spends real tokens; pass --i-accept-cost to run it.');
  }
  const arms = (options.arms ?? [...LIVE_ARMS]).map((a) => String(a).toUpperCase());
  for (const arm of arms) {
    if (!LIVE_ARMS.includes(arm)) throw new Error(`Unknown arm "${arm}". Expected A, B, or C.`);
  }
  const tasks = options.taskIds?.length
    ? LIVE_TASKS.filter((t) => options.taskIds.includes(t.id))
    : [...LIVE_TASKS];
  if (tasks.length === 0) throw new Error('No live benchmark task matched --tasks.');

  const execOpts = { runner: options.runner, resolve: options.resolve, env: options.env };
  const { hostId, adapter } = getHostAdapter(options.host);
  const capabilities = adapter.discoverCapabilities(execOpts);
  if (capabilities.status !== 'AVAILABLE') {
    return { schema_version: '0.3', mode: 'live', host: hostId, status: 'HOST_UNAVAILABLE', limitations: capabilities.limitations ?? [], results: [], totals: {} };
  }
  const ctx = {
    hostId,
    adapter,
    capabilities,
    execOpts,
    permissionMode: options.permissionMode ?? 'acceptEdits',
    timeoutMs: options.timeoutMs ?? 15 * 60_000,
  };

  const results = [];
  for (const task of tasks) {
    for (const arm of arms) {
      let outcome;
      try {
        outcome = arm === 'A' ? runArmA(task, ctx) : await runCraftHelmArm(task, ctx, { singleModel: arm === 'C' });
      } catch (err) {
        outcome = { error: err.message, usage: UNKNOWN_USAGE, hidden_check_passed: false, wall_time_ms: 0, model_requested: null, worker_status: 'ERROR', crafthelm_state: null };
      }
      results.push({ task_id: task.id, task_name: task.name, arm, ...outcome });
    }
  }

  const totals = {};
  for (const arm of arms) {
    const rows = results.filter((r) => r.arm === arm);
    totals[arm] = {
      tasks: rows.length,
      hidden_check_pass_rate: rows.filter((r) => r.hidden_check_passed).length / rows.length,
      input_tokens: sumOrUnknown(rows.map((r) => r.usage.input_tokens)),
      cache_read_tokens: sumOrUnknown(rows.map((r) => r.usage.cache_tokens)),
      cache_creation_tokens: sumOrUnknown(rows.map((r) => r.usage.cache_creation_tokens)),
      output_tokens: sumOrUnknown(rows.map((r) => r.usage.output_tokens)),
      cost_usd: sumOrUnknown(rows.map((r) => r.usage.cost_usd)),
      wall_time_ms: rows.reduce((acc, r) => acc + r.wall_time_ms, 0),
      lead_tokens: arm === 'A' ? 'not_applicable' : 'unknown',
    };
  }

  return {
    schema_version: '0.3',
    mode: 'live',
    host: hostId,
    status: 'COMPLETED',
    generated_at: new Date().toISOString(),
    sample_size_per_arm: tasks.length,
    notes: [
      'Tokens and cost are the values the host CLI reported for the worker invocation; anything it did not report is "unknown".',
      'Input tokens exclude cached prompt tokens. Cache reads and writes are listed separately, and the cost covers all three.',
      'In arms B and C this harness plays the lead deterministically. An interactive lead\'s own tokens are not included, so B/C are a lower bound on a real CraftHelm session.',
      `Each arm ran ${tasks.length} task(s) once. This is too small a sample to support a general savings claim.`,
    ],
    results,
    totals,
  };
}

function formatCost(value) {
  return typeof value === 'number' ? value.toFixed(4) : value;
}

export function formatLiveBenchmarkMarkdown(report) {
  const lines = [
    '# CraftHelm Live Benchmark Report (A / B / C)',
    '',
    `- Host: \`${report.host}\` | Status: \`${report.status}\` | Generated: \`${report.generated_at ?? 'n/a'}\``,
    ...((report.notes ?? []).map((n) => `- ${n}`)),
    '',
    '| Task | Arm | Model requested | Models used | Hidden check | Input tokens | Cache read | Cache write | Output tokens | Cost (USD) | Wall time (ms) |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...report.results.map(
      (r) => `| ${r.task_id} | ${r.arm} | ${r.model_requested ?? 'host default'} | ${r.usage.models_used?.length ? r.usage.models_used.join(', ') : 'unknown'} | ${r.hidden_check_passed ? 'PASS' : 'FAIL'} | ${r.usage.input_tokens} | ${r.usage.cache_tokens ?? 'unknown'} | ${r.usage.cache_creation_tokens ?? 'unknown'} | ${r.usage.output_tokens} | ${formatCost(r.usage.cost_usd)} | ${r.wall_time_ms} |`,
    ),
    '',
    '| Arm | Hidden check pass rate | Input tokens | Cache read | Cache write | Output tokens | Cost (USD) | Lead tokens |',
    '|---|---|---|---|---|---|---|---|',
    ...Object.entries(report.totals ?? {}).map(
      ([arm, t]) => `| ${arm} | ${t.hidden_check_pass_rate} | ${t.input_tokens} | ${t.cache_read_tokens ?? 'unknown'} | ${t.cache_creation_tokens ?? 'unknown'} | ${t.output_tokens} | ${formatCost(t.cost_usd)} | ${t.lead_tokens} |`,
    ),
    '',
  ];
  return lines.join('\n');
}
