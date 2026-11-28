import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { listReviewQueue, recordHumanDecision } from '../../scripts/approval.mjs';
import { closeRun, initCheckpoint } from '../../scripts/checkpoint.mjs';
import { approveContractFile } from '../../scripts/contract.mjs';
import { appendTrialRecord, assessAcceptanceTrial, readTrialRecords, summarizeAcceptanceTrial } from '../../scripts/lib/acceptance-trial.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { CRAFTHELM_ROOT, getApprovalDecisionPath, getCheckpointPath } from '../../scripts/lib/paths.mjs';
import { writeZones } from '../../scripts/lib/zones.mjs';
import { buildReviewData } from '../../scripts/review.mjs';
import { publishReviewPackage } from '../../scripts/review-package.mjs';
import { runVerify } from '../../scripts/verify.mjs';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const remove = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
const KOUETSU = path.join(CRAFTHELM_ROOT, 'hosts', 'codex', 'skills', 'kouetsu');
const write = (repo, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text, 'utf8');
};
const commit = (repo, message) => { runGit(repo, ['add', '-A']); runGit(repo, ['commit', '-m', message]); };

describe('Acceptance trial: what a standing rule would have done, from the evidence alone', () => {
  const light = { zone: { classification: 'light' }, technical_status: 'VERIFIED' };
  it('takes a light, verified run with nothing unverified, and says why it does not take another', () => {
    assert.deepEqual(assessAcceptanceTrial(light, { unverified: [] }), { candidate: true, reasons: [] });
    assert.deepEqual(assessAcceptanceTrial({ ...light, zone: { classification: 'strict' } }, { unverified: [] }).reasons, ['ZONE_STRICT']);
    // A project that has not decided its zones gets no candidates: undefined is not light.
    assert.deepEqual(assessAcceptanceTrial({ technical_status: 'VERIFIED' }, { unverified: [] }).reasons, ['ZONE_UNDEFINED']);
    assert.deepEqual(assessAcceptanceTrial({ ...light, technical_status: 'PARTIAL' }, { unverified: ['AC-02 (manual: look)'] }).reasons, ['NOT_VERIFIED', 'UNVERIFIED_ITEMS']);
    assert.deepEqual(assessAcceptanceTrial(light, { unverified: [] }, [{ code: 'STALE_REPORT' }]).reasons, ['NOT_ACCEPTABLE']);
    assert.deepEqual(assessAcceptanceTrial(null, null).reasons, ['ZONE_UNDEFINED', 'NOT_VERIFIED']);
  });

  it('compares the rule with the person: a run sent back stays a disagreement, a closed run is not counted', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-trial-log-'));
    try {
      assert.deepEqual([summarizeAcceptanceTrial(repo).runs, summarizeAcceptanceTrial(repo).reading], [0, 'No run the rule would have accepted has been decided yet.']);
      const yes = { candidate: true, reasons: [] };
      const log = (runId, decision, trial = yes) => appendTrialRecord(repo, { run_id: runId, task_id: 'T', decision, zone: trial.candidate ? 'light' : 'strict', trial });
      for (let i = 1; i <= 8; i += 1) log(`OK-${i}`, 'accepted');
      log('BACK', 'changes_requested');
      log('BACK', 'accepted');
      log('NO', 'rejected');
      log('GONE', 'closed');
      log('STRICT-1', 'accepted', { candidate: false, reasons: ['ZONE_STRICT'] });
      log('STRICT-2', 'changes_requested', { candidate: false, reasons: ['ZONE_STRICT', 'UNVERIFIED_ITEMS'] });
      // A torn line from an interrupted write is skipped.
      fs.appendFileSync(path.join(repo, '.crafthelm', 'runs', '.trial', 'acceptance-trial.jsonl'), '{"run_id":"TORN"');

      const s = summarizeAcceptanceTrial(repo);
      assert.equal(s.runs, 13);
      assert.deepEqual(
        [s.would_accept.runs, s.would_accept.decided, s.would_accept.accepted_by_person, s.would_accept.sent_back_by_person, s.would_accept.closed_or_pending, s.would_accept.agreement_rate],
        [11, 10, 8, 2, 1, 0.8],
      );
      assert.deepEqual(s.would_accept.disagreements, [{ run_id: 'BACK', decision: 'sent back before acceptance' }, { run_id: 'NO', decision: 'rejected' }]);
      assert.deepEqual(s.would_not_accept, { runs: 2, by_reason: { ZONE_STRICT: { runs: 2, accepted: 1 }, UNVERIFIED_ITEMS: { runs: 1, accepted: 0 } } });
      assert.deepEqual([s.enough_data, s.reading], [true, 'The person sent back 2 of 10 runs the rule would have accepted; look at those before switching the rule on.']);
    } finally {
      remove(repo);
    }
  });

  it('says when there is too little to go on', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-trial-few-'));
    try {
      for (const id of ['A', 'B', 'C']) appendTrialRecord(repo, { run_id: id, decision: 'accepted', trial: { candidate: true, reasons: [] } });
      const s = summarizeAcceptanceTrial(repo);
      assert.deepEqual([s.would_accept.agreement_rate, s.enough_data, s.reading], [1, false, 'Only 3 such run(s) decided; at least 10 are needed before the rate says much.']);
    } finally {
      remove(repo);
    }
  });
});

