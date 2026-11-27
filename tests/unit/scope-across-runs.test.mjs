import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { acquireWriterLock, initCheckpoint } from '../../scripts/checkpoint.mjs';
import { approveContractFile } from '../../scripts/contract.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { getCheckpointPath, getRunDir } from '../../scripts/lib/paths.mjs';
import { evaluateWrite, listActiveScopes, writableScopes } from '../../scripts/lib/scope-guard.mjs';
import { runVerify } from '../../scripts/verify.mjs';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const remove = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
const write = (repo, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text, 'utf8');
};

function makeRepo(files) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-across-'));
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['config', 'user.name', 'CraftHelm Test']);
  runGit(repo, ['config', 'user.email', 'test@crafthelm.local']);
  for (const [rel, content] of Object.entries({ 'README.md': '# Base\n', ...files })) write(repo, rel, content);
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-m', 'Base']);
  return repo;
}

function openRun(repo, taskId, scope, acceptance, extra = {}) {
  const contractPath = path.join(repo, '.crafthelm', 'contracts', `${taskId}.json`);
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(contractPath, JSON.stringify({
    schema_version: '0.3',
    task_id: taskId,
    request: `Work for ${taskId}`,
    project_root: '.',
    host: 'generic',
    change_kind: 'refactor',
    methodology: { lifecycle: 'incremental', specification: 'lightweight', engineering: 'test_after', execution: 'full' },
    scope,
    approval: { contract_approved: false, require_on: ['scope_change'] },
    budgets: { max_worker_retries_per_cause: 3, max_lead_escalations: 3, max_wall_minutes: 30 },
    acceptance: acceptance ?? [{ id: 'AC-01', requirement: 'REQ-01', kind: 'e2e', command: 'node --version', expected_exit_code: 0 }],
    source_policy: { authority: ['git-main'], source_refs: ['README.md'] },
    ...extra,
  }, null, 2));
  approveContractFile(contractPath, 'operator');
  initCheckpoint({ repo, contract: contractPath, runId: `${taskId}-RUN` });
  return `${taskId}-RUN`;
}

const setState = (repo, runId, state) => {
  const file = getCheckpointPath(repo, runId);
  fs.writeFileSync(file, JSON.stringify({ ...readJson(file), state }, null, 2));
};

describe('Scope guard: a run waiting on a person does not lock the run in progress', () => {
  it('applies the scope of the run being worked on, and of the lock holder when there is one', () => {
    const repo = makeRepo({ 'schemas/overrides.schema.json': '{}\n', 'src/app.mjs': 'export const v = 1;\n' });
    try {
      // An earlier contract protected schemas/ and is now waiting for its decision.
      const front = openRun(repo, 'FRONT', { allow: ['src/**'], protect: ['schemas/**'] });
      setState(repo, front, 'READY_FOR_HUMAN_REVIEW');
      const guard = (rel) => evaluateWrite({ filePath: path.join(repo, rel), cwd: repo, isIgnored: () => false });

      // With nothing in progress the waiting run still applies.
      assert.deepEqual([guard('schemas/overrides.schema.json').code, guard('src/app.mjs').code], ['PROTECTED_PATH', 'IN_SCOPE']);

      // The run in progress allows schemas/: the waiting run's protect no longer stops it.
      const review = openRun(repo, 'REVIEW', { allow: ['schemas/**'], protect: ['docs/**'] });
      assert.deepEqual(writableScopes(repo, listActiveScopes(repo)).map((s) => s.run_id), [review]);
      assert.equal(guard('schemas/overrides.schema.json').code, 'IN_SCOPE');
      // Its own protect and its own scope still hold, and the waiting run's allow grants nothing.
      assert.equal(guard('docs/guide.md').code, 'PROTECTED_PATH');
      const outside = guard('src/app.mjs');
      assert.equal(outside.code, 'OUT_OF_SCOPE');
      assert.match(outside.reason, /of the active run REVIEW-RUN\./);

      // Two runs in progress: the one holding the writer lock is the one writing.
      const other = openRun(repo, 'OTHER', { allow: ['src/**'], protect: ['schemas/**'] });
      assert.equal(guard('schemas/overrides.schema.json').code, 'PROTECTED_PATH');
      acquireWriterLock({ repo, runId: review, writer: 'agent-1' });
      assert.deepEqual(writableScopes(repo, listActiveScopes(repo)).map((s) => s.run_id), [review]);
      assert.deepEqual([guard('schemas/overrides.schema.json').code, guard('src/app.mjs').code], ['IN_SCOPE', 'OUT_OF_SCOPE']);
      assert.ok(other);
    } finally {
      remove(repo);
    }
  });
});

