import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { initCheckpoint } from '../../scripts/checkpoint.mjs';
import { approveContractFile } from '../../scripts/contract.mjs';
import { findAlteredEvidenceLogs, redactSecrets } from '../../scripts/lib/evidence-io.mjs';
import { assessEvidenceStrength } from '../../scripts/lib/evidence-strength.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { getEvidenceManifestPath, getRunDir } from '../../scripts/lib/paths.mjs';
import { detectTestWeakening } from '../../scripts/lib/test-weakening.mjs';
import { publishReviewPackage } from '../../scripts/review-package.mjs';
import { runVerify } from '../../scripts/verify.mjs';

const SRC = 'export function greet(name) { return `hi ${name}`; }\n';
const TEST = [
  "import assert from 'node:assert/strict';",
  "import { greet } from '../src/greet.mjs';",
  "assert.equal(greet('a'), 'hi a');",
  "assert.equal(greet('b'), 'hi b');",
  '',
].join('\n');

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-integrity-'));
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['config', 'user.name', 'CraftHelm Test']);
  runGit(repo, ['config', 'user.email', 'test@crafthelm.local']);
  for (const [rel, content] of Object.entries({ 'src/greet.mjs': SRC, 'tests/greet.test.mjs': TEST, 'tests/old.test.mjs': TEST })) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content, 'utf8');
  }
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-m', 'Baseline commit']);
  return repo;
}

function startRun(repo, taskId, runId, acceptance) {
  const contractPath = path.join(repo, '.crafthelm', 'contracts', `${taskId}.json`);
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(contractPath, JSON.stringify({
    schema_version: '0.3',
    task_id: taskId,
    request: 'Greet with hello instead of hi',
    project_root: '.',
    host: 'generic',
    change_kind: 'bugfix',
    methodology: { lifecycle: 'incremental', specification: 'sdd', engineering: 'tdd', execution: 'full' },
    scope: { allow: ['src/**', 'tests/**'], protect: [] },
    approval: { contract_approved: false, require_on: ['scope_change'] },
    budgets: { max_worker_retries_per_cause: 3, max_lead_escalations: 3, max_wall_minutes: 30 },
    acceptance,
    source_policy: { authority: ['git-main'], source_refs: ['README.md'] },
    verification_policy: { require_e2e_for_functional: false },
  }, null, 2));
  approveContractFile(contractPath, 'operator');
  initCheckpoint({ repo, contract: contractPath, runId });
}

