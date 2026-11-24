import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { addTargetedTest } from '../../scripts/contract.mjs';
import { runFeedbackLoop } from '../../scripts/feedback-loop.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { CRAFTHELM_ROOT, getApprovalDecisionPath, getCheckpointPath } from '../../scripts/lib/paths.mjs';
import { formatStartText, startTask } from '../../scripts/start.mjs';
import { runVerify } from '../../scripts/verify.mjs';

const CRAFTHELM_CLI = path.join(CRAFTHELM_ROOT, 'scripts', 'crafthelm.mjs');

function createTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-init-run-'));
  runGit(dir, ['init', '-b', 'main']);
  runGit(dir, ['config', 'user.name', 'CraftHelm Test']);
  runGit(dir, ['config', 'user.email', 'test@crafthelm.local']);
  const files = {
    'README.md': '# Init Run Demo\n',
    'package.json': JSON.stringify({ name: 'init-run-demo', scripts: { test: 'node tests/unit.test.mjs' } }, null, 2),
    'src/app.mjs': 'export const limit = 1;\n',
    'tests/unit.test.mjs': "import assert from 'node:assert/strict'; import { limit } from '../src/app.mjs'; assert.equal(limit, 2);\n",
    'tests/e2e.test.mjs': "import assert from 'node:assert/strict'; import { limit } from '../src/app.mjs'; assert.equal(limit, 2);\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'Initial test commit']);
  return dir;
}

describe('Chained start: contract approval + run baseline in one call', () => {
  it('start --approve-contract --init-run reaches READY so a small task needs start -> edit -> feedback', async () => {
    const repo = createTempRepo();
    try {
      const started = startTask({
        repo,
        host: 'generic',
        request: 'Raise limit to 2',
        changeKind: 'bugfix',
        e2eCommand: 'node tests/e2e.test.mjs',
        scopeAllow: ['src/**'],
        approveContract: true,
        actor: 'operator',
        initRun: true,
      });
      assert.equal(started.ok, true);
      assert.equal(started.status, 'CONTRACT_APPROVED');
      assert.deepEqual(
        { run_id: started.run.run_id, initialized: started.run.initialized, state: started.run.state },
        { run_id: 'CH-T001-RUN-001', initialized: true, state: 'READY' },
      );
      assert.match(started.next_command, /feedback --repo .* --run-id CH-T001-RUN-001 --selective/);
      assert.match(formatStartText(started), /실행 ID: CH-T001-RUN-001 \(기준선 동결 완료\)/);
      assert.ok(fs.existsSync(getCheckpointPath(repo, 'CH-T001-RUN-001')));

      fs.writeFileSync(path.join(repo, 'src/app.mjs'), 'export const limit = 2;\n', 'utf8');
      const loop = await runFeedbackLoop({ repo, runId: 'CH-T001-RUN-001', selective: true });
      assert.equal(loop.ok, true);
      assert.equal(loop.status, 'READY_FOR_HUMAN_APPROVAL');
      // Chaining never reaches into the human decision.
      assert.equal(fs.existsSync(getApprovalDecisionPath(repo, 'CH-T001-RUN-001')), false);

      // A second start for the same run does not rebuild the frozen baseline.
      const again = startTask({
        repo,
        host: 'generic',
        request: 'Raise limit to 2',
        taskId: 'CH-T001',
        overwrite: true,
        e2eCommand: 'node tests/e2e.test.mjs',
        approveContract: true,
        actor: 'operator',
        initRun: true,
      });
      assert.equal(again.run.initialized, false);
      assert.equal(again.run.reason, 'RUN_EXISTS');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not freeze a baseline for an unapproved or not-ready contract, and points to the chained approve command', () => {
    const repo = createTempRepo();
    try {
      const pending = startTask({
        repo,
        host: 'generic',
        request: 'Raise limit to 2',
        e2eCommand: 'node tests/e2e.test.mjs',
        initRun: true,
      });
      assert.equal(pending.status, 'CONTRACT_PENDING');
      assert.deepEqual(pending.run, { run_id: 'CH-T001-RUN-001', initialized: false, reason: 'CONTRACT_NOT_APPROVED' });
      assert.match(pending.next_command, /contract approve .* --actor operator --init-run --repo /);
      assert.equal(fs.existsSync(getCheckpointPath(repo, 'CH-T001-RUN-001')), false);

      const notReady = startTask({
        repo,
        host: 'generic',
        request: 'Another change without e2e',
        approveContract: true,
        actor: 'operator',
        initRun: true,
      });
      assert.equal(notReady.policy_ready, false);
      assert.equal(notReady.run.reason, 'CONTRACT_POLICY_NOT_READY');
      assert.equal(fs.existsSync(getCheckpointPath(repo, 'CH-T002-RUN-001')), false);

      // `contract approve --init-run` approves, records the channel, and freezes the baseline.
      const cli = spawnSync(
        process.execPath,
        [CRAFTHELM_CLI, 'contract', 'approve', pending.contract_path, '--actor', 'operator', '--init-run', '--repo', repo],
        { cwd: repo, encoding: 'utf8', windowsHide: true, env: { ...process.env, CRAFTHELM_AGENT_SESSION: '1' } },
      );
      assert.equal(cli.status, 0, cli.stderr);
      const out = JSON.parse(cli.stdout);
      assert.equal(out.approved_via, 'agent_session');
      assert.equal(out.run.run_id, 'CH-T001-RUN-001');
      assert.match(out.next_command, /feedback --repo .* --run-id CH-T001-RUN-001 --selective/);
      assert.ok(fs.existsSync(getCheckpointPath(repo, 'CH-T001-RUN-001')));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('lite quick start: asks for the tailored test before approval, and passes once it is given', () => {
    const repo = createTempRepo();
    const lite = { repo, host: 'generic', request: 'Raise limit to 2', changeKind: 'bugfix', processProfile: 'lite', scopeAllow: ['src/**'], approveContract: true, actor: 'operator', initRun: true };
    try {
      // Only the umbrella `npm test`: verify would grade it SINGLE_GENERIC_CHECK, so stop before approval.
      const bare = startTask(lite);
      assert.equal(bare.policy_ready, false);
      assert.ok(bare.warnings.some((w) => w.code === 'LITE_TARGETED_TEST_MISSING'));
      assert.equal(bare.run.initialized, false);
      assert.match(bare.next_command, /contract add-test .* --test-cmd/);
      // The suggested fix amends the saved contract and makes it ready.
      const amended = addTargetedTest(bare.contract_path, 'node tests/unit.test.mjs');
      assert.equal(amended.policy_ready, true);
      assert.match(fs.readFileSync(path.join(repo, bare.docs_dir, 'acceptance.md'), 'utf8'), /\| unit \| `node tests\/unit\.test\.mjs` \|/);

      const withTest = startTask({ ...lite, testCommand: 'node tests/unit.test.mjs' });
      assert.equal(withTest.policy_ready, true);
      assert.equal(withTest.run.initialized, true);
      const contract = JSON.parse(fs.readFileSync(withTest.contract_path, 'utf8'));
      assert.deepEqual(contract.acceptance.map((ac) => [ac.kind, ac.command]), [['test', 'npm test'], ['unit', 'node tests/unit.test.mjs']]);

      fs.writeFileSync(path.join(repo, 'src/app.mjs'), 'export const limit = 2;\n', 'utf8');
      const v = runVerify({ repo, runId: withTest.run.run_id });
      assert.equal(v.technical_status, 'PARTIAL', v.failure_reasons.join(' | '));
      assert.equal(v.process_profile.e2e_exempted, true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