describe('Acceptance trial: shown beside each run and logged with each decision, accepting nothing', () => {
  function makeRepo() {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-trial-'));
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.name', 'CraftHelm Test']);
    runGit(repo, ['config', 'user.email', 'test@crafthelm.local']);
    write(repo, 'README.md', '# Base\n');
    write(repo, 'src/app.mjs', 'export const val = 1;\n');
    write(repo, 'schemas/book.schema.json', '{"type":"object"}\n');
    writeZones(repo, { strict: [{ path: 'schemas/**', reason: 'other tools read these' }], actor: 'seung' });
    commit(repo, 'Base with zones');
    return repo;
  }
  function reviewed(repo, taskId, change, acceptance) {
    const contractPath = path.join(repo, '.crafthelm', 'contracts', `${taskId}.json`);
    fs.mkdirSync(path.dirname(contractPath), { recursive: true });
    fs.writeFileSync(contractPath, JSON.stringify({
      schema_version: '0.3', task_id: taskId, request: `Change for ${taskId}`, project_root: '.', host: 'codex', change_kind: 'refactor',
      methodology: { lifecycle: 'incremental', specification: 'lightweight', engineering: 'test_after', execution: 'full' },
      scope: { allow: ['src/**', 'schemas/**'], protect: [] },
      approval: { contract_approved: false, require_on: ['scope_change'] },
      budgets: { max_worker_retries_per_cause: 3, max_lead_escalations: 3, max_wall_minutes: 30 },
      acceptance: acceptance ?? [{ id: 'AC-01', requirement: 'REQ-01', kind: 'e2e', command: 'node --version', expected_exit_code: 0 }],
      source_policy: { authority: ['git-main'], source_refs: ['README.md'] },
    }, null, 2));
    approveContractFile(contractPath, 'operator');
    const runId = `${taskId}-RUN`;
    initCheckpoint({ repo, contract: contractPath, runId });
    change();
    runVerify({ repo, runId });
    publishReviewPackage({ repo, runId, kouetsuRoot: KOUETSU });
    assert.equal(readJson(getCheckpointPath(repo, runId)).state, 'READY_FOR_HUMAN_REVIEW');
    commit(repo, `Work for ${taskId}`);
    return runId;
  }

  it('marks the light, clean run, explains the others, and leaves every run waiting until a person decides', () => {
    const repo = makeRepo();
    try {
      const manual = reviewed(repo, 'MANUAL', () => write(repo, 'src/app.mjs', 'export const val = 2;\n'), [
        { id: 'AC-01', requirement: 'REQ-01', kind: 'e2e', command: 'node --version', expected_exit_code: 0 },
        { id: 'AC-02', requirement: 'REQ-01', kind: 'manual', manual_method: 'Look at the output' },
      ]);
      const light = reviewed(repo, 'LIGHT', () => write(repo, 'src/app.mjs', 'export const val = 3;\n'));
      const strict = reviewed(repo, 'STRICT', () => write(repo, 'schemas/book.schema.json', '{"type":"array"}\n'));

      const trials = Object.fromEntries(listReviewQueue({ repo }).runs.map((r) => [r.run_id, r.trial]));
      assert.deepEqual(trials[light], { candidate: true, reasons: [] });
      assert.deepEqual(trials[strict], { candidate: false, reasons: ['ZONE_STRICT'] });
      assert.deepEqual(trials[manual], { candidate: false, reasons: ['NOT_VERIFIED', 'UNVERIFIED_ITEMS'] });
      assert.deepEqual(buildReviewData({ repo }).groups.flatMap((g) => g.runs).map((r) => [r.run_id, r.trial.candidate]).sort(), [[light, true], [manual, false], [strict, false]].sort());

      // The trial accepts nothing: all three still wait, and nothing has been logged.
      for (const id of [manual, light, strict]) {
        assert.equal(readJson(getCheckpointPath(repo, id)).state, 'READY_FOR_HUMAN_REVIEW');
        assert.equal(fs.existsSync(getApprovalDecisionPath(repo, id)), false);
      }
      assert.deepEqual(readTrialRecords(repo), []);

      // Each decision a person makes is logged beside what the rule would have done.
      recordHumanDecision({ repo, runId: light, decision: 'accept', actor: 'seung', rationale: 'fine' });
      recordHumanDecision({ repo, runId: strict, decision: 'changes-requested', actor: 'seung', rationale: 'keep object' });
      closeRun({ repo, runId: manual, reason: 'replaced' });
      assert.deepEqual(readTrialRecords(repo).map((r) => [r.run_id, r.zone, r.would_accept, r.reasons, r.decision]), [
        [light, 'light', true, [], 'accepted'],
        [strict, 'strict', false, ['ZONE_STRICT'], 'changes_requested'],
        [manual, 'light', false, ['NOT_VERIFIED', 'UNVERIFIED_ITEMS'], 'closed'],
      ]);

      const cli = spawnSync(process.execPath, [path.join(CRAFTHELM_ROOT, 'scripts', 'crafthelm.mjs'), 'approve', 'trial', '--repo', repo], { cwd: repo, encoding: 'utf8' });
      assert.equal(cli.status, 0, cli.stderr);
      const summary = JSON.parse(cli.stdout);
      assert.deepEqual([summary.runs, summary.would_accept.decided, summary.would_accept.agreement_rate, summary.enough_data], [3, 1, 1, false]);
      assert.match(cli.stderr, /Only 1 such run\(s\) decided; at least 10 are needed/);
    } finally {
      remove(repo);
    }
  });
});
