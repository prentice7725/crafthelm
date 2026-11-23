import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { recordHumanDecision } from '../../scripts/approval.mjs';
import { initCheckpoint, transitionCheckpoint } from '../../scripts/checkpoint.mjs';
import { approveContractFile } from '../../scripts/contract.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { CRAFTHELM_ROOT } from '../../scripts/lib/paths.mjs';
import { STATES } from '../../scripts/lib/state-machine.mjs';
import { lockApprovedSkills } from '../../scripts/skills.mjs';
import { formatStartText, startTask } from '../../scripts/start.mjs';
import { formatStatusText, getWorkspaceStatus } from '../../scripts/status.mjs';
import { publishReviewPackage } from '../../scripts/review-package.mjs';
import { runVerify } from '../../scripts/verify.mjs';

const CRAFTHELM_CLI = path.join(CRAFTHELM_ROOT, 'scripts', 'crafthelm.mjs');

function createTempRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-start-status-'));
  runGit(dir, ['init', '-b', 'main']);
  runGit(dir, ['config', 'user.name', 'CraftHelm Test']);
  runGit(dir, ['config', 'user.email', 'test@crafthelm.local']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'Initial repo baseline']);
  return dir;
}

describe('Batch 2 crafthelm start & crafthelm status', () => {
  it('crafthelm start probes host/runners, avoids silent E2E injection, and guides next command', () => {
    const repo = createTempRepo({
      'README.md': '# Start Entrypoint Demo\n',
      'package.json': JSON.stringify({
        name: 'start-demo',
        scripts: {
          test: 'node tests/unit.test.mjs',
          'test:e2e': 'node tests/e2e.test.mjs',
        },
      }, null, 2),
      'src/app.mjs': 'export const ok = true;\n',
      'tests/unit.test.mjs': 'process.exit(0);\n',
      'tests/e2e.test.mjs': 'process.exit(0);\n',
    });

    try {
      // 1) Missing request -> REQUEST_REQUIRED without writing files
      const emptyStart = startTask({ repo, host: 'generic' });
      assert.equal(emptyStart.ok, false);
      assert.equal(emptyStart.status, 'REQUEST_REQUIRED');
      assert.equal(emptyStart.detected.selected_host, 'generic');
      assert.equal(emptyStart.detected.suggested_test_command, 'npm test');
      assert.equal(emptyStart.detected.suggested_e2e_command, 'npm run test:e2e');
      assert.equal(fs.existsSync(path.join(repo, '.crafthelm')), false);

      // 2) Start without --e2e-cmd creates CH-T001, preserves E2E_MISSING warning without guessing
      const s1 = startTask({
        repo,
        host: 'generic',
        request: 'Fix token comparison bug',
        changeKind: 'bugfix',
        scopeAllow: ['src/**'],
      });
      assert.equal(s1.ok, true);
      assert.equal(s1.task_id, 'CH-T001');
      assert.equal(s1.policy_ready, false);
      assert.match(s1.next_command, /--e2e-cmd/);
      assert.match(s1.next_command, /npm run test:e2e/);
      assert.match(formatStartText(s1), /다음 명령:/);

      // Verify hint was NOT silently injected into CH-T001 acceptance
      const c1 = JSON.parse(fs.readFileSync(s1.contract_path, 'utf8'));
      assert.equal(c1.acceptance.some((a) => a.kind === 'e2e'), false);
      assert.deepEqual(c1.scope.allow, ['src/**']);

      // Follow the emitted repair command from the CLI checkout, targeting another repo.
      assert.match(s1.next_command, /contract add-e2e /);
      const followup = spawnSync(s1.next_command, {
        cwd: CRAFTHELM_ROOT, shell: true, encoding: 'utf8', windowsHide: true,
      });
      assert.equal(followup.status, 0, followup.stderr);
      const s2 = JSON.parse(followup.stdout);
      const amended = JSON.parse(fs.readFileSync(s1.contract_path, 'utf8'));
      assert.equal(amended.change_kind, 'bugfix');
      assert.deepEqual(amended.scope, c1.scope);
      assert.equal(s2.ok, true);
      assert.equal(s2.policy_ready, true);
      assert.match(s2.next_command, /contract approve/);

      // 4) Top-level CLI invocation outputs valid JSON and exit 0 for CH-T002
      const cli = spawnSync(
        process.execPath,
        [CRAFTHELM_CLI, 'start', 'Add audit log endpoint', '--repo', repo, '--host', 'generic', '--e2e-cmd', 'node tests/e2e.test.mjs', '--json'],
        { cwd: repo, encoding: 'utf8', windowsHide: true },
      );
      assert.equal(cli.status, 0, cli.stderr);
      const parsed = JSON.parse(cli.stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.task_id, 'CH-T002');
      assert.equal(parsed.policy_ready, true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('crafthelm status reports idle, pending contracts, single active auto-select, stale/review/terminal transitions, and multi-run disambiguation', () => {
    const repo = createTempRepo({
      'README.md': '# Status Demo\n',
      'src/app.mjs': 'export const value = 1;\n',
      'tests/unit.test.mjs': 'process.exit(0);\n',
      'tests/e2e.test.mjs': 'process.exit(0);\n',
    });

    try {
      // 1) Empty repo -> idle (read-only: zero files created)
      const idle = getWorkspaceStatus({ repo });
      assert.equal(idle.mode, 'idle');
      assert.match(idle.next_command, /crafthelm\.mjs start/);
      assert.equal(fs.existsSync(path.join(repo, '.crafthelm')), false);

      // 2) Contract pending E2E -> pending_contract
      const s1 = startTask({ repo, host: 'generic', request: 'Task one' });
      const pendingNoE2e = getWorkspaceStatus({ repo });
      assert.equal(pendingNoE2e.mode, 'pending_contract');
      assert.match(pendingNoE2e.next_command, /--e2e-cmd/);

      // Add E2E -> pending contract approve
      startTask({
        repo,
        host: 'generic',
        taskId: 'CH-T001',
        overwrite: true,
        request: 'Task one',
        e2eCommand: 'node tests/e2e.test.mjs',
        scopeAllow: ['src/**', 'tests/**'],
      });
      const pendingApprove = getWorkspaceStatus({ repo });
      assert.equal(pendingApprove.mode, 'pending_contract');
      assert.match(pendingApprove.next_command, /contract approve/);

      // Approve contract -> checkpoint init suggestion
      approveContractFile(s1.contract_path, 'operator');
      const pendingInit = getWorkspaceStatus({ repo });
      assert.equal(pendingInit.mode, 'pending_contract');
      assert.match(pendingInit.next_command, /checkpoint init/);

      // 3) Single active run auto-selected without --run-id
      lockApprovedSkills({ repo, host: 'generic' });
      initCheckpoint({ repo, contract: s1.contract_path, runId: 'RUN-01' });
      const singleReady = getWorkspaceStatus({ repo });
      assert.equal(singleReady.mode, 'single_active_run');
      assert.equal(singleReady.selected_run.run_id, 'RUN-01');
      assert.equal(singleReady.selected_run.state, STATES.READY);
      assert.match(singleReady.next_command, /verify --repo .* --run-id RUN-01 --selective/);

      // Verify & publish review-package -> READY_FOR_HUMAN_REVIEW -> approve record command
      fs.writeFileSync(path.join(repo, 'src/app.mjs'), 'export const value = 2;\n', 'utf8');
      const v = runVerify({ repo, runId: 'RUN-01' });
      assert.equal(v.ok, true);
      const pkg = publishReviewPackage({ repo, runId: 'RUN-01' });
      assert.equal(pkg.state, STATES.READY_FOR_HUMAN_REVIEW);

      const readyHuman = getWorkspaceStatus({ repo });
      assert.equal(readyHuman.mode, 'single_active_run');
      assert.equal(readyHuman.selected_run.snapshot_stale, false);
      assert.match(readyHuman.next_command, /approve record .* --run-id RUN-01 --decision ACCEPTED/);

      // Edit file after review -> snapshot_stale triggers re-verify recommendation
      fs.writeFileSync(path.join(repo, 'src/app.mjs'), 'export const value = 3;\n', 'utf8');
      const staleStatus = getWorkspaceStatus({ repo });
      assert.equal(staleStatus.selected_run.snapshot_stale, true);
      assert.match(staleStatus.next_command, /verify --repo .* --run-id RUN-01$/);

      // Re-verify, republish, and accept -> terminal moves to idle with terminal_runs history
      assert.equal(transitionCheckpoint({ repo, runId: 'RUN-01', to: STATES.VERIFYING }).ok, true);
      assert.equal(runVerify({ repo, runId: 'RUN-01' }).ok, true);
      assert.equal(publishReviewPackage({ repo, runId: 'RUN-01' }).ok, true);
      recordHumanDecision({ repo, runId: 'RUN-01', decision: 'ACCEPTED', actor: 'human-reviewer', rationale: 'Verified' });

      const afterAccept = getWorkspaceStatus({ repo });
      assert.equal(afterAccept.mode, 'idle');
      assert.equal(afterAccept.terminal_runs.length, 1);
      assert.equal(afterAccept.terminal_runs[0].state, STATES.ACCEPTED);

      // 4) Multiple active runs -> lists choices; --run-id selects target
      const s2 = startTask({
        repo,
        host: 'generic',
        request: 'Task two',
        e2eCommand: 'node tests/e2e.test.mjs',
        approveContract: true,
        actor: 'operator',
      });
      const s3 = startTask({
        repo,
        host: 'generic',
        request: 'Task three',
        e2eCommand: 'node tests/e2e.test.mjs',
        approveContract: true,
        actor: 'operator',
      });
      initCheckpoint({ repo, contract: s2.contract_path, runId: 'RUN-02' });
      initCheckpoint({ repo, contract: s3.contract_path, runId: 'RUN-03' });

      const multi = getWorkspaceStatus({ repo });
      assert.equal(multi.mode, 'multiple_active_runs');
      assert.equal(multi.active_runs.length, 2);
      assert.match(formatStatusText(multi), /활성 실행 목록:/);

      const cliSingle = spawnSync(
        process.execPath,
        [CRAFTHELM_CLI, 'status', '--repo', repo, '--run-id', 'RUN-02', '--json'],
        { cwd: repo, encoding: 'utf8', windowsHide: true },
      );
      assert.equal(cliSingle.status, 0, cliSingle.stderr);
      const parsedSingle = JSON.parse(cliSingle.stdout);
      assert.equal(parsedSingle.mode, 'single_run');
      assert.equal(parsedSingle.selected_run.run_id, 'RUN-02');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
