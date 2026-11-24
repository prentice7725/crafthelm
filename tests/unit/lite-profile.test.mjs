import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { initCheckpoint } from '../../scripts/checkpoint.mjs';
import { approveContractFile, checkContractReadiness } from '../../scripts/contract.mjs';
import { runInterview } from '../../scripts/interview.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { evaluateLiteProfile } from '../../scripts/lib/lite-profile.mjs';
import { getReviewPackagePath, getRunDir } from '../../scripts/lib/paths.mjs';
import { publishReviewPackage } from '../../scripts/review-package.mjs';
import { runVerify } from '../../scripts/verify.mjs';

const FIXED = 'export function inRange(x, lo, hi) {\n  return x >= lo && x <= hi;\n}\n';
const REACHING_TEST = "import assert from 'node:assert/strict'; import { inRange } from '../src/range.mjs'; assert.equal(inRange(1, 1, 3), true);\n";
const BOUNDARY_TEST = "import assert from 'node:assert/strict'; import { inRange } from '../src/range.mjs'; assert.equal(inRange(1, 1, 3), true); assert.equal(inRange(3, 1, 3), true);\n";
const UNRELATED_TEST = "import assert from 'node:assert/strict'; import { other } from '../src/other.mjs'; assert.equal(other, 1);\n";

function makeRepo({ withReachingTest = true, reachingTest = REACHING_TEST } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-lite-'));
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['config', 'user.name', 'CraftHelm Test']);
  runGit(repo, ['config', 'user.email', 'test@crafthelm.local']);
  const files = {
    'README.md': '# Lite Demo\n',
    'src/range.mjs': 'export function inRange(x, lo, hi) {\n  return x > lo && x < hi;\n}\n',
    'src/other.mjs': 'export const other = 1;\n',
    ...(withReachingTest ? { 'tests/range.test.mjs': reachingTest } : {}),
    'tests/other.test.mjs': UNRELATED_TEST,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content, 'utf8');
  }
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-m', 'Baseline commit']);
  return repo;
}

function startRun(repo, taskId, overrides = {}) {
  const contractPath = path.join(repo, '.crafthelm', 'contracts', `${taskId}.json`);
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  const contract = {
    schema_version: '0.3',
    task_id: taskId,
    request: 'Make inRange bounds inclusive',
    project_root: '.',
    host: 'generic',
    change_kind: 'bugfix',
    process_profile: 'lite',
    methodology: { lifecycle: 'incremental', specification: 'lightweight', engineering: 'tdd', execution: 'full' },
    scope: { allow: ['src/**'], protect: [] },
    approval: { contract_approved: false, require_on: ['scope_change'] },
    budgets: { max_worker_retries_per_cause: 3, max_lead_escalations: 3, max_wall_minutes: 30 },
    acceptance: [{ id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node tests/range.test.mjs', expected_exit_code: 0 }],
    source_policy: { authority: ['git-main'], source_refs: ['README.md'] },
    ...overrides,
  };
  if (contract.process_profile === undefined) delete contract.process_profile;
  fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2));
  const readiness = checkContractReadiness(contract);
  approveContractFile(contractPath, 'operator');
  initCheckpoint({ repo, contract: contractPath, runId: `${taskId}-RUN` });
  fs.writeFileSync(path.join(repo, 'src/range.mjs'), FIXED, 'utf8');
  return { runId: `${taskId}-RUN`, readiness };
}

