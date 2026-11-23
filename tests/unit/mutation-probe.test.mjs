import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { initCheckpoint } from '../../scripts/checkpoint.mjs';
import { approveContractFile } from '../../scripts/contract.mjs';
import { computeSnapshotDigest, getDiffText, runGit } from '../../scripts/lib/git.mjs';
import { parseAddedLines, planMutants, recoverInterruptedProbe, runMutationProbe } from '../../scripts/lib/mutation-probe.mjs';
import { getEvidenceManifestPath, getReviewPackagePath, getRunDir } from '../../scripts/lib/paths.mjs';
import { publishReviewPackage } from '../../scripts/review-package.mjs';
import { runVerify } from '../../scripts/verify.mjs';

const BASE_SRC = 'export function discount(total, isMember) {\n  return total;\n}\n';
const NEW_SRC = [
  'export function discount(total, isMember) {',
  '  // members get 10 off orders of 100 or more',
  '  if (isMember && total >= 100) {',
  '    return total - 10;',
  '  }',
  '  return total;',
  '}',
  '',
].join('\n');

// Pins every branch: boundary, membership, and the amount.
const STRONG_TEST = [
  "import assert from 'node:assert/strict';",
  "import { discount } from '../src/price.mjs';",
  'assert.equal(discount(100, true), 90);',
  'assert.equal(discount(99, true), 99);',
  'assert.equal(discount(100, false), 100);',
  'assert.equal(discount(200, true), 190);',
  '',
].join('\n');

// Only checks a non-member below the threshold: none of the new logic is constrained.
const WEAK_TEST = [
  "import assert from 'node:assert/strict';",
  "import { discount } from '../src/price.mjs';",
  'assert.equal(discount(50, false), 50);',
  '',
].join('\n');

function makeRepo(testSource) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-mutation-'));
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['config', 'user.name', 'CraftHelm Test']);
  runGit(repo, ['config', 'user.email', 'test@crafthelm.local']);
  const files = { 'README.md': '# Mutation Demo\n', 'src/price.mjs': BASE_SRC, 'tests/price.test.mjs': testSource };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content, 'utf8');
  }
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-m', 'Baseline commit']);
  return repo;
}

