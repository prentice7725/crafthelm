import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { listReviewQueue, runReviewDesk, verifyHumanDecision } from '../../scripts/approval.mjs';
import { closeRun, initCheckpoint } from '../../scripts/checkpoint.mjs';
import { approveContractFile } from '../../scripts/contract.mjs';
import { resolveCommandTimeoutMs } from '../../scripts/crafthelm.mjs';
import { getClaudeGuardRules } from '../../scripts/lib/claude-permissions.mjs';
import { sha256Text } from '../../scripts/lib/crypto.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { CRAFTHELM_ROOT, getApprovalDecisionPath, getCheckpointPath } from '../../scripts/lib/paths.mjs';
import { describeSessionStatus } from '../../scripts/lib/scope-guard.mjs';
import { publishReviewPackage } from '../../scripts/review-package.mjs';
import { runVerify } from '../../scripts/verify.mjs';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const remove = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
const KOUETSU = path.join(CRAFTHELM_ROOT, 'hosts', 'codex', 'skills', 'kouetsu');
const state = (repo, runId) => readJson(getCheckpointPath(repo, runId)).state;

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-desk-'));
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['config', 'user.name', 'CraftHelm Test']);
  runGit(repo, ['config', 'user.email', 'test@crafthelm.local']);
  for (const [rel, content] of Object.entries({ 'src/app.mjs': 'export const val = 1;\n', 'README.md': '# Base\n' })) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content, 'utf8');
  }
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-m', 'Base']);
  return repo;
}

function openRun(repo, taskId) {
  const contractPath = path.join(repo, '.crafthelm', 'contracts', `${taskId}.json`);
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(contractPath, JSON.stringify({
    schema_version: '0.3',
    task_id: taskId,
    request: `Change val for ${taskId}`,
    project_root: '.',
    host: 'codex',
    change_kind: 'refactor',
    methodology: { lifecycle: 'incremental', specification: 'lightweight', engineering: 'test_after', execution: 'full' },
    scope: { allow: ['src/**'], protect: [] },
    approval: { contract_approved: false, require_on: ['scope_change'] },
    budgets: { max_worker_retries_per_cause: 3, max_lead_escalations: 3, max_wall_minutes: 30 },
    acceptance: [{ id: 'AC-01', requirement: 'REQ-01', kind: 'e2e', command: 'node --version', expected_exit_code: 0 }],
    source_policy: { authority: ['git-main'], source_refs: ['README.md'] },
  }, null, 2));
  approveContractFile(contractPath, 'operator');
  initCheckpoint({ repo, contract: contractPath, runId: `${taskId}-RUN` });
  return `${taskId}-RUN`;
}

function toReview(repo, runId) {
  runVerify({ repo, runId });
  publishReviewPackage({ repo, runId, kouetsuRoot: KOUETSU });
  assert.equal(state(repo, runId), 'READY_FOR_HUMAN_REVIEW');
}

// A person at the prompt: answers are looked up by what the question asks.
function operator(answers) {
  const asked = [];
  const ask = async (message) => {
    asked.push(message);
    const hit = answers.find(([pattern]) => pattern.test(message));
    if (!hit) throw new Error(`unexpected question: ${message}`);
    return typeof hit[1] === 'function' ? hit[1]() : hit[1];
  };
  return { ask, asked };
}

// One run whose report was edited after verification, two that can be accepted.
function threeWaitingRuns(repo) {
  const [old, first, second] = ['OLD', 'ONE', 'TWO'].map((id) => openRun(repo, id));
  fs.writeFileSync(path.join(repo, 'src', 'app.mjs'), 'export const val = 2;\n', 'utf8');
  toReview(repo, old);
  // Its report is edited afterwards: the one thing that still stops an acceptance.
  fs.appendFileSync(path.join(repo, '.crafthelm', 'runs', old, 'reports', 'review-package.md'), '\nedited\n');
  fs.writeFileSync(path.join(repo, 'src', 'app.mjs'), 'export const val = 3;\n', 'utf8');
  toReview(repo, first);
  toReview(repo, second);
  return { old, first, second };
}

