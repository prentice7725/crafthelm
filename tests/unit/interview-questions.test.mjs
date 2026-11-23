import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runInterview } from '../../scripts/interview.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { COVERAGE_CATEGORIES, generateInterviewQuestions } from '../../scripts/lib/interview-questions.mjs';
import { recordDecision } from '../../scripts/lib/memory.mjs';

function createTempRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-interview-q-'));
  runGit(dir, ['init', '-b', 'main']);
  runGit(dir, ['config', 'user.name', 'CraftHelm Test']);
  runGit(dir, ['config', 'user.email', 'test@crafthelm.local']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'Initial test commit']);
  return dir;
}

const ids = (list) => list.map((q) => q.id);

describe('Deterministic Interview Question Generation', () => {
  it('raises change-kind, repo-signal, and request-risk questions without any model call', () => {
    const repo = createTempRepo({ 'README.md': '# Bare Repo\n', 'lib/core.py': 'x = 1\n' });
    try {
      const bugfix = generateInterviewQuestions({
        repoRoot: repo,
        requestText: 'Fix login token expiry and delete stale sessions',
        changeKind: 'bugfix',
      });
      const open = bugfix.questions.filter((q) => !q.answered);
      assert.deepEqual(
        ids(open).sort(),
        ['Q-ACCEPTANCE', 'Q-NO-TESTS', 'Q-REPRO', 'Q-RISK-DATA', 'Q-RISK-SECURITY', 'Q-SCOPE'].sort(),
      );
      // Default scope globs match nothing in this repo, so scope is a blocker, not an assumption.
      assert.equal(open.find((q) => q.id === 'Q-SCOPE').level, 'BLOCKER');
      assert.equal(bugfix.signals.test_file_count, 0);
      assert.deepEqual(Object.keys(bugfix.coverage), [...COVERAGE_CATEGORIES]);
      assert.equal(bugfix.coverage.security.status, 'unaddressed');
      // Nothing looked at compatibility: unaddressed, not silently fine.
      assert.equal(bugfix.coverage.compatibility.status, 'unaddressed');
      assert.match(bugfix.coverage.compatibility.basis, /no question was raised/);

      const refactor = generateInterviewQuestions({ repoRoot: repo, requestText: 'Split the core module into two files', changeKind: 'refactor' });
      assert.ok(ids(refactor.questions).includes('Q-BASELINE'));
      assert.ok(!ids(refactor.questions).includes('Q-REPRO'));

      const docs = generateInterviewQuestions({ repoRoot: repo, requestText: 'Typo', changeKind: 'docs' });
      assert.ok(!ids(docs.questions).includes('Q-ACCEPTANCE'));
      assert.ok(ids(docs.questions).includes('Q-VAGUE-REQUEST'));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('marks questions answered from supplied input, answers, and declared coverage basis', () => {
    const repo = createTempRepo({
      'README.md': '# Repo\n',
      'src/auth.mjs': 'export const ttl = 1;\n',
      'tests/auth.test.mjs': 'process.exit(0);\n',
    });
    try {
      const res = generateInterviewQuestions({
        repoRoot: repo,
        requestText: 'Fix login token expiry comparison in the auth module',
        changeKind: 'bugfix',
        input: {
          scope: { allow: ['src/auth.mjs'] },
          acceptance: [{ id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node tests/auth.test.mjs' }],
          reproduction: 'Token with exp == now is accepted; expected rejection.',
          uncertainties: [{ id: 'Q-RISK-SECURITY', level: 'BLOCKER', question: 'x', answer: 'Only the comparison operator changes.' }],
          uncertainty_coverage: {
            data: { basis: 'No persistence code under src/auth.mjs (README.md).' },
            compatibility: { basis: 'Function signature unchanged.' },
          },
        },
      });
      assert.deepEqual(res.questions.filter((q) => !q.answered), []);
      for (const category of COVERAGE_CATEGORIES) {
        assert.equal(res.coverage[category].status, 'addressed', category);
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('stays advisory by default, and blocks on generated questions and unexamined categories in strict mode', () => {
    const repo = createTempRepo({
      'README.md': '# Repo\n',
      'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node tests/a.test.mjs' } }, null, 2),
      'src/a.mjs': 'export const a = 1;\n',
      'tests/a.test.mjs': 'process.exit(0);\n',
    });
    try {
      const advisory = runInterview({ repo, request: 'Fix password reset token reuse bug', changeKind: 'bugfix', host: 'generic' });
      assert.equal(advisory.ok, true);
      assert.equal(advisory.strict_interview, false);
      assert.ok(ids(advisory.generated_questions).includes('Q-REPRO'));
      assert.ok(ids(advisory.generated_questions).includes('Q-RISK-SECURITY'));
      const qDoc = fs.readFileSync(path.join(repo, 'docs', 'tasks', advisory.task_id, 'interview_questions.md'), 'utf8');
      assert.match(qDoc, /\| Q-REPRO \| acceptance \| BLOCKER \| 미답변 \|/);
      assert.match(qDoc, /\| security \| unaddressed \|/);

      const strict = runInterview({ repo, request: 'Fix password reset token reuse bug', changeKind: 'bugfix', host: 'generic', strictInterview: true });
      assert.equal(strict.ok, false);
      assert.equal(strict.status, 'INTERVIEW_REQUIRED');
      const blockerIds = ids(strict.unresolved_blockers);
      for (const expected of ['Q-ACCEPTANCE', 'Q-REPRO', 'Q-RISK-SECURITY', 'U-COVERAGE-DATA', 'U-COVERAGE-COMPATIBILITY']) {
        assert.ok(blockerIds.includes(expected), `missing ${expected} in ${blockerIds.join(', ')}`);
      }
      assert.deepEqual(strict.artifacts_written, []);

      // Repo config enables strict mode; a fully answered input passes it.
      fs.mkdirSync(path.join(repo, '.crafthelm'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.crafthelm', 'config.json'), JSON.stringify({ interview: { strict: true } }), 'utf8');
      const answered = runInterview({
        repo,
        request: 'Fix password reset token reuse bug',
        changeKind: 'bugfix',
        host: 'generic',
        inputData: {
          scope: { allow: ['src/**'], protect: [] },
          acceptance: [
            { id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node tests/a.test.mjs' },
            { id: 'AC-02', requirement: 'REQ-01', kind: 'e2e', command: 'node tests/a.test.mjs' },
          ],
          reproduction: 'Reset token accepted twice; expected single use.',
          uncertainties: [{ id: 'Q-RISK-SECURITY', level: 'BLOCKER', question: 'x', answer: 'Token must be single-use; nothing else changes.' }],
          uncertainty_coverage: {
            data: { basis: 'No schema or stored data change (src/a.mjs only).' },
            compatibility: { basis: 'No exported signature change.' },
          },
        },
      });
      assert.equal(answered.ok, true, JSON.stringify(answered.unresolved_blockers));
      assert.equal(answered.strict_interview, true);
      assert.deepEqual(answered.generated_questions, []);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('asks about recorded decisions that overlap the request', () => {
    const repo = createTempRepo({ 'README.md': '# Repo\n', 'src/a.mjs': 'export const a = 1;\n', 'tests/a.test.mjs': 'process.exit(0);\n' });
    try {
      const dec = recordDecision({ repo, title: 'Rotate refresh tokens on every use', body: 'Single-use rotation.' });
      const iv = runInterview({ repo, request: 'Allow refresh tokens to be reused for 5 minutes', host: 'generic' });
      assert.equal(iv.ok, true);
      const decisionQuestion = iv.generated_questions.find((q) => q.id.startsWith('Q-DECISION-'));
      assert.ok(decisionQuestion, JSON.stringify(ids(iv.generated_questions)));
      assert.match(decisionQuestion.question, /Rotate refresh tokens on every use/);
      assert.ok(dec);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
