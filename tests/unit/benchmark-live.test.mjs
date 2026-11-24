import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { LIVE_TASKS, formatLiveBenchmarkMarkdown, runLiveBenchmark } from '../../scripts/lib/benchmark-live.mjs';

const CLAUDE_HELP = 'Usage: claude [options]\n  -p, --print\n  --output-format <format>\n  --model <model>\n  --permission-mode <mode>\n  --agents <json>\n';

const FIXES = {
  'src/range.mjs': 'export function inRange(x, lo, hi) {\n  return x >= lo && x <= hi;\n}\n',
  'src/slug.mjs': "export const SEPARATOR = '-';\nexport function slugify(text) {\n  return String(text).toLowerCase().trim().replace(/[^a-z0-9]+/g, SEPARATOR).replace(/^-+|-+$/g, '');\n}\n",
  'src/stats.mjs': 'export function sum(list) {\n  let acc = 0;\n  for (const n of list) acc += n;\n  return acc;\n}\n\nexport function total(list) {\n  return sum(list);\n}\n\nexport function average(list) {\n  return list.length === 0 ? 0 : sum(list) / list.length;\n}\n',
};

/**
 * Fake `claude` CLI. A worker call edits the fixture in its cwd and reports usage that depends on the model,
 * so the harness can be exercised end to end at zero cost. `breakTask` makes one fixture's fix wrong.
 */
function makeFakeClaude(calls, { reportUsage = true, breakFile = null } = {}) {
  const pricing = { opus: [4000, 900, 0.21], sonnet: [4200, 950, 0.045], default: [4100, 920, 0.06] };
  return (cmd, args, options) => {
    if (args.includes('--version')) return { exitCode: 0, stdout: '9.9.9 (Claude Code)\n' };
    if (args.includes('--help')) return { exitCode: 0, stdout: CLAUDE_HELP };
    const modelIdx = args.indexOf('--model');
    const model = modelIdx === -1 ? 'default' : args[modelIdx + 1];
    calls.push({ cmd, model, cwd: options.cwd });
    for (const [rel, fixed] of Object.entries(FIXES)) {
      const abs = path.join(options.cwd, rel);
      if (fs.existsSync(abs)) {
        fs.writeFileSync(abs, rel === breakFile ? fs.readFileSync(abs, 'utf8') : fixed, 'utf8');
      }
    }
    const [input, output, cost] = pricing[model] ?? pricing.default;
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        result: 'Done.',
        // Like the real CLI: input_tokens excludes the cached prompt, and modelUsage names the billed model.
        ...(reportUsage
          ? {
              usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 150000, cache_creation_input_tokens: 20000 },
              total_cost_usd: cost,
              modelUsage: { [`claude-${model === 'default' ? 'opus' : model}-test`]: {} },
            }
          : {}),
      }),
    };
  };
}

const resolve = () => ({ found: true, path: 'claude', kind: 'bin' });

describe('Live A/B/C Benchmark Harness (exercised with a fake host CLI)', () => {
  it('refuses to spend tokens without explicit cost acceptance', async () => {
    await assert.rejects(() => runLiveBenchmark({ host: 'claude' }), /LIVE_BENCHMARK_COST_NOT_ACCEPTED/);
  });

  it('runs every task per arm, routes models per arm, and totals only measured numbers', async () => {
    const calls = [];
    const report = await runLiveBenchmark({ host: 'claude', acceptCost: true, runner: makeFakeClaude(calls), resolve });

    assert.equal(report.status, 'COMPLETED');
    assert.equal(report.results.length, LIVE_TASKS.length * 3);
    assert.ok(report.results.every((r) => r.hidden_check_passed), JSON.stringify(report.results.filter((r) => !r.hidden_check_passed)));
    assert.ok(calls.every((c) => c.cmd === 'claude'));

    const byArm = (arm) => report.results.filter((r) => r.arm === arm);
    assert.ok(byArm('A').every((r) => r.model_requested === 'opus' && r.crafthelm_state === null));
    assert.ok(byArm('B').every((r) => r.model_requested === 'sonnet' && r.crafthelm_state === 'VERIFIED' && r.delegation_status === 'OBSERVED'));
    assert.ok(byArm('C').every((r) => r.model_requested === null && r.crafthelm_state === 'VERIFIED'));

    assert.equal(report.totals.A.input_tokens, 4000 * LIVE_TASKS.length);
    assert.ok(Math.abs(report.totals.B.cost_usd - 0.045 * LIVE_TASKS.length) < 1e-9);
    assert.equal(report.totals.A.lead_tokens, 'not_applicable');
    assert.equal(report.totals.B.lead_tokens, 'unknown');
    assert.equal(report.totals.B.hidden_check_pass_rate, 1);
    assert.ok(report.notes.some((n) => /lower bound/.test(n)));

    const md = formatLiveBenchmarkMarkdown(report);
    assert.match(md, /\| L01 \| A \| opus \| claude-opus-test \| PASS \| 4000 \| 150000 \| 20000 \| 900 \| 0\.2100 \|/);
    // A "host default" run shows which model the CLI actually billed.
    assert.match(md, /\| L01 \| C \| host default \| claude-opus-test \| PASS \|/);
    assert.equal(report.totals.A.cache_read_tokens, 150000 * LIVE_TASKS.length);
    assert.equal(report.totals.B.cache_creation_tokens, 20000 * LIVE_TASKS.length);
  });

  it('reports "unknown" instead of estimating when the host returns no usage, and FAIL when the hidden check fails', async () => {
    const report = await runLiveBenchmark({
      host: 'claude',
      acceptCost: true,
      arms: ['a', 'b'],
      taskIds: ['L01'],
      runner: makeFakeClaude([], { reportUsage: false, breakFile: 'src/range.mjs' }),
      resolve,
    });
    assert.equal(report.results.length, 2);
    for (const row of report.results) {
      assert.equal(row.usage.cost_usd, 'unknown');
      assert.equal(row.hidden_check_passed, false);
    }
    assert.equal(report.totals.A.cost_usd, 'unknown');
    assert.equal(report.totals.B.input_tokens, 'unknown');
    // CraftHelm's own verification also catches the unfixed bug in arm B.
    assert.notEqual(report.results.find((r) => r.arm === 'B').crafthelm_state, 'VERIFIED');
  });
});
