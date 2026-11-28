import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { initCheckpoint } from '../../scripts/checkpoint.mjs';
import { approveContractFile } from '../../scripts/contract.mjs';
import { initHost } from '../../scripts/init-host.mjs';
import { renderHostSkillMarkdown } from '../../scripts/install-skills.mjs';
import { runInterview } from '../../scripts/interview.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { CRAFTHELM_ROOT, getCheckpointPath } from '../../scripts/lib/paths.mjs';
import { describeSessionStatus } from '../../scripts/lib/scope-guard.mjs';
import { publishReviewPackage } from '../../scripts/review-package.mjs';
import { runVerify } from '../../scripts/verify.mjs';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const remove = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-defaults-'));
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['config', 'user.name', 'CraftHelm Test']);
  runGit(repo, ['config', 'user.email', 'test@crafthelm.local']);
  for (const [rel, content] of Object.entries({ 'src/app.mjs': 'export const val = 1;\n', 'README.md': '# Base\n', 'tests/e2e.mjs': 'process.exit(0);\n' })) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content, 'utf8');
  }
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-m', 'Base']);
  return repo;
}

function verifiedRun(repo, taskId, editorial) {
  const iv = runInterview({
    repo, taskId, request: `Change val for ${taskId}`, host: 'codex',
    inputData: {
      scope: { allow: ['src/**'], protect: [] },
      acceptance: [{ id: 'AC-01', requirement: 'REQ-01', kind: 'e2e', command: 'node tests/e2e.mjs' }],
      ...(editorial ? { editorial } : {}),
    },
  });
  approveContractFile(iv.contract_path, 'operator');
  const runId = `${taskId}-RUN`;
  initCheckpoint({ repo, contract: iv.contract_path, runId });
  fs.writeFileSync(path.join(repo, 'src', 'app.mjs'), `export const val = "${taskId}";\n`, 'utf8');
  runVerify({ repo, runId });
  return { runId, contract: readJson(iv.contract_path) };
}
const state = (repo, runId) => readJson(getCheckpointPath(repo, runId)).state;

describe('Lighter defaults: the editorial check is a gate only where the contract asks for it', () => {
  it('publishes without the Kouetsu copy by default, records that it did not run, and still blocks a contract that requires it', () => {
    const repo = makeRepo();
    try {
      const plain = verifiedRun(repo, 'PLAIN');
      assert.equal(plain.contract.editorial.require_kouetsu, false);
      // No Kouetsu at all: the package is still published, and the report says the check did not run.
      const published = publishReviewPackage({ repo, runId: plain.runId, noKouetsu: true });
      assert.deepEqual([published.ok, published.state, published.editorial_status], [true, 'READY_FOR_HUMAN_REVIEW', 'MISSING']);
      const report = readJson(path.join(repo, '.crafthelm', 'runs', plain.runId, 'reports', 'editorial-report.json'));
      assert.deepEqual([report.executed, report.status], [false, 'MISSING']);
      assert.equal(state(repo, plain.runId), 'READY_FOR_HUMAN_REVIEW');

      // With the bundled copy at hand the check runs and its result is recorded, as before.
      runGit(repo, ['add', '-A']);
      runGit(repo, ['commit', '-m', 'Plain work']);
      const checked = verifiedRun(repo, 'CHECKED');
      const withCopy = publishReviewPackage({ repo, runId: checked.runId, kouetsuRoot: path.join(CRAFTHELM_ROOT, 'hosts', 'codex', 'skills', 'kouetsu') });
      assert.deepEqual([withCopy.ok, withCopy.editorial_status], [true, 'PASS']);

      // A contract that asks for the gate gets it.
      runGit(repo, ['add', '-A']);
      runGit(repo, ['commit', '-m', 'Checked work']);
      const strict = verifiedRun(repo, 'GATED', { require_kouetsu: true });
      assert.equal(strict.contract.editorial.require_kouetsu, true);
      const blocked = publishReviewPackage({ repo, runId: strict.runId, noKouetsu: true });
      assert.deepEqual([blocked.ok, blocked.error_code], [false, 'KOUETSU_MISSING_BLOCKED']);
      assert.notEqual(state(repo, strict.runId), 'READY_FOR_HUMAN_REVIEW');
    } finally {
      remove(repo);
    }
  });
});

describe('Lighter defaults: the default path runs the whole suite and names fewer tools', () => {
  it('recommends verify without --selective, and writes full regression into a new project config', () => {
    const repo = makeRepo();
    try {
      const config = () => readJson(path.join(repo, '.crafthelm', 'config.json'));
      initHost({ repo, host: 'generic' });
      assert.deepEqual([config().verification_policy.regression_mode, config().verification_policy.require_kouetsu], ['full', false]);
      const { runId } = verifiedRun(repo, 'OPEN');
      const reminder = describeSessionStatus({ cwd: repo, event: 'UserPromptSubmit' });
      assert.match(reminder, new RegExp(`verify --repo ".*" --run-id ${runId}\\n`));
      assert.doesNotMatch(reminder, /--selective/);
    } finally {
      remove(repo);
    }
  });

  it('keeps routing, impact analysis and the optional gates out of the numbered steps of the skill', () => {
    for (const profile of ['claude', 'codex', 'antigravity', 'generic']) {
      const text = renderHostSkillMarkdown(profile, null);
      const steps = text.split('\n').filter((line) => /^\d\. \*\*/.test(line)).join('\n');
      assert.equal(steps.split('\n').length, 6, profile);
      assert.doesNotMatch(steps, /--selective|\broute\b|\bimpact\b|mutation|Waterfall/, profile);
      assert.match(steps, /verify --repo \. --run-id <RUN>`/, profile);
      assert.match(steps, /review --repo \.` to run in their own terminal/, profile);
      // They are still named once, as optional.
      const optional = text.split('\n').find((line) => line.startsWith('Optional, only when the task or contract calls for it:'));
      for (const word of ['`route`/`delegate`', '`verify --selective`', 'mutation probe', 'Waterfall stage approvals', '`editorial.require_kouetsu`']) assert.ok(optional.includes(word), `${profile}: ${word}`);
    }
  });
});