function startRun(repo, taskId, runId, policy = {}) {
  const contractPath = path.join(repo, '.crafthelm', 'contracts', `${taskId}.json`);
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(contractPath, JSON.stringify({
    schema_version: '0.3',
    task_id: taskId,
    request: 'Members get 10 off orders of 100 or more',
    project_root: '.',
    host: 'generic',
    change_kind: 'feature',
    methodology: { lifecycle: 'incremental', specification: 'sdd', engineering: 'tdd', execution: 'full' },
    scope: { allow: ['src/**'], protect: [] },
    approval: { contract_approved: false, require_on: ['scope_change'] },
    budgets: { max_worker_retries_per_cause: 3, max_lead_escalations: 3, max_wall_minutes: 30 },
    acceptance: [
      { id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node tests/price.test.mjs', expected_exit_code: 0 },
      { id: 'AC-02', requirement: 'REQ-01', kind: 'e2e', command: 'node tests/price.test.mjs', expected_exit_code: 0 },
    ],
    source_policy: { authority: ['git-main'], source_refs: ['README.md'] },
    verification_policy: policy,
  }, null, 2));
  approveContractFile(contractPath, 'operator');
  initCheckpoint({ repo, contract: contractPath, runId });
  fs.writeFileSync(path.join(repo, 'src/price.mjs'), NEW_SRC, 'utf8');
}

describe('Mutation Probe: do the passing checks actually constrain the change?', () => {
  it('parses added lines and plans mutants only on changed, non-comment source lines', () => {
    const repo = makeRepo(STRONG_TEST);
    try {
      fs.writeFileSync(path.join(repo, 'src/price.mjs'), NEW_SRC, 'utf8');
      const diffText = getDiffText(repo, 'HEAD');
      assert.deepEqual(parseAddedLines(diffText).get('src/price.mjs'), [2, 3, 4, 5]);

      const planned = planMutants({ repoRoot: repo, diffText, sourceFiles: ['src/price.mjs'] });
      assert.deepEqual(
        planned.map((m) => [m.line, m.operator]),
        [[3, 'gte_to_gt'], [4, 'minus_to_plus']],
      );
      assert.equal(planned[0].mutated, 'if (isMember && total > 100) {');
      // Files outside the requested source set are never planned.
      assert.deepEqual(planMutants({ repoRoot: repo, diffText, sourceFiles: [] }), []);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('kills every mutant under a thorough test and leaves the working tree byte-identical', () => {
    const repo = makeRepo(STRONG_TEST);
    try {
      startRun(repo, 'MUT-STRONG', 'MUT-STRONG-RUN');
      const before = computeSnapshotDigest(repo);
      const v = runVerify({ repo, runId: 'MUT-STRONG-RUN', mutationProbe: true });
      assert.equal(v.ok, true);
      assert.deepEqual(
        { status: v.mutation_probe.status, total: v.mutation_probe.total, killed: v.mutation_probe.killed, survived: v.mutation_probe.survived },
        { status: 'PROBED', total: 2, killed: 2, survived: 0 },
      );
      assert.ok(!v.evidence_strength_signals.includes('MUTANTS_SURVIVED'));
      assert.equal(fs.readFileSync(path.join(repo, 'src/price.mjs'), 'utf8'), NEW_SRC);
      assert.equal(computeSnapshotDigest(repo), before);
      assert.equal(v.target_snapshot_digest, before);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reports surviving mutants as weak evidence without failing verification, and shows them to the reviewer', () => {
    const repo = makeRepo(WEAK_TEST);
    try {
      startRun(repo, 'MUT-WEAK', 'MUT-WEAK-RUN', { mutation_probe: true });
      // Enabled by the contract policy, no flag needed.
      const v = runVerify({ repo, runId: 'MUT-WEAK-RUN' });
      assert.equal(v.ok, true);
      assert.equal(v.technical_status, 'VERIFIED');
      assert.equal(v.mutation_probe.survived, 2);
      assert.equal(v.evidence_strength, 'weak');
      assert.ok(v.evidence_strength_signals.includes('MUTANTS_SURVIVED'));

      const manifest = JSON.parse(fs.readFileSync(getEvidenceManifestPath(repo, 'MUT-WEAK-RUN'), 'utf8'));
      const signal = manifest.evidence_strength.signals.find((s) => s.code === 'MUTANTS_SURVIVED');
      assert.equal(signal.weight, 'weak');
      assert.match(signal.detail, /src\/price\.mjs:3 \(gte_to_gt\)/);

      const evidence = JSON.parse(fs.readFileSync(path.join(getRunDir(repo, 'MUT-WEAK-RUN'), 'evidence', 'mutation-probe.json'), 'utf8'));
      assert.ok(evidence.mutants.every((m) => m.killed === false && m.killed_by === null));

      assert.equal(publishReviewPackage({ repo, runId: 'MUT-WEAK-RUN' }).state, 'READY_FOR_HUMAN_REVIEW');
      const report = fs.readFileSync(getReviewPackagePath(repo, 'MUT-WEAK-RUN'), 'utf8');
      assert.match(report, /\| Mutation Probe \| .* \| PROBED \(제거 0\/2, 생존 2\) \| `\.\.\/evidence\/mutation-probe\.json` \|/);
      assert.match(report, /증거 강도 신호 \(MUTANTS_SURVIVED\)/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('is off by default, skips when nothing can be re-run, and repairs a tree left mutated by a crash', () => {
    const repo = makeRepo(STRONG_TEST);
    try {
      startRun(repo, 'MUT-OFF', 'MUT-OFF-RUN');
      const v = runVerify({ repo, runId: 'MUT-OFF-RUN' });
      assert.equal(v.mutation_probe.status, 'NOT_REQUESTED');

      const journalDir = path.join(getRunDir(repo, 'MUT-OFF-RUN'), 'evidence');
      const diffText = getDiffText(repo, 'HEAD');
      const noCommands = runMutationProbe({ repoRoot: repo, journalDir, diffText, sourceFiles: ['src/price.mjs'], commands: [] });
      assert.equal(noCommands.status, 'SKIPPED');

      // Simulate a crash mid-probe: file mutated on disk, journal still present.
      const abs = path.join(repo, 'src/price.mjs');
      fs.writeFileSync(
        path.join(journalDir, 'mutation-journal.json'),
        JSON.stringify({ file: 'src/price.mjs', original_base64: Buffer.from(NEW_SRC, 'utf8').toString('base64') }),
        'utf8',
      );
      fs.writeFileSync(abs, NEW_SRC.replace('>=', '>'), 'utf8');
      assert.deepEqual(recoverInterruptedProbe(repo, journalDir), { recovered: true, file: 'src/price.mjs' });
      assert.equal(fs.readFileSync(abs, 'utf8'), NEW_SRC);
      assert.deepEqual(recoverInterruptedProbe(repo, journalDir), { recovered: false });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
