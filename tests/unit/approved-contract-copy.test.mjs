import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { initCheckpoint, replanRun } from '../../scripts/checkpoint.mjs';
import { addE2eCriterion, approveContractFile } from '../../scripts/contract.mjs';
import { runInterview } from '../../scripts/interview.mjs';
import { contractBodyHash, diffContracts, readApprovalRecord } from '../../scripts/lib/contract-approval.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { CRAFTHELM_ROOT, getCheckpointPath } from '../../scripts/lib/paths.mjs';
import { evaluateWrite } from '../../scripts/lib/scope-guard.mjs';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const remove = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-approved-'));
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

function writeContract(repo, taskId) {
  const contractPath = path.join(repo, '.crafthelm', 'contracts', `${taskId}.json`);
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(contractPath, JSON.stringify({
    schema_version: '0.3', task_id: taskId, request: 'Set val to 2', project_root: '.', host: 'generic', change_kind: 'refactor',
    methodology: { lifecycle: 'incremental', specification: 'lightweight', engineering: 'test_after', execution: 'full' },
    scope: { allow: ['src/**'], protect: ['README.md'] },
    approval: { contract_approved: false, require_on: ['scope_change'] },
    budgets: { max_worker_retries_per_cause: 3, max_lead_escalations: 3, max_wall_minutes: 30 },
    requirements: [{ id: 'REQ-01', statement: 'val is 2' }, { id: 'REQ-02', statement: 'the module still loads' }],
    acceptance: [
      { id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node tests/val.test.mjs', expected_exit_code: 0 },
      { id: 'AC-02', requirement: 'REQ-02', kind: 'e2e', command: 'node --version', expected_exit_code: 0 },
    ],
    source_policy: { authority: ['git-main'], source_refs: ['README.md'] },
  }, null, 2));
  return contractPath;
}

// A person (or an agent through the shell) edits the file; the approved flag stays where it was.
const edit = (contractPath, change) => {
  const contract = readJson(contractPath);
  change(contract);
  fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
};

describe('Approved contract copy: approval is about a content, not a flag', () => {
  it('keeps what was approved, and refuses to open a run on a contract edited afterwards', () => {
    const repo = makeRepo();
    try {
      const contractPath = writeContract(repo, 'COPY');
      const approved = approveContractFile(contractPath, 'seung');
      const record = readApprovalRecord(repo, 'COPY');
      assert.deepEqual([record.approved_by, record.body_sha256, record.contract.acceptance.length], ['seung', contractBodyHash(readJson(contractPath)), 2]);
      assert.equal(approved.changes_since_last_approval, undefined);

      // The same contract again: a no-op that has now compared the content.
      const again = approveContractFile(contractPath, 'seung');
      assert.deepEqual([again.already_approved, again.content_checked], [true, true]);
      assert.match(again.note, /is the same as the approved copy; nothing was written/);

      // A check is dropped, a command swapped, the scope widened. The flag still says approved.
      edit(contractPath, (c) => {
        c.acceptance = c.acceptance.filter((ac) => ac.id !== 'AC-02');
        c.acceptance[0].command = 'node -e "process.exit(0)"';
        c.scope.allow.push('docs/**');
        c.scope.protect = [];
      });
      assert.equal(readJson(contractPath).approval.contract_approved, true);
      const expected = [
        /CONTRACT_CHANGED_SINCE_APPROVAL: contract COPY is not what "seung" approved at .+; opening a run stopped\./,
        /acceptance AC-01 command changed: "node tests\/val\.test\.mjs" -> "node -e \\"process\.exit\(0\)\\""/,
        /acceptance AC-02 removed \(was: e2e "node --version"\)/,
        /scope\.allow widened: docs\/\*\* added/,
        /scope\.protect: README\.md no longer protected/,
      ];
      for (const pattern of expected) assert.throws(() => initCheckpoint({ repo, contract: contractPath, runId: 'COPY-RUN' }), pattern);
      assert.equal(fs.existsSync(getCheckpointPath(repo, 'COPY-RUN')), false);

      // Approving again does not pass as "already approved": the changes have to be accepted by name.
      assert.throws(() => approveContractFile(contractPath, 'seung'), /CONTRACT_CHANGED_SINCE_APPROVAL: contract COPY is marked approved but is not what "seung" approved[\s\S]*run the same command with --accept-changes\./);
      assert.throws(() => approveContractFile(contractPath, 'someone-else'), /CONTRACT_CHANGED_SINCE_APPROVAL/);
      const accepted = approveContractFile(contractPath, 'seung', { acceptChanges: true });
      assert.equal(accepted.already_approved, undefined);
      assert.deepEqual(accepted.changes_since_last_approval.weakening.length, 4);
      assert.equal(readApprovalRecord(repo, 'COPY').contract.acceptance.length, 1);
      assert.equal(initCheckpoint({ repo, contract: contractPath, runId: 'COPY-RUN' }).state, 'READY');
    } finally {
      remove(repo);
    }
  });

  it('does not take a hand-set flag for an approval, and checks a re-plan the same way', () => {
    const repo = makeRepo();
    try {
      // Never approved: the flag is written into the file directly.
      const forged = writeContract(repo, 'FORGED');
      edit(forged, (c) => { c.approval = { ...c.approval, contract_approved: true, contract_approved_by: 'seung', contract_approved_at: new Date().toISOString() }; });
      assert.throws(() => initCheckpoint({ repo, contract: forged, runId: 'FORGED-RUN' }), /CONTRACT_APPROVAL_RECORD_MISSING: contract FORGED is marked approved, but there is no record of what was approved/);
      // Approving it for real records it, and the run opens.
      assert.equal(approveContractFile(forged, 'seung').already_approved, undefined);
      assert.equal(initCheckpoint({ repo, contract: forged, runId: 'FORGED-RUN' }).state, 'READY');

      // Mid-run the contract is edited; a re-plan needs the edited contract approved, not just flagged.
      edit(forged, (c) => { c.acceptance = c.acceptance.filter((ac) => ac.id !== 'AC-01'); c.requirements = c.requirements.filter((r) => r.id !== 'REQ-01'); });
      assert.throws(() => replanRun({ repo, runId: 'FORGED-RUN', reason: 'drop AC-01' }), /CONTRACT_CHANGED_SINCE_APPROVAL: contract FORGED is not what "seung" approved at .+; the replan stopped\.[\s\S]*acceptance AC-01 removed[\s\S]*requirement REQ-01 removed \(val is 2\)/);
      approveContractFile(forged, 'seung', { acceptChanges: true });
      assert.equal(replanRun({ repo, runId: 'FORGED-RUN', reason: 'drop AC-01' }).ok, true);
    } finally {
      remove(repo);
    }
  });

  it('shows what an amended contract adds when it is approved again, and records a contract approved at interview', () => {
    const repo = makeRepo();
    try {
      const contractPath = writeContract(repo, 'AMEND');
      approveContractFile(contractPath, 'seung');
      // The supported way to change a contract resets the flag; the next approval says what is new.
      addE2eCriterion(contractPath, 'node tests/e2e.test.mjs');
      assert.equal(readJson(contractPath).approval.contract_approved, false);
      const res = approveContractFile(contractPath, 'seung');
      assert.deepEqual(res.changes_since_last_approval, { weakening: [], other: ['acceptance AC-03 added (e2e "node tests/e2e.test.mjs")'] });

      const iv = runInterview({ repo, taskId: 'IVAPPROVED', request: 'Set val to 3', e2eCommand: 'node --version', approveContract: true, actor: 'seung' });
      assert.equal(readApprovalRecord(repo, 'IVAPPROVED').body_sha256, contractBodyHash(readJson(iv.contract_path)));
      assert.equal(initCheckpoint({ repo, contract: iv.contract_path, runId: 'IV-RUN' }).state, 'READY');

      // The record is closed to file tools like the rest of the run directory.
      assert.equal(evaluateWrite({ filePath: path.join(repo, '.crafthelm', 'runs', '.approvals', 'AMEND.json'), cwd: repo }).decision, 'deny');
    } finally {
      remove(repo);
    }
  });

  it('contract diff lists the differences, and approve --accept-changes is the only way past them', () => {
    const repo = makeRepo();
    try {
      const contractPath = writeContract(repo, 'CLI');
      const cli = (...args) => spawnSync(process.execPath, [path.join(CRAFTHELM_ROOT, 'scripts', 'crafthelm.mjs'), 'contract', ...args], { cwd: repo, encoding: 'utf8' });
      assert.equal(JSON.parse(cli('diff', contractPath).stdout).status, 'NO_RECORD');
      assert.equal(cli('approve', contractPath, '--actor', 'seung').status, 0);
      assert.deepEqual([JSON.parse(cli('diff', contractPath).stdout).status, cli('diff', contractPath).stderr.includes('The contract is the same as the approved copy.')], ['MATCHES', true]);

      edit(contractPath, (c) => { c.acceptance[1].expected_exit_code = 1; c.title = 'renamed'; });
      const diff = cli('diff', '--task-id', 'CLI', '--repo', repo);
      assert.equal(diff.status, 0);
      assert.deepEqual(
        [JSON.parse(diff.stdout).status, JSON.parse(diff.stdout).weakening, JSON.parse(diff.stdout).other],
        ['CHANGED', ['acceptance AC-02 expected exit code changed: 0 -> 1'], ['title changed']],
      );
      assert.match(diff.stderr, /Asks for less or allows more:\n {2}- acceptance AC-02 expected exit code changed: 0 -> 1\nOther changes:\n {2}- title changed/);

      const refused = cli('approve', contractPath, '--actor', 'seung');
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /CONTRACT_CHANGED_SINCE_APPROVAL[\s\S]*acceptance AC-02 expected exit code changed: 0 -> 1[\s\S]*--accept-changes/);
      const accepted = cli('approve', contractPath, '--actor', 'seung', '--accept-changes');
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.match(accepted.stderr, /This approval replaces an earlier approved copy of CLI\. Changes since then:/);
      assert.equal(JSON.parse(cli('diff', contractPath).stdout).status, 'MATCHES');
    } finally {
      remove(repo);
    }
  });

  it('diffContracts reports nothing for an approval that only changed who approved and when', () => {
    const a = { task_id: 'X', acceptance: [], scope: { allow: ['a'], protect: [] }, approval: { require_on: ['scope_change'], contract_approved: false } };
    const b = { ...a, approval: { require_on: ['scope_change'], contract_approved: true, contract_approved_by: 'seung', contract_approved_at: 'now', contract_approved_via: 'programmatic' } };
    assert.deepEqual(diffContracts(a, b), { changed: false, weakening: [], other: [] });
    assert.deepEqual(diffContracts(a, { ...b, approval: { ...b.approval, require_on: [] } }).other, ['approval changed']);
  });
});
