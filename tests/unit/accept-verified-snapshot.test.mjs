import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { listReviewQueue, recordHumanDecision, verifyHumanDecision } from '../../scripts/approval.mjs';
import { initCheckpoint, resumeRun } from '../../scripts/checkpoint.mjs';
import { approveContractFile } from '../../scripts/contract.mjs';
import { computeSnapshotDigest, runGit } from '../../scripts/lib/git.mjs';
import { CRAFTHELM_ROOT, getApprovalDecisionPath, getCheckpointPath, getEvidenceManifestPath, getReviewPackagePath, getVerificationStampPath } from '../../scripts/lib/paths.mjs';
import { buildReviewData } from '../../scripts/review.mjs';
import { publishReviewPackage } from '../../scripts/review-package.mjs';
import { getWorkspaceStatus } from '../../scripts/status.mjs';
import { runVerify } from '../../scripts/verify.mjs';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const remove = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
const KOUETSU = path.join(CRAFTHELM_ROOT, 'hosts', 'codex', 'skills', 'kouetsu');
const write = (repo, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text, 'utf8');
};

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-bound-'));
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['config', 'user.name', 'CraftHelm Test']);
  runGit(repo, ['config', 'user.email', 'test@crafthelm.local']);
  write(repo, 'README.md', '# Base\n');
  write(repo, 'src/app.mjs', 'export const val = 1;\n');
  write(repo, 'src/other.mjs', 'export const other = 1;\n');
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-m', 'Base']);
  return repo;
}

function reviewedRun(repo, taskId) {
  const contractPath = path.join(repo, '.crafthelm', 'contracts', `${taskId}.json`);
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(contractPath, JSON.stringify({
    schema_version: '0.3', task_id: taskId, request: `Change for ${taskId}`, project_root: '.', host: 'codex', change_kind: 'refactor',
    methodology: { lifecycle: 'incremental', specification: 'lightweight', engineering: 'test_after', execution: 'full' },
    scope: { allow: ['src/**'], protect: [] },
    approval: { contract_approved: false, require_on: ['scope_change'] },
    budgets: { max_worker_retries_per_cause: 3, max_lead_escalations: 3, max_wall_minutes: 30 },
    acceptance: [{ id: 'AC-01', requirement: 'REQ-01', kind: 'e2e', command: 'node --version', expected_exit_code: 0 }],
    source_policy: { authority: ['git-main'], source_refs: ['README.md'] },
  }, null, 2));
  approveContractFile(contractPath, 'operator');
  const runId = `${taskId}-RUN`;
  initCheckpoint({ repo, contract: contractPath, runId });
  write(repo, 'src/app.mjs', 'export const val = 2;\n');
  write(repo, 'src/other.mjs', 'export const other = 2;\n');
  runVerify({ repo, runId });
  publishReviewPackage({ repo, runId, kouetsuRoot: KOUETSU });
  assert.equal(readJson(getCheckpointPath(repo, runId)).state, 'READY_FOR_HUMAN_REVIEW');
  return { runId, contractPath };
}