describe('Test weakening: a suite made green by switching tests off', () => {
  it('reads deleted test files, skip markers and lost assertions from the diff of test files only', () => {
    const diffText = [
      'diff --git a/tests/a.test.mjs b/tests/a.test.mjs',
      '--- a/tests/a.test.mjs',
      '+++ b/tests/a.test.mjs',
      '@@ -1,4 +1,4 @@',
      "-it('rejects an expired token', () => {",
      "+it.skip('rejects an expired token', () => {",
      '-  assert.equal(check(old), false);',
      '-  assert.equal(check(fresh), true);',
      '+  assert.ok(true);',
      'diff --git a/tests/gone.test.mjs b/tests/gone.test.mjs',
      'deleted file mode 100644',
      '--- a/tests/gone.test.mjs',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-assert.equal(1, 1);',
      '-assert.equal(2, 2);',
      'diff --git a/src/skipper.mjs b/src/skipper.mjs',
      '--- a/src/skipper.mjs',
      '+++ b/src/skipper.mjs',
      '@@ -1,1 +1,1 @@',
      '-assert(ready);',
      '+queue.skip(1); it.skip(x);',
      '',
    ].join('\n');
    const res = detectTestWeakening({ diffText });
    assert.deepEqual(res.deleted_test_files, ['tests/gone.test.mjs']);
    assert.deepEqual(res.skip_markers.map((m) => m.file), ['tests/a.test.mjs']);
    assert.deepEqual(res.assertion_drops, [{ file: 'tests/a.test.mjs', removed: 2, added: 1 }]);

    // Adding assertions, or replacing them one for one, is not a drop.
    const neutral = detectTestWeakening({
      diffText: 'diff --git a/tests/a.test.mjs b/tests/a.test.mjs\n--- a/tests/a.test.mjs\n+++ b/tests/a.test.mjs\n@@ -1,1 +1,2 @@\n-assert.equal(a, 1);\n+assert.equal(a, 2);\n+assert.equal(b, 3);\n',
    });
    assert.deepEqual(neutral, { deleted_test_files: [], skip_markers: [], assertion_drops: [] });
  });

  it('grades a tests-only change as weak instead of not_applicable when the tests were weakened', () => {
    const base = {
      contract: { change_kind: 'bugfix' },
      checks: [{ kind: 'unit', status: 'PASS', command: 'node tests/a.test.mjs' }],
      impact: { test_candidates: ['tests/a.test.mjs'], selected_tests: [], fallback_to_full: false },
      changedFiles: ['tests/a.test.mjs'],
    };
    assert.equal(assessEvidenceStrength(base).level, 'not_applicable');

    const skipped = assessEvidenceStrength({
      ...base,
      diffText: "diff --git a/tests/a.test.mjs b/tests/a.test.mjs\n--- a/tests/a.test.mjs\n+++ b/tests/a.test.mjs\n@@ -1,1 +1,1 @@\n-it('works', () => {\n+it.skip('works', () => {\n",
    });
    assert.equal(skipped.level, 'weak');
    assert.deepEqual(skipped.signals.map((s) => [s.code, s.refs]), [['TEST_SKIP_ADDED', ['tests/a.test.mjs']]]);
  });

  it('flags the run when the agent leaves the code wrong and edits the tests to pass', () => {
    const repo = makeRepo();
    try {
      startRun(repo, 'WEAKEN', 'WEAKEN-RUN', [
        { id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node tests/greet.test.mjs', expected_exit_code: 0 },
      ]);
      // The request was never implemented. The test is hollowed out and another one is deleted.
      fs.writeFileSync(path.join(repo, 'tests/greet.test.mjs'), [
        "import assert from 'node:assert/strict';",
        "import { greet } from '../src/greet.mjs';",
        "assert.ok(greet('a'));",
        '',
      ].join('\n'), 'utf8');
      fs.rmSync(path.join(repo, 'tests/old.test.mjs'));

      const v = runVerify({ repo, runId: 'WEAKEN-RUN' });
      // The command still exits 0, so the check itself passes: the signals are what tell the reviewer.
      assert.equal(v.technical_status, 'VERIFIED');
      assert.equal(v.evidence_strength, 'weak');
      assert.deepEqual(v.evidence_strength_signals, ['TEST_FILE_DELETED', 'ASSERTIONS_REMOVED']);

      const manifest = JSON.parse(fs.readFileSync(getEvidenceManifestPath(repo, 'WEAKEN-RUN'), 'utf8'));
      const deleted = manifest.evidence_strength.signals.find((s) => s.code === 'TEST_FILE_DELETED');
      assert.deepEqual(deleted.refs, ['tests/old.test.mjs']);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('Evidence logs: hashed when written, checked before a human is asked', () => {
  it('blanks credential-like environment values and known token shapes, and counts them', () => {
    const env = { DEPLOY_TOKEN: 'tok-1234567890', SHORT_SECRET: 'abc', HOME: '/home/tok-1234567890-user' };
    const res = redactSecrets('auth tok-1234567890 ok\nkey AKIAABCDEFGHIJKLMNOP\nplain abc\n', env);
    assert.equal(res.text, 'auth [REDACTED:DEPLOY_TOKEN] ok\nkey [REDACTED:aws-access-key]\nplain abc\n');
    assert.equal(res.count, 2);
    assert.deepEqual(redactSecrets('nothing to hide', env), { text: 'nothing to hide', count: 0 });
  });

  it('records a hash per stored log, redacts secrets in it, and refuses to publish once a log is edited', () => {
    const repo = makeRepo();
    const previous = process.env.CRAFTHELM_FIXTURE_API_KEY;
    process.env.CRAFTHELM_FIXTURE_API_KEY = 'fixture-key-0123456789';
    try {
      startRun(repo, 'LOGS', 'LOGS-RUN', [
        { id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node tests/greet.test.mjs', expected_exit_code: 0 },
        { id: 'AC-02', requirement: 'REQ-01', kind: 'fast', command: 'node -p process.env.CRAFTHELM_FIXTURE_API_KEY', expected_exit_code: 0 },
      ]);
      fs.writeFileSync(path.join(repo, 'src/greet.mjs'), SRC.replace('hi', 'hi '), 'utf8');
      fs.writeFileSync(path.join(repo, 'tests/greet.test.mjs'), TEST.replaceAll("'hi ", "'hi  "), 'utf8');

      assert.equal(runVerify({ repo, runId: 'LOGS-RUN' }).ok, true);
      const runDir = getRunDir(repo, 'LOGS-RUN');
      const manifest = JSON.parse(fs.readFileSync(getEvidenceManifestPath(repo, 'LOGS-RUN'), 'utf8'));
      const [unit, leaky] = manifest.checks;
      assert.match(unit.stdout_sha256, /^[a-f0-9]{64}$/);
      assert.match(unit.stderr_sha256, /^[a-f0-9]{64}$/);
      assert.ok(!Number.isNaN(Date.parse(unit.started_at)));
      assert.equal(unit.redactions, undefined);
      assert.equal(leaky.redactions, 1);
      assert.equal(fs.readFileSync(path.join(runDir, leaky.stdout_file), 'utf8').trim(), '[REDACTED:CRAFTHELM_FIXTURE_API_KEY]');
      assert.deepEqual(findAlteredEvidenceLogs(runDir, manifest), []);

      // An agent rewriting the stored output after the fact.
      fs.appendFileSync(path.join(runDir, unit.stdout_file), 'all 12 tests passed\n', 'utf8');
      assert.deepEqual(findAlteredEvidenceLogs(runDir, manifest), [`AC-01: ${unit.stdout_file} changed after verification`]);
      const published = publishReviewPackage({ repo, runId: 'LOGS-RUN' });
      assert.equal(published.ok, false);
      assert.equal(published.error_code, 'EVIDENCE_LOG_ALTERED');

      // Verifying again rewrites the logs and their hashes.
      assert.equal(runVerify({ repo, runId: 'LOGS-RUN' }).ok, true);
      const fresh = JSON.parse(fs.readFileSync(getEvidenceManifestPath(repo, 'LOGS-RUN'), 'utf8'));
      assert.deepEqual(findAlteredEvidenceLogs(runDir, fresh), []);
    } finally {
      if (previous === undefined) delete process.env.CRAFTHELM_FIXTURE_API_KEY;
      else process.env.CRAFTHELM_FIXTURE_API_KEY = previous;
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