describe('Lite Profile: conditional E2E exemption for small bugfixes', () => {
  it('waives E2E for a small bugfix whose tailored test reaches the change, and says so to the reviewer', () => {
    const repo = makeRepo();
    try {
      const { runId, readiness } = startRun(repo, 'LITE-OK');
      assert.equal(readiness.policy_ready, true);

      const v = runVerify({ repo, runId });
      assert.equal(v.ok, true);
      // The waived check is reported as unverified, never as passed.
      assert.equal(v.technical_status, 'PARTIAL');
      assert.equal(v.process_profile.e2e_exempted, true);
      assert.deepEqual(v.process_profile.observed, { change_kind: 'bugfix', changed_source_files: 1, added_lines: 1, evidence_strength: 'moderate' });
      assert.ok(!v.failure_reasons.some((r) => r.includes('E2E_MISSING')));

      assert.equal(publishReviewPackage({ repo, runId }).state, 'READY_FOR_HUMAN_REVIEW');
      const report = fs.readFileSync(getReviewPackagePath(repo, runId), 'utf8');
      assert.match(report, /절차 프로필 \| \*\*경량 \(lite\)\*\* — E2E 요구 면제 적용/);
      assert.match(report, /경량 프로필로 E2E 실행 검증을 면제함/);
      assert.match(report, /E2E smoke not executed \(waived by lite profile\)/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('fails with LITE_PROFILE_EXCEEDED when the diff outgrows the limits', () => {
    const repo = makeRepo();
    try {
      const { runId } = startRun(repo, 'LITE-BIG', { verification_policy: { lite_max_added_lines: 1 } });
      fs.writeFileSync(
        path.join(repo, 'src/range.mjs'),
        'export function inRange(x, lo, hi) {\n  const low = x >= lo;\n  const high = x <= hi;\n  return low && high;\n}\n',
        'utf8',
      );
      const v = runVerify({ repo, runId });
      assert.equal(v.ok, false);
      assert.equal(v.technical_status, 'FAILED');
      assert.equal(v.process_profile.e2e_exempted, false);
      assert.ok(v.failure_reasons.some((r) => /LITE_PROFILE_EXCEEDED: 3 source lines added, limit is 1/.test(r)), v.failure_reasons.join(' | '));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('fails when no tailored test reaches the change (weak evidence cannot buy the exemption)', () => {
    // The repo has no test that imports the changed module.
    const repo = makeRepo({ withReachingTest: false });
    try {
      const { runId } = startRun(repo, 'LITE-WEAK', {
        acceptance: [{ id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node tests/other.test.mjs', expected_exit_code: 0 }],
      });
      const v = runVerify({ repo, runId });
      assert.equal(v.ok, false);
      assert.ok(v.failure_reasons.some((r) => /LITE_PROFILE_EXCEEDED: .*evidence strength is weak \(NO_TEST_REACHES_CHANGE\)/.test(r)), v.failure_reasons.join(' | '));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('revokes the exemption when the mutation probe shows the tailored test does not pin the change', () => {
    // The test reaches the changed line but never checks the upper bound, so `<=` -> `<` survives.
    const repo = makeRepo();
    try {
      const { runId } = startRun(repo, 'LITE-MUT-WEAK', { verification_policy: { mutation_probe: true } });
      const v = runVerify({ repo, runId });
      assert.equal(v.mutation_probe.status, 'PROBED');
      assert.equal(v.mutation_probe.survived, 1);
      assert.equal(v.ok, false);
      assert.equal(v.technical_status, 'FAILED');
      assert.equal(v.process_profile.e2e_exempted, false);
      assert.equal(v.process_profile.observed.evidence_strength, 'weak');
      assert.ok(v.failure_reasons.some((r) => /LITE_PROFILE_EXCEEDED: .*evidence strength is weak \(.*MUTANTS_SURVIVED.*\)/.test(r)), v.failure_reasons.join(' | '));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps the exemption when every mutant is killed', () => {
    const repo = makeRepo({ reachingTest: BOUNDARY_TEST });
    try {
      const { runId } = startRun(repo, 'LITE-MUT-STRONG', { verification_policy: { mutation_probe: true } });
      const v = runVerify({ repo, runId });
      assert.deepEqual([v.mutation_probe.status, v.mutation_probe.killed, v.mutation_probe.survived], ['PROBED', 1, 0]);
      assert.equal(v.ok, true);
      assert.equal(v.technical_status, 'PARTIAL');
      assert.equal(v.process_profile.e2e_exempted, true);
      assert.equal(fs.readFileSync(path.join(repo, 'src/range.mjs'), 'utf8'), FIXED);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('skips the mutation probe when the run fails for a reason the probe cannot change', () => {
    const repo = makeRepo({ reachingTest: BOUNDARY_TEST });
    const probeOf = (runId) => JSON.parse(fs.readFileSync(path.join(getRunDir(repo, runId), 'evidence', 'mutation-probe.json'), 'utf8'));
    try {
      // Full profile without any E2E check: E2E_MISSING is settled before the probe would run.
      const missing = startRun(repo, 'MUT-E2E-MISSING', { process_profile: undefined, verification_policy: { mutation_probe: true } });
      const v1 = runVerify({ repo, runId: missing.runId });
      assert.equal(v1.technical_status, 'FAILED');
      assert.deepEqual([probeOf(missing.runId).status, probeOf(missing.runId).reason], ['SKIPPED', 'verification already failed (E2E_MISSING)']);

      // A lite run with unresolved review findings fails whatever the probe finds.
      const reviewed = startRun(repo, 'MUT-REVIEW', { verification_policy: { mutation_probe: true } });
      fs.mkdirSync(path.join(getRunDir(repo, reviewed.runId), 'evidence'), { recursive: true });
      fs.writeFileSync(path.join(getRunDir(repo, reviewed.runId), 'evidence', 'review.json'), JSON.stringify({ status: 'FINDINGS' }), 'utf8');
      const v2 = runVerify({ repo, runId: reviewed.runId });
      assert.equal(v2.technical_status, 'FAILED');
      assert.deepEqual([probeOf(reviewed.runId).status, probeOf(reviewed.runId).reason], ['SKIPPED', 'verification already failed (REVIEW_FINDINGS)']);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps V01 for everything else: feature contracts cannot use lite, and full bugfixes still need E2E', () => {
    const repo = makeRepo();
    try {
      const feature = startRun(repo, 'LITE-FEATURE', { change_kind: 'feature' });
      assert.equal(feature.readiness.policy_ready, false);
      assert.deepEqual(feature.readiness.warnings.map((w) => w.code), ['LITE_PROFILE_NOT_ELIGIBLE', 'E2E_MISSING']);
      const vFeature = runVerify({ repo, runId: feature.runId });
      assert.equal(vFeature.ok, false);
      assert.ok(vFeature.failure_reasons.some((r) => /LITE_PROFILE_EXCEEDED: change_kind "feature" is not eligible/.test(r)));

      const full = startRun(repo, 'FULL-BUGFIX', { process_profile: undefined });
      assert.deepEqual(full.readiness.warnings.map((w) => w.code), ['E2E_MISSING']);
      const vFull = runVerify({ repo, runId: full.runId });
      assert.equal(vFull.ok, false);
      assert.equal(vFull.process_profile.profile, 'full');
      assert.ok(vFull.failure_reasons.some((r) => r.startsWith('E2E_MISSING')));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('is requested through the interview and does not relax anything when an E2E check is present', () => {
    const repo = makeRepo();
    try {
      const iv = runInterview({
        repo,
        request: 'Make inRange bounds inclusive in the range module',
        host: 'generic',
        changeKind: 'bugfix',
        processProfile: 'lite',
        inputData: {
          scope: { allow: ['src/**'], protect: [] },
          acceptance: [{ id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node tests/range.test.mjs' }],
        },
      });
      assert.equal(iv.ok, true);
      assert.equal(iv.policy_ready, true);
      assert.deepEqual(iv.next_questions, []);
      assert.equal(JSON.parse(fs.readFileSync(iv.contract_path, 'utf8')).process_profile, 'lite');

      const notEligible = runInterview({ repo, request: 'Add a new export to the range module', host: 'generic', changeKind: 'feature', processProfile: 'lite' });
      assert.ok(notEligible.warnings.some((w) => w.code === 'LITE_PROFILE_NOT_ELIGIBLE'));

      const withE2e = evaluateLiteProfile({
        contract: { change_kind: 'bugfix' },
        strength: { level: 'strong', signals: [], changed_source_files: ['src/range.mjs'] },
        diffText: '',
      });
      assert.equal(withE2e.profile, 'full');
      assert.equal(withE2e.eligible, false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