describe('Acceptance is bound to the verified snapshot, not to the tree at the time of the decision', () => {
  it('accepts a run after the next task changed the tree, and records which of its files changed since', () => {
    const repo = makeRepo();
    try {
      const { runId, contractPath } = reviewedRun(repo, 'BOUND');
      const verified = readJson(getVerificationStampPath(repo, runId)).target_snapshot_digest;
      assert.deepEqual(Object.keys(readJson(getEvidenceManifestPath(repo, runId)).scope.changed_file_hashes), ['src/app.mjs', 'src/other.mjs']);

      // Nothing moved yet: nothing to report.
      const before = listReviewQueue({ repo }).runs[0];
      assert.deepEqual([before.acceptable, before.tree_changed, before.changed_since], [true, false, null]);

      // The next task starts: one of this run's files is edited again and a new file appears.
      write(repo, 'src/app.mjs', 'export const val = 3;\n');
      write(repo, 'src/next.mjs', 'export const next = true;\n');
      const queued = listReviewQueue({ repo }).runs[0];
      assert.deepEqual([queued.acceptable, queued.problems, queued.tree_changed, queued.changed_since], [true, [], true, ['src/app.mjs']]);
      const shown = buildReviewData({ repo }).groups[0].runs[0];
      assert.deepEqual([shown.acceptable, shown.tree_changed, shown.changed_since], [true, true, ['src/app.mjs']]);
      // status points at the review page instead of asking for another verification.
      const status = getWorkspaceStatus({ repo });
      assert.match(status.next_command, / review --repo /);
      assert.match(status.next_action, /검증 뒤 작업 트리가 달라졌지만 결정할 수 있습니다/);

      const res = recordHumanDecision({ repo, runId, decision: 'accept', actor: 'seung', rationale: 'Read it' });
      assert.deepEqual([res.state, res.tree_changed_since_verification, res.changed_since_verification, res.target_snapshot_digest], ['ACCEPTED', true, ['src/app.mjs'], verified]);
      const decision = readJson(getApprovalDecisionPath(repo, runId));
      assert.equal(decision.target_snapshot_digest, verified);
      assert.equal(decision.tree_at_decision_digest, computeSnapshotDigest(repo));
      assert.notEqual(decision.tree_at_decision_digest, verified);
      assert.deepEqual(decision.changed_since_verification, ['src/app.mjs']);

      // The decision stands while the tree keeps moving; the check says the tree is no longer that snapshot.
      write(repo, 'src/next.mjs', 'export const next = false;\n');
      const checked = verifyHumanDecision({ repo, runId });
      assert.deepEqual([checked.valid, checked.status, checked.tree_matches_decision], [true, 'VALID', false]);
      const resumed = resumeRun({ repo, runId, contract: contractPath });
      assert.notEqual(resumed.stale, true);
      assert.equal(readJson(getCheckpointPath(repo, runId)).state, 'ACCEPTED');

      // What still undoes it: the report or the evidence no longer being what was decided on.
      fs.appendFileSync(getReviewPackagePath(repo, runId), '\nedited\n');
      assert.deepEqual([verifyHumanDecision({ repo, runId }).valid, verifyHumanDecision({ repo, runId }).status], [false, 'INVALIDATED']);
      assert.equal(resumeRun({ repo, runId, contract: contractPath }).stale, true);
    } finally {
      remove(repo);
    }
  });

  it('says only that the tree changed for a run verified before file hashes were recorded, and leaves the fields out when nothing moved', () => {
    const repo = makeRepo();
    try {
      const { runId } = reviewedRun(repo, 'OLDER');
      // A manifest as an earlier version wrote it.
      const manifestPath = getEvidenceManifestPath(repo, runId);
      const manifest = readJson(manifestPath);
      delete manifest.scope.changed_file_hashes;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      write(repo, 'src/app.mjs', 'export const val = 3;\n');
      const queued = listReviewQueue({ repo }).runs[0];
      assert.deepEqual([queued.acceptable, queued.tree_changed, queued.changed_since], [true, true, null]);
      recordHumanDecision({ repo, runId, decision: 'accept', actor: 'seung', rationale: 'Read it' });
      const decision = readJson(getApprovalDecisionPath(repo, runId));
      assert.ok(decision.tree_at_decision_digest);
      assert.equal(Object.hasOwn(decision, 'changed_since_verification'), false);

      // Decided on the verified tree itself: neither field is written.
      const second = reviewedRun(repo, 'SAME');
      recordHumanDecision({ repo, runId: second.runId, decision: 'accept', actor: 'seung', rationale: 'Read it' });
      const same = readJson(getApprovalDecisionPath(repo, second.runId));
      assert.deepEqual([Object.hasOwn(same, 'tree_at_decision_digest'), Object.hasOwn(same, 'changed_since_verification')], [false, false]);
      assert.equal(verifyHumanDecision({ repo, runId: second.runId }).tree_matches_decision, true);
    } finally {
      remove(repo);
    }
  });
});
