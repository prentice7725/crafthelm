import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { calibrateLiteLimits } from '../../scripts/calibrate.mjs';
import { initCheckpoint } from '../../scripts/checkpoint.mjs';
import { approveContractFile } from '../../scripts/contract.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { readProfileObservations, summarizeCheckOutcome } from '../../scripts/lib/profile-observations.mjs';
import { getRunDir } from '../../scripts/lib/paths.mjs';
import { runVerify } from '../../scripts/verify.mjs';

function writeObservations(repo, runId, records) {
  const file = path.join(getRunDir(repo, runId), 'evidence', 'profile-observations.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify({ change_kind: 'bugfix', run_id: runId, evidence_strength: 'moderate', ...r })).join('\n') + '\n');
}

function round(i, overrides = {}) {
  return { target_snapshot_digest: `d${i}`, changed_source_files: 1, added_lines: 10, e2e: 'PASS', other_checks: 'ALL_PASS', ...overrides };
}

describe('Lite limit calibration from recorded verification rounds', () => {
  it('summarizes check outcomes the way calibration reads them', () => {
    assert.deepEqual(summarizeCheckOutcome([{ kind: 'unit', status: 'PASS' }, { kind: 'e2e', status: 'FAIL' }], false), { e2e: 'FAIL', other_checks: 'ALL_PASS' });
    assert.deepEqual(summarizeCheckOutcome([{ kind: 'unit', status: 'FAIL' }], true), { e2e: 'WAIVED', other_checks: 'SOME_FAILED' });
    assert.deepEqual(summarizeCheckOutcome([{ kind: 'e2e', status: 'NOT_APPLICABLE' }], false), { e2e: 'NOT_RUN', other_checks: 'NONE' });
  });

  it('reports insufficient data, then supports the default, then flags an E2E catch inside it', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-calib-'));
    try {
      const empty = calibrateLiteLimits({ repos: [repo] });
      assert.equal(empty.verdict, 'INSUFFICIENT_DATA');
      assert.equal(empty.suggested_limits, null);

      // 5 clean small bugfix runs; a repeated round on the same snapshot is not double-counted.
      for (let i = 0; i < 5; i++) writeObservations(repo, `R${i}`, [round(i), round(i)]);
      // Uninformative rounds: weak evidence, a failing unit check, a waived E2E, a feature.
      writeObservations(repo, 'W1', [round(90, { evidence_strength: 'weak', e2e: 'FAIL' })]);
      writeObservations(repo, 'W2', [round(91, { other_checks: 'SOME_FAILED', e2e: 'FAIL' })]);
      writeObservations(repo, 'W3', [round(92, { e2e: 'WAIVED' })]);
      writeObservations(repo, 'W4', [round(93, { change_kind: 'feature', e2e: 'FAIL' })]);

      const supported = calibrateLiteLimits({ repos: [repo], minSamples: 5 });
      assert.equal(supported.informative_rounds, 5);
      assert.equal(supported.bugfix_runs, 8);
      assert.equal(supported.current.e2e_catches, 0);
      assert.equal(supported.current.miss_rate_upper_95, 0.6);
      assert.equal(supported.verdict, 'DEFAULT_SUPPORTED');
      assert.deepEqual(
        [supported.suggested_limits.max_changed_source_files, supported.suggested_limits.max_added_lines],
        [10, 300],
      );

      // A bugfix at 2 files / 40 lines whose unit checks passed but E2E failed: lite would have shipped it.
      writeObservations(repo, 'CATCH', [
        round(50, { changed_source_files: 2, added_lines: 40, e2e: 'FAIL' }),
        round(51, { changed_source_files: 2, added_lines: 40 }),
      ]);
      const caught = calibrateLiteLimits({ repos: [repo], minSamples: 5 });
      assert.equal(caught.verdict, 'DEFAULT_TOO_LOOSE');
      assert.equal(caught.current.e2e_catches, 1);
      assert.deepEqual(caught.current.catch_examples, [`${path.basename(repo)}:CATCH`]);
      // Candidates that exclude the catch stay clean; the widest one is suggested.
      const tight = caught.candidates.find((c) => c.max_changed_source_files === 1 && c.max_added_lines === 300);
      assert.equal(tight.e2e_catches, 0);
      assert.deepEqual(
        [caught.suggested_limits.max_changed_source_files, caught.suggested_limits.max_added_lines],
        [1, 300],
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('verify appends one observation per round, so a failed round survives the repair', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-calib-verify-'));
    try {
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.name', 'CraftHelm Test']);
      runGit(repo, ['config', 'user.email', 'test@crafthelm.local']);
      const files = {
        'README.md': '# Calib\n',
        'src/range.mjs': 'export function inRange(x, lo, hi) {\n  return x > lo && x < hi;\n}\n',
        'tests/unit.test.mjs': "import assert from 'node:assert/strict'; import { inRange } from '../src/range.mjs'; assert.equal(inRange(2, 1, 3), true);\n",
        'tests/e2e.test.mjs': "import assert from 'node:assert/strict'; import { inRange } from '../src/range.mjs'; assert.equal(inRange(3, 1, 3), true);\n",
      };
      for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
        fs.writeFileSync(path.join(repo, rel), content, 'utf8');
      }
      runGit(repo, ['add', '.']);
      runGit(repo, ['commit', '-m', 'Baseline commit']);

      const contractPath = path.join(repo, '.crafthelm', 'contracts', 'CAL.json');
      fs.mkdirSync(path.dirname(contractPath), { recursive: true });
      fs.writeFileSync(contractPath, JSON.stringify({
        schema_version: '0.3',
        task_id: 'CAL',
        request: 'Make the upper bound inclusive',
        project_root: '.',
        host: 'generic',
        change_kind: 'bugfix',
        methodology: { lifecycle: 'incremental', specification: 'lightweight', engineering: 'tdd', execution: 'full' },
        scope: { allow: ['src/**'], protect: [] },
        approval: { contract_approved: false, require_on: ['scope_change'] },
        budgets: { max_worker_retries_per_cause: 3, max_lead_escalations: 3, max_wall_minutes: 30 },
        acceptance: [
          { id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node tests/unit.test.mjs', expected_exit_code: 0 },
          { id: 'AC-02', requirement: 'REQ-01', kind: 'e2e', command: 'node tests/e2e.test.mjs', expected_exit_code: 0 },
        ],
        source_policy: { authority: ['git-main'], source_refs: ['README.md'] },
      }, null, 2));
      approveContractFile(contractPath, 'operator');
      initCheckpoint({ repo, contract: contractPath, runId: 'CAL-RUN' });

      // Round 1: a wrong fix. The unit test passes, the E2E check catches it.
      fs.writeFileSync(path.join(repo, 'src/range.mjs'), 'export function inRange(x, lo, hi) {\n  return x >= lo && x < hi;\n}\n', 'utf8');
      assert.equal(runVerify({ repo, runId: 'CAL-RUN' }).technical_status, 'FAILED');
      // Round 2: the right fix.
      fs.writeFileSync(path.join(repo, 'src/range.mjs'), 'export function inRange(x, lo, hi) {\n  return x >= lo && x <= hi;\n}\n', 'utf8');
      assert.equal(runVerify({ repo, runId: 'CAL-RUN' }).technical_status, 'VERIFIED');

      const { records } = readProfileObservations(repo);
      assert.deepEqual(records.map((r) => [r.profile, r.e2e, r.other_checks, r.technical_status]), [
        ['full', 'FAIL', 'ALL_PASS', 'FAILED'],
        ['full', 'PASS', 'ALL_PASS', 'VERIFIED'],
      ]);
      assert.deepEqual(records.map((r) => [r.changed_source_files, r.added_lines]), [[1, 1], [1, 1]]);

      const report = calibrateLiteLimits({ repos: [repo], minSamples: 1 });
      assert.equal(report.current.e2e_catches, 1);
      assert.equal(report.verdict, 'DEFAULT_TOO_LOOSE');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