describe('Review desk: the waiting runs decided in one sitting', () => {
  it('lists what waits and says which runs can still be accepted', () => {
    const repo = makeRepo();
    try {
      const { old, first, second } = threeWaitingRuns(repo);
      const queue = listReviewQueue({ repo });
      assert.deepEqual(
        queue.runs.map((r) => [r.run_id, r.acceptable, r.problems.map((p) => p.code)]),
        [[old, false, ['STALE_REPORT']], [first, true, []], [second, true, []]],
      );
      assert.deepEqual(
        [queue.runs[1].request, queue.runs[1].technical_status, queue.runs[1].package_path],
        ['Change val for ONE', 'VERIFIED', '.crafthelm/runs/ONE-RUN/reports/review-package.md'],
      );
      // Listing changes nothing.
      assert.deepEqual([old, first, second].map((id) => state(repo, id)), Array(3).fill('READY_FOR_HUMAN_REVIEW'));
    } finally {
      remove(repo);
    }
  });

  it('accepts the chosen runs under one confirmation and closes the replaced one without a decision record', async () => {
    const repo = makeRepo();
    try {
      const { old, first, second } = threeWaitingRuns(repo);
      const queue = listReviewQueue({ repo });
      const code = sha256Text([queue.runs[1].package_sha256, queue.runs[2].package_sha256].sort().join('\n')).slice(-8);
      const shown = [];
      const person = operator([
        [/^Accept which runs\?/, 'all'],
        [/^Close which runs without accepting them\?/, 'stale'],
        [/^Type the confirmation code/, code],
        [/^Reason for closing/, ''],
        [/^Type CLOSE to confirm/, 'CLOSE'],
      ]);
      const res = await runReviewDesk({ repo, actor: 'seung', rationale: 'Read both packages', ask: person.ask, write: (t) => shown.push(t) });

      assert.deepEqual([res.ok, res.waiting, res.failed, res.left_waiting], [true, 3, [], []]);
      assert.deepEqual(res.accepted.map((a) => [a.run_id, a.state, a.verification_type]), [
        [first, 'ACCEPTED', 'local_tty_confirmed_not_identity_verified'],
        [second, 'ACCEPTED', 'local_tty_confirmed_not_identity_verified'],
      ]);
      assert.deepEqual(res.closed, [{ run_id: old, previous_state: 'READY_FOR_HUMAN_REVIEW' }]);
      const screen = shown.join('');
      assert.match(screen, /1\. OLD-RUN {2}\[cannot be accepted: STALE_REPORT\]/);
      assert.match(screen, /2\. ONE-RUN {2}\[ready to decide\]\n {6}Change val for ONE\n {6}checks: VERIFIED \| package: \.crafthelm\/runs\/ONE-RUN\/reports\/review-package\.md \(sha256 \.\.\.[a-f0-9]{8}\)/);
      assert.ok(screen.includes(`Confirmation code for these review packages: ${code}`));

      // Each accepted run has its own valid decision record, marked as part of the batch.
      for (const runId of [first, second]) {
        const decision = readJson(getApprovalDecisionPath(repo, runId));
        assert.deepEqual([decision.decision, decision.actor, decision.rationale, decision.batch], ['accepted', 'seung', 'Read both packages', { run_ids: [first, second] }]);
        assert.equal(verifyHumanDecision({ repo, runId }).valid, true);
      }
      // The closed run is ended, says why and how, and was never accepted.
      const closed = readJson(getCheckpointPath(repo, old));
      assert.equal(closed.state, 'ABORTED');
      assert.deepEqual(
        [closed.closure.reason, closed.closure.previous_state, closed.closure.closed_via, closed.closure.actor],
        ['Replaced by later work; closed without acceptance.', 'READY_FOR_HUMAN_REVIEW', 'interactive_terminal', 'seung'],
      );
      assert.equal(fs.existsSync(getApprovalDecisionPath(repo, old)), false);
      // Nothing is left to remind a session about.
      assert.doesNotMatch(describeSessionStatus({ cwd: repo, event: 'UserPromptSubmit' }), /wait on a person/);
      assert.equal((await runReviewDesk({ repo, actor: 'seung', ask: person.ask, write: () => {} })).waiting, 0);
    } finally {
      remove(repo);
    }
  });

  it('records nothing when the confirmation is wrong, when a stale run is picked for acceptance, or when closing is not confirmed', async () => {
    const repo = makeRepo();
    try {
      const { old, first, second } = threeWaitingRuns(repo);
      const all = [old, first, second];
      const desk = (answers) => runReviewDesk({ repo, actor: 'seung', rationale: 'ok', ask: operator(answers).ask, write: () => {} });

      await assert.rejects(desk([[/^Accept which/, '2'], [/^Close which/, ''], [/^Type the confirmation code/, 'deadbeef']]), /HUMAN_GATE_CONFIRMATION_MISMATCH: confirmation code did not match; nothing was recorded\./);
      await assert.rejects(desk([[/^Accept which/, '1 2'], [/^Close which/, '']]), /REVIEW_DESK_SELECTION_INVALID: OLD-RUN cannot be accepted as it stands \(STALE_REPORT\); nothing was recorded\./);
      await assert.rejects(desk([[/^Accept which/, '7']]), /REVIEW_DESK_SELECTION_INVALID: "7" is not a number from the list \(1-3\)/);
      await assert.rejects(desk([[/^Accept which/, '2'], [/^Close which/, '1-2']]), /ONE-RUN was chosen both to accept and to close/);
      await assert.rejects(desk([[/^Accept which/, ''], [/^Close which/, '1'], [/^Reason for closing/, 'old'], [/^Type CLOSE/, 'yes']]), /closing was not confirmed; nothing was recorded\./);
      await assert.rejects(runReviewDesk({ repo, actor: ' ', ask: operator([]).ask, write: () => {} }), /Explicit --actor is required/);

      assert.deepEqual(all.map((id) => state(repo, id)), Array(3).fill('READY_FOR_HUMAN_REVIEW'));
      assert.ok(all.every((id) => !fs.existsSync(getApprovalDecisionPath(repo, id))));

      // Choosing nothing is a plain exit; a single accepted run uses its own package hash and carries no batch mark.
      const none = await desk([[/^Accept which/, ''], [/^Close which/, 'none']]);
      assert.deepEqual([none.accepted, none.closed, none.left_waiting], [[], [], all]);
      const one = listReviewQueue({ repo }).runs[1];
      const single = await desk([[/^Accept which/, '2'], [/^Close which/, ''], [/^Type the confirmation code/, one.package_sha256.slice(-8)]]);
      assert.deepEqual(single.accepted.map((a) => a.run_id), [first]);
      assert.equal(readJson(getApprovalDecisionPath(repo, first)).batch, undefined);
    } finally {
      remove(repo);
    }
  });
});

