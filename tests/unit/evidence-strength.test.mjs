import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { initCheckpoint } from '../../scripts/checkpoint.mjs';
import { approveContractFile } from '../../scripts/contract.mjs';
import { assessEvidenceStrength } from '../../scripts/lib/evidence-strength.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { getEvidenceManifestPath, getReviewPackagePath } from '../../scripts/lib/paths.mjs';
import { publishReviewPackage } from '../../scripts/review-package.mjs';
import { runVerify } from '../../scripts/verify.mjs';

const pass = (kind, command = 'cmd') => ({ kind, status: 'PASS', command });
const codes = (res) => res.signals.map((s) => s.code);

function makeRepo(files) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-strength-'));
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['config', 'user.name', 'CraftHelm Test']);
  runGit(repo, ['config', 'user.email', 'test@crafthelm.local']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-m', 'Baseline commit']);
  return repo;
}

function writeContract(repo, taskId, acceptance) {
  const contractPath = path.join(repo, '.crafthelm', 'contracts', `${taskId}.json`);
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(contractPath, JSON.stringify({
    schema_version: '0.3',
    task_id: taskId,
    request: 'Change the greeting',
    project_root: '.',
    host: 'generic',
    change_kind: 'feature',
    methodology: { lifecycle: 'incremental', specification: 'sdd', engineering: 'tdd', execution: 'full' },
    scope: { allow: ['src/**', 'tests/**'], protect: [] },
    approval: { contract_approved: false, require_on: ['scope_change'] },
    budgets: { max_worker_retries_per_cause: 3, max_lead_escalations: 3, max_wall_minutes: 30 },
    acceptance,
    source_policy: { authority: ['git-main'], source_refs: ['README.md'] },
    verification_policy: { require_e2e_for_functional: false },
  }, null, 2));
  approveContractFile(contractPath, 'operator');
  return contractPath;
}

describe('Evidence Strength Grading', () => {
  it('grades strong when tailored checks pass and a changed test reaches the changed code', () => {
    const res = assessEvidenceStrength({
      contract: { change_kind: 'feature' },
      checks: [pass('unit'), pass('e2e')],
      impact: { test_candidates: ['tests/a.test.mjs'], selected_tests: [{ file: 'tests/a.test.mjs' }], fallback_to_full: false },
      changedFiles: ['src/a.mjs', 'tests/a.test.mjs'],
    });
    assert.equal(res.level, 'strong');
    assert.deepEqual(res.signals, []);
    assert.deepEqual(res.changed_source_files, ['src/a.mjs']);
  });

  it('grades weak when no test reaches the change or only one umbrella check ran', () => {
    const unreached = assessEvidenceStrength({
      contract: { change_kind: 'bugfix' },
      checks: [pass('unit'), pass('e2e')],
      impact: { test_candidates: ['tests/other.test.mjs'], selected_tests: [], fallback_to_full: false },
      changedFiles: ['src/a.mjs'],
    });
    assert.equal(unreached.level, 'weak');
    assert.deepEqual(codes(unreached), ['NO_TEST_REACHES_CHANGE', 'NO_TEST_CHANGED']);

    const generic = assessEvidenceStrength({
      contract: { change_kind: 'refactor' },
      checks: [pass('test', 'npm test')],
      impact: { test_candidates: ['tests/a.test.mjs'], selected_tests: [{ file: 'tests/a.test.mjs' }], fallback_to_full: false },
      changedFiles: ['src/a.mjs'],
    });
    assert.equal(generic.level, 'weak');
    assert.deepEqual(codes(generic), ['SINGLE_GENERIC_CHECK']);

    const nothingRan = assessEvidenceStrength({
      contract: { change_kind: 'feature' },
      checks: [{ kind: 'manual', status: 'UNVERIFIED' }],
      impact: { test_candidates: [], selected_tests: [], fallback_to_full: false },
      changedFiles: ['src/a.mjs'],
    });
    assert.ok(codes(nothingRan).includes('NO_EXECUTED_PASSING_CHECK'));
  });

  it('grades moderate, not weak, when reach is merely unknown or no test changed', () => {
    const inconclusive = assessEvidenceStrength({
      contract: { change_kind: 'refactor' },
      checks: [pass('unit'), pass('e2e')],
      impact: { test_candidates: ['tests/a.test.mjs'], selected_tests: [], fallback_to_full: true, fallback_reason: 'config changed' },
      changedFiles: ['src/a.mjs'],
    });
    assert.equal(inconclusive.level, 'moderate');
    assert.deepEqual(codes(inconclusive), ['IMPACT_INCONCLUSIVE']);
    assert.match(inconclusive.signals[0].detail, /config changed/);
  });

  it('does not grade documentation or test-only changes', () => {
    const docs = assessEvidenceStrength({
      contract: { change_kind: 'docs' },
      checks: [],
      impact: { test_candidates: [], selected_tests: [] },
      changedFiles: ['README.md'],
    });
    assert.equal(docs.level, 'not_applicable');

    const testOnly = assessEvidenceStrength({
      contract: { change_kind: 'feature' },
      checks: [pass('unit')],
      impact: { test_candidates: ['tests/a.test.mjs'], selected_tests: [] },
      changedFiles: ['tests/a.test.mjs', 'docs/notes.md'],
    });
    assert.equal(testOnly.level, 'not_applicable');
  });

  it('records the grade in the manifest and surfaces weak evidence in the review package without failing verification', () => {
    const repo = makeRepo({
      'README.md': '# Strength Demo\n',
      'src/greet.mjs': "export const greet = () => 'hi';\n",
      'src/unused.mjs': 'export const unused = 1;\n',
      'tests/unused.test.mjs': "import assert from 'node:assert/strict'; import { unused } from '../src/unused.mjs'; assert.equal(unused, 1);\n",
    });
    try {
      const contractPath = writeContract(repo, 'STR-WEAK', [
        { id: 'AC-01', requirement: 'REQ-01', kind: 'test', command: 'node tests/unused.test.mjs', expected_exit_code: 0 },
      ]);
      initCheckpoint({ repo, contract: contractPath, runId: 'STR-WEAK-RUN' });
      fs.writeFileSync(path.join(repo, 'src/greet.mjs'), "export const greet = () => 'hello';\n", 'utf8');

      const v = runVerify({ repo, runId: 'STR-WEAK-RUN' });
      assert.equal(v.ok, true);
      assert.equal(v.technical_status, 'VERIFIED');
      assert.equal(v.evidence_strength, 'weak');
      assert.ok(v.evidence_strength_signals.includes('NO_TEST_REACHES_CHANGE'));
      assert.ok(v.evidence_strength_signals.includes('SINGLE_GENERIC_CHECK'));

      const manifest = JSON.parse(fs.readFileSync(getEvidenceManifestPath(repo, 'STR-WEAK-RUN'), 'utf8'));
      assert.equal(manifest.evidence_strength.level, 'weak');
      assert.deepEqual(manifest.evidence_strength.changed_source_files, ['src/greet.mjs']);

      const pkg = publishReviewPackage({ repo, runId: 'STR-WEAK-RUN' });
      assert.equal(pkg.state, 'READY_FOR_HUMAN_REVIEW');
      const report = fs.readFileSync(getReviewPackagePath(repo, 'STR-WEAK-RUN'), 'utf8');
      assert.match(report, /증거 강도 \| \*\*약함 \(EVIDENCE_WEAK\)\*\*/);
      assert.match(report, /증거 강도 신호 \(NO_TEST_REACHES_CHANGE\)/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
