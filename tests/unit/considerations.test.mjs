import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { initCheckpoint } from '../../scripts/checkpoint.mjs';
import { approveContractFile } from '../../scripts/contract.mjs';
import { addConsideration, readConsiderations } from '../../scripts/lib/considerations.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { CRAFTHELM_ROOT, getCheckpointPath, getRunDir } from '../../scripts/lib/paths.mjs';
import { describeSessionStatus, evaluateWrite } from '../../scripts/lib/scope-guard.mjs';
import { buildReviewData } from '../../scripts/review.mjs';
import { publishReviewPackage } from '../../scripts/review-package.mjs';
import { runVerify } from '../../scripts/verify.mjs';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const remove = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
const KOUETSU = path.join(CRAFTHELM_ROOT, 'hosts', 'codex', 'skills', 'kouetsu');

function repoWithRun() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-consider-'));
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['config', 'user.name', 'CraftHelm Test']);
  runGit(repo, ['config', 'user.email', 'test@crafthelm.local']);
  for (const [rel, content] of Object.entries({ 'src/app.mjs': 'export const val = 1;\n', 'README.md': '# Base\n' })) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content, 'utf8');
  }
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-m', 'Base']);
  const contractPath = path.join(repo, '.crafthelm', 'contracts', 'EDIT.json');
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(contractPath, JSON.stringify({
    schema_version: '0.3', task_id: 'EDIT', request: 'Let a value be edited', project_root: '.', host: 'codex', change_kind: 'refactor',
    methodology: { lifecycle: 'incremental', specification: 'lightweight', engineering: 'test_after', execution: 'full' },
    scope: { allow: ['src/**'], protect: [] },
    approval: { contract_approved: false, require_on: ['scope_change'] },
    budgets: { max_worker_retries_per_cause: 3, max_lead_escalations: 3, max_wall_minutes: 30 },
    acceptance: [{ id: 'AC-01', requirement: 'REQ-01', kind: 'e2e', command: 'node --version', expected_exit_code: 0 }],
    source_policy: { authority: ['git-main'], source_refs: ['README.md'] },
  }, null, 2));
  approveContractFile(contractPath, 'operator');
  initCheckpoint({ repo, contract: contractPath, runId: 'EDIT-RUN' });
  return repo;
}

describe('Considerations: a place for what looked needed and was not built', () => {
  it('keeps one-line notes for the reviewer, refuses a design in place of a note, and reads what a file tool wrote', () => {
    const repo = repoWithRun();
    try {
      assert.throws(() => addConsideration(repo, 'NOPE', { note: 'x' }), /RUN_NOT_FOUND/);
      assert.throws(() => addConsideration(repo, 'EDIT-RUN', { note: '   ' }), /needs --note/);
      assert.throws(() => addConsideration(repo, 'EDIT-RUN', { note: 'a'.repeat(301) }), /CONSIDERATION_TOO_LONG: the note is 301 characters; keep it to one line of at most 300\. A consideration names the concern, it does not design the answer\./);

      const first = addConsideration(repo, 'EDIT-RUN', { note: 'Editing overwrites the old value;\n  no history is kept', why: 'not asked for' });
      assert.deepEqual([first.count, first.consideration.note, first.consideration.why], [1, 'Editing overwrites the old value; no history is kept', 'not asked for']);
      // The same note twice is one note.
      assert.deepEqual([addConsideration(repo, 'EDIT-RUN', { note: 'Editing overwrites the old value; no history is kept' }).already_recorded, readConsiderations(repo, 'EDIT-RUN').length], [true, 1]);
      addConsideration(repo, 'EDIT-RUN', { note: 'Two people editing at once: last write wins' });

      // The run's inbox is the agent's to write, so the file may also arrive without the command.
      const file = path.join(getRunDir(repo, 'EDIT-RUN'), 'inbox', 'considerations.jsonl');
      assert.equal(evaluateWrite({ filePath: file, cwd: repo }).decision, 'allow');
      fs.appendFileSync(file, `not json\n{"other":"no note"}\n${JSON.stringify({ note: `${'long '.repeat(100)}`, why: 7 })}\n`);
      const read = readConsiderations(repo, 'EDIT-RUN');
      assert.deepEqual(read.map((c) => c.note.slice(0, 22)), ['Editing overwrites the', 'Two people editing at ', 'long long long long lo']);
      assert.deepEqual([read[2].note.length, read[2].recorded_at, read[2].why], [300, null, '7']);

      // Recording a note changes nothing about the run.
      assert.equal(readJson(getCheckpointPath(repo, 'EDIT-RUN')).state, 'READY');
    } finally {
      remove(repo);
    }
  });

  it('stops at thirty: that many open concerns is a question about the task', () => {
    const repo = repoWithRun();
    try {
      for (let i = 1; i <= 30; i += 1) addConsideration(repo, 'EDIT-RUN', { note: `concern ${i}` });
      assert.throws(() => addConsideration(repo, 'EDIT-RUN', { note: 'concern 31' }), /CONSIDERATION_LIMIT: this run already has 30 considerations/);
    } finally {
      remove(repo);
    }
  });

  it('is recorded from the command line, told to the agent with the open run, and shown to the reviewer as a remark', () => {
    const repo = repoWithRun();
    try {
      const reminder = describeSessionStatus({ cwd: repo, event: 'UserPromptSubmit' });
      assert.match(reminder, /Something looks needed that the contract does not ask for\? Do not build it and do not widen the contract: leave one line for the reviewer with node ".*" checkpoint consider --repo ".*" --run-id EDIT-RUN --note "<what, in one line>"\./);

      const cli = (...args) => spawnSync(process.execPath, [path.join(CRAFTHELM_ROOT, 'scripts', 'crafthelm.mjs'), 'checkpoint', 'consider', '--repo', repo, '--run-id', 'EDIT-RUN', ...args], { cwd: repo, encoding: 'utf8' });
      const added = cli('--note', 'Deleting a value is not covered', '--why', 'the request only says edit');
      assert.equal(added.status, 0, added.stderr);
      assert.equal(JSON.parse(added.stdout).count, 1);
      const empty = cli();
      assert.equal(empty.status, 1);
      assert.match(empty.stderr, /checkpoint consider needs --note/);

      fs.writeFileSync(path.join(repo, 'src', 'app.mjs'), 'export const val = 2;\n', 'utf8');
      runVerify({ repo, runId: 'EDIT-RUN' });
      publishReviewPackage({ repo, runId: 'EDIT-RUN', kouetsuRoot: KOUETSU });
      const shown = buildReviewData({ repo }).groups[0].runs[0];
      assert.deepEqual(shown.considerations.map((c) => [c.note, c.why]), [['Deleting a value is not covered', 'the request only says edit']]);
      // A note left after verification does not make the run unacceptable: it is not evidence.
      addConsideration(repo, 'EDIT-RUN', { note: 'Added after verification' });
      const later = buildReviewData({ repo }).groups[0].runs[0];
      assert.deepEqual([later.acceptable, later.considerations.length], [true, 2]);
      // Once the run waits on a person, the reminder no longer invites more work on it.
      assert.doesNotMatch(describeSessionStatus({ cwd: repo, event: 'UserPromptSubmit' }), /Something looks needed/);
    } finally {
      remove(repo);
    }
  });
});