describe('checkpoint close: ending a run that will not be accepted', () => {
  it('needs a reason, refuses a decided run, and closes several runs all or nothing', () => {
    const repo = makeRepo();
    try {
      const a = openRun(repo, 'A');
      const b = openRun(repo, 'B');
      assert.throws(() => closeRun({ repo, runId: a, reason: '  ' }), /CLOSE_REASON_REQUIRED/);
      assert.throws(() => closeRun({ repo, runId: 'NOPE', reason: 'x' }), /RUN_NOT_FOUND/);
      assert.throws(() => closeRun({ repo, runId: a, reason: 'x', supersededBy: a }), /SUPERSEDING_RUN_INVALID: run "A-RUN" cannot be replaced by itself\./);
      assert.throws(() => closeRun({ repo, runId: a, reason: 'x', supersededBy: 'NOPE' }), /SUPERSEDING_RUN_INVALID: --superseded-by "NOPE" is not a run/);

      const cli = (...args) => spawnSync(process.execPath, [path.join(CRAFTHELM_ROOT, 'scripts', 'crafthelm.mjs'), 'checkpoint', 'close', '--repo', repo, ...args], { cwd: repo, encoding: 'utf8' });
      const bad = cli('--run-id', `${a},NOPE`, '--reason', 'Replaced');
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /RUN_NOT_FOUND/);
      assert.equal(state(repo, a), 'READY');

      const ok = cli('--run-id', `${a},${b}`, '--reason', 'Replaced by C', '--actor', 'seung');
      assert.equal(ok.status, 0, ok.stderr);
      assert.deepEqual(JSON.parse(ok.stdout).closed, [{ run_id: a, previous_state: 'READY' }, { run_id: b, previous_state: 'READY' }]);
      const closed = readJson(getCheckpointPath(repo, a));
      assert.deepEqual([closed.state, closed.closure.reason, closed.closure.actor], ['ABORTED', 'Replaced by C', 'seung']);
      assert.ok(['agent_session', 'interactive_terminal', 'non_interactive'].includes(closed.closure.closed_via));
      assert.throws(() => closeRun({ repo, runId: a, reason: 'again' }), /RUN_ALREADY_CLOSED/);

      // superseded_by names the run that replaced it.
      const c = openRun(repo, 'C');
      const d = openRun(repo, 'D');
      assert.equal(closeRun({ repo, runId: c, reason: 'D covers it', supersededBy: d }).closure.superseded_by, d);
    } finally {
      remove(repo);
    }
  });

  it('does not close an accepted run', async () => {
    const repo = makeRepo();
    try {
      const runId = openRun(repo, 'ACC');
      fs.writeFileSync(path.join(repo, 'src', 'app.mjs'), 'export const val = 2;\n', 'utf8');
      toReview(repo, runId);
      const sha = listReviewQueue({ repo }).runs[0].package_sha256;
      await runReviewDesk({ repo, actor: 'seung', rationale: 'ok', write: () => {}, ask: operator([[/^Accept which/, 'all'], [/^Close which/, ''], [/^Type the confirmation code/, sha.slice(-8)]]).ask });
      assert.throws(() => closeRun({ repo, runId, reason: 'x' }), /RUN_NOT_CLOSABLE: run "ACC-RUN" is ACCEPTED; a run that already has its decision is not closed\./);
    } finally {
      remove(repo);
    }
  });
});

describe('Review desk: held to the human gate', () => {
  it('refuses to run without a terminal, is denied to Claude Code, and is not cut off by the CLI time limit', () => {
    const repo = makeRepo();
    try {
      const res = spawnSync(process.execPath, [path.join(CRAFTHELM_ROOT, 'scripts', 'crafthelm.mjs'), 'approve', 'batch', '--repo', repo, '--actor', 'seung'], { cwd: repo, encoding: 'utf8', input: 'all\n' });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /HUMAN_GATE_/);

      const guards = getClaudeGuardRules();
      for (const rule of ['Bash(*approval.mjs batch*)', 'Bash(*crafthelm.mjs approve batch*)', 'Bash(*crafthelm approve batch*)']) assert.ok(guards.deny.includes(rule), rule);
      for (const rule of ['Bash(*checkpoint.mjs close*)', 'Bash(*crafthelm.mjs checkpoint close*)', 'Bash(*crafthelm checkpoint close*)']) assert.ok(guards.ask.includes(rule), rule);
      assert.equal(resolveCommandTimeoutMs('approve', {}), 0);
    } finally {
      remove(repo);
    }
  });
});
