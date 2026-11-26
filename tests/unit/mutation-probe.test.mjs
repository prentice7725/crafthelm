import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { initCheckpoint } from '../../scripts/checkpoint.mjs';
import { approveContractFile } from '../../scripts/contract.mjs';
import { sha256Text } from '../../scripts/lib/crypto.mjs';
import { computeSnapshotDigest, getDiffText, runGit } from '../../scripts/lib/git.mjs';
import { maskNonCode, parseAddedLines, planMutants, recoverInterruptedProbe, runMutationProbe } from '../../scripts/lib/mutation-probe.mjs';
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

  it('masks string literals and trailing comments so their operators are never mutated', () => {
    // Length is preserved and quotes stay, so columns in the masked line map onto the original.
    assert.equal(maskNonCode('if (a >= b) log("a >= b"); // a <= b', 'x.js'), 'if (a >= b) log("      "); //       ');
    assert.equal(maskNonCode("x = 'a == b' if ok else y  # true", 'm.py'), "x = '      ' if ok else y  #     ");
    assert.equal(maskNonCode('const s = `a && b` && c;', 'x.ts'), 'const s = `      ` && c;');
    assert.equal(maskNonCode('const q = "say \\"a < b\\"" + n;', 'x.js'), 'const q = "             " + n;');
    assert.equal(maskNonCode('a /* x == y */ == b', 'x.c'), 'a /*        */ == b');
    // Code, not comments or strings: a JS private field, a Rust lifetime, an unclosed quote.
    assert.equal(maskNonCode('return this.#n >= 0;', 'x.js'), 'return this.#n >= 0;');
    assert.equal(maskNonCode("fn f<'a>(x: &'a str) -> bool { x.len() >= 1 }", 'x.rs'), "fn f<'a>(x: &'a str) -> bool { x.len() >= 1 }");
    assert.equal(maskNonCode("if c == '=' { n >= 1 }", 'x.rs'), "if c == ' ' { n >= 1 }");
    assert.equal(maskNonCode('const t = "unterminated >= x', 'x.js'), 'const t = "unterminated >= x');

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-mask-'));
    try {
      fs.mkdirSync(path.join(repo, 'src'));
      fs.writeFileSync(path.join(repo, 'src/msg.mjs'), [
        'export function label(n) {',
        '  if (n === 0) return "n === 0 is true";',
        '  return "only a string: a >= b"; // and a comment: x <= y',
        '}',
        '',
      ].join('\n'), 'utf8');
      const diffText = [
        'diff --git a/src/msg.mjs b/src/msg.mjs',
        '--- /dev/null',
        '+++ b/src/msg.mjs',
        '@@ -0,0 +1,4 @@',
        '+export function label(n) {',
        '+  if (n === 0) return "n === 0 is true";',
        '+  return "only a string: a >= b"; // and a comment: x <= y',
        '+}',
        '',
      ].join('\n');
      const planned = planMutants({ repoRoot: repo, diffText, sourceFiles: ['src/msg.mjs'] });
      // Line 2 is mutated in the code, not in the string. Line 3 has no operator outside string and
      // comment, so it is probed by removing the statement instead.
      assert.deepEqual(planned.map((m) => [m.line, m.operator, m.column]), [[2, 'eq_strict_flip', 8], [3, 'line_delete', 2]]);
      assert.equal(planned[0].mutated, 'if (n !== 0) return "n === 0 is true";');
      assert.equal(planned[1].mutated, '(line removed)');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('removes a whole statement only where the file still loads without it', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-delete-'));
    const plan = (file, lines) => {
      fs.writeFileSync(path.join(repo, file), `${lines.join('\n')}\n`, 'utf8');
      const diffText = [`diff --git a/${file} b/${file}`, '--- /dev/null', `+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), ''].join('\n');
      return planMutants({ repoRoot: repo, diffText, sourceFiles: [file], maxMutants: 50 }).map((m) => [m.line, m.operator, m.mutated]);
    };
    try {
      assert.deepEqual(plan('audit.mjs', [
        'export const LIMIT = 3;',
        'export function record(log, entry) {',
        '  log.push(entry);',
        '  notify(entry, {',
        '    urgent: entry.level,',
        '  });',
        "  'use strict';",
        '  return log',
        '  if (log.length > LIMIT) log.shift();',
        '}',
      ]), [
        // The operator flip comes first; exports, open or closing brackets, string-only statements
        // and lines without a terminating semicolon are left alone.
        [9, 'gt_to_gte', 'if (log.length >= LIMIT) log.shift();'],
        [3, 'line_delete', '(line removed)'],
      ]);
      assert.deepEqual(plan('audit.py', [
        'def record(log, entry):',
        '    """Append and notify."""',
        '    log.append(entry)',
        '    notify(entry,',
        '           urgent=1)',
        '    return log  # the caller chains on it',
      ]), [
        [3, 'line_delete', 'pass'],
        [6, 'line_delete', 'pass'],
      ]);
      // A compiled language gets no statement removal: a missing return is a build error, not a caught bug.
      assert.deepEqual(plan('audit.go', ['func record(log []string) []string {', '\treturn log;', '}']), []);
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
      const journalFile = path.join(journalDir, 'mutation-journal.json');
      const MUTATED = NEW_SRC.replace('>=', '>');
      const writeJournal = (fields) => fs.writeFileSync(journalFile, JSON.stringify({
        file: 'src/price.mjs',
        original_sha256: sha256Text(NEW_SRC),
        mutated_sha256: sha256Text(MUTATED),
        original_base64: Buffer.from(NEW_SRC, 'utf8').toString('base64'),
        ...fields,
      }), 'utf8');
      const rejected = () => fs.readdirSync(journalDir).filter((f) => f.startsWith('mutation-journal.rejected-'));

      writeJournal({});
      fs.writeFileSync(abs, MUTATED, 'utf8');
      assert.deepEqual(recoverInterruptedProbe(repo, journalDir), { recovered: true, file: 'src/price.mjs', restored_sha256: sha256Text(NEW_SRC) });
      assert.equal(fs.readFileSync(abs, 'utf8'), NEW_SRC);
      assert.deepEqual(recoverInterruptedProbe(repo, journalDir), { recovered: false });

      // Edited since the probe: the user's newer content is kept, the journal is set aside.
      writeJournal({});
      const EDITED = `${NEW_SRC}export const extra = 1;\n`;
      fs.writeFileSync(abs, EDITED, 'utf8');
      assert.equal(recoverInterruptedProbe(repo, journalDir).problem, 'FILE_CHANGED_SINCE_PROBE');
      assert.equal(fs.readFileSync(abs, 'utf8'), EDITED);
      assert.equal(fs.existsSync(journalFile), false);

      // A journal pointing outside the repository, or into .crafthelm/, never writes anything.
      const outside = path.join(path.dirname(repo), `outside-${path.basename(repo)}.txt`);
      for (const target of [path.relative(repo, outside), '.crafthelm/contracts/MUT-OFF.json']) {
        writeJournal({ file: target });
        assert.equal(recoverInterruptedProbe(repo, journalDir).problem, 'JOURNAL_PATH_REJECTED');
      }
      assert.equal(fs.existsSync(outside), false);

      // A truncated journal is reported and moved aside instead of throwing.
      fs.writeFileSync(journalFile, '{"file":"src/price.mjs","orig', 'utf8');
      assert.equal(recoverInterruptedProbe(repo, journalDir).problem, 'JOURNAL_CORRUPT');
      assert.equal(rejected().length, 4);
      assert.deepEqual(recoverInterruptedProbe(repo, journalDir), { recovered: false });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
