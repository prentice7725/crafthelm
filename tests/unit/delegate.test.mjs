import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { initCheckpoint } from '../../scripts/checkpoint.mjs';
import { approveContractFile } from '../../scripts/contract.mjs';
import { recordWorkerResult, runDelegation, summarizeDelegations } from '../../scripts/delegate.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { getEvidenceManifestPath, getReviewPackagePath, getRunDir } from '../../scripts/lib/paths.mjs';
import { publishReviewPackage } from '../../scripts/review-package.mjs';
import { runVerify } from '../../scripts/verify.mjs';

const CLAUDE_HELP = 'Usage: claude [options]\n  -p, --print\n  --output-format <format>\n  --model <model>\n  --permission-mode <mode>\n  --agents <json>\n';

/** Fake `claude` CLI: answers --version/--help and returns a JSON result with measured usage for -p runs. */
function makeClaudeRunner(calls, { exitCode = 0 } = {}) {
  return (cmd, args) => {
    calls.push({ cmd, args });
    if (args.includes('--version')) return { exitCode: 0, stdout: '9.9.9 (Claude Code)\n' };
    if (args.includes('--help')) return { exitCode: 0, stdout: CLAUDE_HELP };
    return {
      exitCode,
      durationMs: 1234,
      stdout: JSON.stringify({
        result: 'Implemented the change in src/app.mjs.',
        usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 5000 },
        total_cost_usd: 0.0123,
      }),
    };
  };
}

function makeRun(host, taskId, runId) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-delegate-'));
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['config', 'user.name', 'CraftHelm Test']);
  runGit(repo, ['config', 'user.email', 'test@crafthelm.local']);
  const files = {
    'README.md': '# Delegate Demo\n',
    'src/app.mjs': 'export const val = 1;\n',
    'tests/unit.test.mjs': "import assert from 'node:assert/strict'; import { val } from '../src/app.mjs'; assert.equal(val, 2);\n",
    'tests/e2e.test.mjs': "import assert from 'node:assert/strict'; import { val } from '../src/app.mjs'; assert.equal(val, 2);\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content, 'utf8');
  }
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-m', 'Baseline commit']);

  const contractPath = path.join(repo, '.crafthelm', 'contracts', `${taskId}.json`);
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(contractPath, JSON.stringify({
    schema_version: '0.3',
    task_id: taskId,
    request: 'Set val to 2',
    project_root: '.',
    host,
    change_kind: 'feature',
    methodology: { lifecycle: 'incremental', specification: 'sdd', engineering: 'tdd', execution: 'full' },
    scope: { allow: ['src/**'], protect: [] },
    approval: { contract_approved: false, require_on: ['scope_change'] },
    budgets: { max_worker_retries_per_cause: 3, max_lead_escalations: 3, max_wall_minutes: 30 },
    acceptance: [
      { id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node tests/unit.test.mjs', expected_exit_code: 0 },
      { id: 'AC-02', requirement: 'REQ-01', kind: 'e2e', command: 'node tests/e2e.test.mjs', expected_exit_code: 0 },
    ],
    source_policy: { authority: ['git-main'], source_refs: ['README.md'] },
  }, null, 2));
  approveContractFile(contractPath, 'operator');
  initCheckpoint({ repo, contract: contractPath, runId });
  return repo;
}