describe('Selective regression: a check is skipped only when it has a pass to carry over', () => {
  const files = {
    'schemas/book.schema.json': '{"type":"object"}\n',
    'src/auth.mjs': 'export const login = () => "v1";\n',
    'src/billing.mjs': 'export const invoice = (x) => x * 10;\n',
    'tests/auth.test.mjs': "import { login } from '../src/auth.mjs'; if (typeof login() !== 'string') process.exit(1);\n",
    'tests/billing.test.mjs': "import { invoice } from '../src/billing.mjs'; if (invoice(2) !== 20) process.exit(1);\n",
    'tests/schema.test.mjs': "import fs from 'node:fs'; if (JSON.parse(fs.readFileSync(new URL('../schemas/book.schema.json', import.meta.url), 'utf8')).type !== 'object') process.exit(1);\n",
  };
  const acceptance = [
    { id: 'AC-AUTH', requirement: 'REQ-01', kind: 'unit', command: 'node tests/auth.test.mjs', expected_exit_code: 0 },
    { id: 'AC-BILLING', requirement: 'REQ-02', kind: 'unit', command: 'node tests/billing.test.mjs', expected_exit_code: 0 },
    { id: 'AC-SCHEMA', requirement: 'REQ-03', kind: 'unit', command: 'node tests/schema.test.mjs', expected_exit_code: 0 },
  ];
  const statuses = (repo, runId) => Object.fromEntries(readJson(path.join(getRunDir(repo, runId), 'evidence-manifest.json')).checks.map((c) => [c.id, [c.status, c.selection_reason]]));

  it('runs a check that never passed in this run, then skips it once it has', () => {
    const repo = makeRepo(files);
    try {
      const runId = openRun(repo, 'SEL', { allow: ['src/**', 'schemas/**'], protect: [] }, acceptance);
      write(repo, 'src/auth.mjs', 'export const login = () => "v2";\n');
      const first = runVerify({ repo, runId, selective: true });
      assert.deepEqual([first.regression_selection.mode, first.regression_selection.executed_count, first.regression_selection.skipped_count], ['selective', 3, 0]);
      assert.deepEqual(statuses(repo, runId)['AC-BILLING'], ['PASS', 'no_earlier_pass_in_this_run']);
      assert.deepEqual(statuses(repo, runId)['AC-SCHEMA'], ['PASS', 'no_earlier_pass_in_this_run']);

      write(repo, 'src/auth.mjs', 'export const login = () => "v3";\n');
      const second = runVerify({ repo, runId, selective: true });
      assert.deepEqual([second.regression_selection.executed_count, second.regression_selection.skipped_count], [1, 2]);
      assert.equal(statuses(repo, runId)['AC-BILLING'][0], 'SKIPPED_UNIMPACTED');
    } finally {
      remove(repo);
    }
  });

  it('runs everything when a data file changed: nothing links a schema to the test that loads it', () => {
    const repo = makeRepo(files);
    try {
      const runId = openRun(repo, 'DATA', { allow: ['src/**', 'schemas/**'], protect: [] }, acceptance);
      write(repo, 'src/auth.mjs', 'export const login = () => "v2";\n');
      runVerify({ repo, runId, selective: true });

      // Every check has a pass now. A broken schema must still reach the schema test.
      write(repo, 'schemas/book.schema.json', '{"type":"array"}\n');
      const v = runVerify({ repo, runId, selective: true });
      assert.deepEqual([v.regression_selection.mode, v.regression_selection.skipped_count], ['fallback_to_full', 0]);
      assert.equal(statuses(repo, runId)['AC-SCHEMA'][0], 'FAIL');
      assert.equal(v.technical_status, 'FAILED');
    } finally {
      remove(repo);
    }
  });
});

describe('Scope across runs: a file in another run\'s scope is still reported, and named as such', () => {
  it('fails with SCOPE_VIOLATION and says which open run the file belongs to', () => {
    const repo = makeRepo({ 'src/a/one.mjs': 'export const a = 1;\n', 'src/b/two.mjs': 'export const b = 1;\n' });
    try {
      const first = openRun(repo, 'A', { allow: ['src/a/**'], protect: [] });
      write(repo, 'src/a/one.mjs', 'export const a = 2;\n');
      assert.equal(runVerify({ repo, runId: first }).scope_status, 'PASS');

      // The next contract changes its own files; the first run is verified again afterwards.
      const second = openRun(repo, 'B', { allow: ['src/b/**'], protect: [] });
      write(repo, 'src/b/two.mjs', 'export const b = 2;\n');
      write(repo, 'notes.txt', 'stray\n');
      const again = runVerify({ repo, runId: first });
      assert.equal(again.scope_status, 'FAIL');
      // The violation line stays a plain file list; the note is a line of its own.
      assert.ok(again.failure_reasons.includes('SCOPE_VIOLATION: Out-of-scope file changes: notes.txt, src/b/two.mjs'));
      assert.ok(again.failure_reasons.includes("SCOPE_NOTE: The files are inside the scope of other open runs: B-RUN: src/b/two.mjs. If that work changed them after this run's baseline, this run cannot pass on this tree: decide it before the next run starts, or close it."));
      assert.ok(second);
    } finally {
      remove(repo);
    }
  });
});