describe('Delegation Records: observed dispatch, self-reported packets, honest UNOBSERVED', () => {
  it('prepares without recording, then executes through the Claude adapter and records measured usage', () => {
    const repo = makeRun('claude', 'DLG-1', 'DLG-1-RUN');
    const calls = [];
    const runner = makeClaudeRunner(calls);
    const resolve = () => ({ found: true, path: 'claude', kind: 'bin' });
    try {
      assert.equal(summarizeDelegations(repo, 'DLG-1-RUN').status, 'UNOBSERVED');

      const prepared = runDelegation({ repo, runId: 'DLG-1-RUN', role: 'builder', taskType: 'implement', prompt: 'Set val to 2', runner, resolve });
      assert.equal(prepared.status, 'PREPARED');
      assert.equal(prepared.recorded, false);
      assert.equal(prepared.tier, 'standard');
      assert.equal(prepared.model_hint, 'sonnet');
      assert.equal(summarizeDelegations(repo, 'DLG-1-RUN').record_count, 0);

      const done = runDelegation({ repo, runId: 'DLG-1-RUN', role: 'builder', taskType: 'implement', prompt: 'Set val to 2', execute: true, runner, resolve });
      assert.equal(done.ok, true);
      assert.equal(done.delegation_id, 'D001');
      assert.deepEqual(done.usage, { status: 'measured', input_tokens: 1200, output_tokens: 340, cache_tokens: 5000, cache_creation_tokens: 'unknown', cost_usd: 0.0123, models_used: [] });

      // Single-provider isolation: only `claude` was ever invoked, with the routed model.
      assert.ok(calls.every((c) => c.cmd === 'claude'));
      const workerCall = calls.find((c) => c.args.includes('-p'));
      assert.deepEqual(workerCall.args.slice(0, 5), ['-p', '--output-format', 'json', '--model', 'sonnet']);

      const record = JSON.parse(fs.readFileSync(path.join(getRunDir(repo, 'DLG-1-RUN'), done.record_file), 'utf8'));
      assert.equal(record.observation, 'observed');
      assert.equal(record.duration_ms, 1234);
      // Raw worker output is stored by reference, not returned to the lead.
      assert.equal(done.output, undefined);
      assert.match(fs.readFileSync(path.join(getRunDir(repo, 'DLG-1-RUN'), done.output_file), 'utf8'), /Implemented the change/);

      // A retry escalates the tier, and a failing worker is recorded as FAILED.
      const retry = runDelegation({
        repo, runId: 'DLG-1-RUN', role: 'builder', taskType: 'repair', retryRound: 2, prompt: 'Repair', execute: true,
        runner: makeClaudeRunner(calls, { exitCode: 1 }), resolve,
      });
      assert.equal(retry.ok, false);
      assert.equal(retry.tier, 'reasoning');
      assert.equal(retry.model_requested, 'opus');

      const summary = summarizeDelegations(repo, 'DLG-1-RUN');
      assert.equal(summary.status, 'OBSERVED');
      assert.equal(summary.record_count, 2);
      assert.equal(summary.failed_count, 1);
      assert.deepEqual(summary.tiers, ['reasoning', 'standard']);
      assert.equal(summary.measured_input_tokens, 2400);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('files in-session worker packets as self_reported with unknown usage and rejects malformed packets', () => {
    const repo = makeRun('generic', 'DLG-2', 'DLG-2-RUN');
    const packet = {
      task_id: 'DLG-2',
      status: 'completed',
      acceptance: [{ id: 'AC-01', status: 'pass' }],
      changed_files: ['src/app.mjs'],
      scope_violation: false,
      root_cause: null,
      decision_needed: null,
      artifact_refs: [],
    };
    try {
      // A packet carrying raw logs (extra fields) violates the Lead Context Contract.
      assert.throws(
        () => recordWorkerResult({ repo, runId: 'DLG-2-RUN', role: 'builder', packet: { ...packet, full_log: 'x'.repeat(50) } }),
        /additional property is not allowed/,
      );
      assert.throws(
        () => recordWorkerResult({ repo, runId: 'DLG-2-RUN', role: 'builder', packet: { ...packet, task_id: 'OTHER' } }),
        /WORKER_PACKET_TASK_MISMATCH/,
      );
      assert.equal(summarizeDelegations(repo, 'DLG-2-RUN').record_count, 0);

      const filed = recordWorkerResult({ repo, runId: 'DLG-2-RUN', role: 'builder', packet });
      assert.equal(filed.observation, 'self_reported');
      const record = JSON.parse(fs.readFileSync(path.join(getRunDir(repo, 'DLG-2-RUN'), filed.record_file), 'utf8'));
      assert.equal(record.usage.cost_usd, 'unknown');
      assert.equal(record.usage.status, 'unknown');

      const summary = summarizeDelegations(repo, 'DLG-2-RUN');
      assert.equal(summary.status, 'SELF_REPORTED');
      assert.equal(summary.measured_cost_usd, 'unknown');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('writes the delegation summary into the manifest and review package, UNOBSERVED when nothing was recorded', () => {
    const repo = makeRun('generic', 'DLG-3', 'DLG-3-RUN');
    try {
      fs.writeFileSync(path.join(repo, 'src/app.mjs'), 'export const val = 2;\n', 'utf8');
      assert.equal(runVerify({ repo, runId: 'DLG-3-RUN' }).ok, true);
      const manifest = JSON.parse(fs.readFileSync(getEvidenceManifestPath(repo, 'DLG-3-RUN'), 'utf8'));
      assert.equal(manifest.delegation.status, 'UNOBSERVED');

      assert.equal(publishReviewPackage({ repo, runId: 'DLG-3-RUN' }).state, 'READY_FOR_HUMAN_REVIEW');
      const report = fs.readFileSync(getReviewPackagePath(repo, 'DLG-3-RUN'), 'utf8');
      assert.match(report, /작업 위임 \| \*\*관측 안 됨 \(UNOBSERVED\)/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
