import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { initCheckpoint } from '../../scripts/checkpoint.mjs';
import { runDoctor } from '../../scripts/doctor.mjs';
import { initHost } from '../../scripts/init-host.mjs';
import { getSkillsInstallStatus, installSkills } from '../../scripts/install-skills.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { CRAFTHELM_ROOT, getCheckpointPath, getRunDir } from '../../scripts/lib/paths.mjs';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const remove = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
const MANIFEST = '.crafthelm-skill-install.json';

function claudeRunner(cmd, args) {
  if (cmd === 'git') return { exitCode: 0, stdout: 'git version 2.54.0', stderr: '' };
  if (cmd === 'claude' && args[0] === '--version') return { exitCode: 0, stdout: '2.1.311 (Claude Code)\n', stderr: '' };
  if (cmd === 'claude' && args[0] === '--help') return { exitCode: 0, stdout: '--agents --output-format --print --model --permission-mode', stderr: '' };
  throw new Error(`Unexpected command: ${cmd}`);
}
const claudeResolve = (cmd) => ({ found: cmd === 'claude' || cmd === 'git', path: cmd, kind: 'exe' });

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-managed-'));
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['config', 'user.name', 'CraftHelm Test']);
  runGit(repo, ['config', 'user.email', 'test@crafthelm.local']);
  for (const [rel, content] of Object.entries({ 'src/app.mjs': 'export const val = 1;\n', 'README.md': '# Base\n' })) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content, 'utf8');
  }
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-m', 'Base']);
  return repo;
}

function writeContract(repo, taskId) {
  const contractPath = path.join(repo, '.crafthelm', 'contracts', `${taskId}.json`);
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(contractPath, JSON.stringify({
    schema_version: '0.3',
    task_id: taskId,
    request: 'Set val to 2',
    project_root: '.',
    host: 'generic',
    change_kind: 'refactor',
    methodology: { lifecycle: 'incremental', specification: 'lightweight', engineering: 'test_after', execution: 'full' },
    scope: { allow: ['src/**'], protect: [] },
    approval: { contract_approved: false, require_on: ['scope_change'] },
    budgets: { max_worker_retries_per_cause: 3, max_lead_escalations: 3, max_wall_minutes: 30 },
    acceptance: [{ id: 'AC-01', requirement: 'REQ-01', kind: 'e2e', command: 'node --version', expected_exit_code: 0 }],
    source_policy: { authority: ['git-main'], source_refs: ['README.md'] },
  }, null, 2));
  return contractPath;
}

describe('Project skill copy: what init-host writes stays up to date', () => {
  it('marks the copy as managed, so install-skills and a later init-host update it', () => {
    const repo = makeRepo();
    try {
      const skillDir = path.join(repo, '.claude', 'skills', 'crafthelm');
      const skillMd = path.join(skillDir, 'SKILL.md');
      const first = initHost({ repo, host: 'claude' });
      assert.ok(first.written.includes(path.join(skillDir, MANIFEST)));
      assert.deepEqual(
        [readJson(path.join(skillDir, MANIFEST)).managed_by, readJson(path.join(skillDir, MANIFEST)).scope],
        ['crafthelm', 'project'],
      );
      const status = () => getSkillsInstallStatus({ targets: 'claude', scope: 'project', repoRoot: repo }).targets[0].status;
      assert.equal(status(), 'INSTALLED');

      // The checkout moved on: the copy is older than what would be written now.
      const current = fs.readFileSync(skillMd, 'utf8');
      fs.writeFileSync(skillMd, current.replace('Workflow Gate Sequence', 'Old Gate Sequence'), 'utf8');
      assert.equal(status(), 'OUTDATED');
      assert.equal(installSkills({ targets: 'claude', scope: 'project', repoRoot: repo }).results[0].action, 'UPDATED');
      assert.equal(fs.readFileSync(skillMd, 'utf8'), current);

      // Running init-host again does the same, without --force.
      fs.writeFileSync(skillMd, 'old', 'utf8');
      const again = initHost({ repo, host: 'claude' });
      assert.ok(again.written.includes(skillMd));
      assert.equal(fs.readFileSync(skillMd, 'utf8'), current);
    } finally {
      remove(repo);
    }
  });

  it('leaves a copy without a manifest alone, and doctor says that nothing updates it', () => {
    const repo = makeRepo();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-managed-home-'));
    try {
      const skillDir = path.join(repo, '.claude', 'skills', 'crafthelm');
      const skillMd = path.join(skillDir, 'SKILL.md');
      initHost({ repo, host: 'claude' });
      installSkills({ targets: 'claude', scope: 'user', homeDir });
      const doctor = () => runDoctor({ host: 'claude', homeDir, repo, runner: claudeRunner, resolve: claudeResolve });
      const codes = (report) => report.warnings.map((w) => w.code);

      // The shape an older init-host left behind: the files, no manifest. Same content: nothing to say.
      fs.rmSync(path.join(skillDir, MANIFEST));
      assert.ok(!codes(doctor()).includes('CLAUDE_SKILL_UNMANAGED'));

      // The checkout moved on. Neither install-skills nor init-host touches the copy.
      fs.writeFileSync(skillMd, 'old procedure', 'utf8');
      const skippedInstall = installSkills({ targets: 'claude', scope: 'project', repoRoot: repo }).results[0];
      assert.equal(skippedInstall.action, 'SKIPPED_UNMANAGED');
      assert.match(skippedInstall.reason, /init-host wrote before it recorded a manifest/);
      assert.ok(initHost({ repo, host: 'claude' }).skipped.includes(skillMd));
      assert.equal(fs.readFileSync(skillMd, 'utf8'), 'old procedure');

      const report = doctor();
      assert.equal(report.ok, true);
      const warning = report.warnings.find((w) => w.code === 'CLAUDE_SKILL_UNMANAGED');
      assert.match(warning.detail, /has no install manifest, so install-skills does not update it; a project copy is read in place of the user copy/);
      // The fix runs from the target repository: the dispatcher by its full path, the repository named.
      assert.ok(warning.fix.startsWith(`node "${path.join(CRAFTHELM_ROOT, 'scripts', 'crafthelm.mjs').replace(/\\/g, '/')}" install-skills --targets claude --scope project --repo "${repo}" --force`));
      assert.deepEqual(report.hosts.claude.skill_copies.map((c) => [c.scope, c.status, c.differs]), [['user', 'INSTALLED', undefined], ['project', 'UNMANAGED', true]]);

      // --force replaces it and from then on it is managed.
      assert.equal(installSkills({ targets: 'claude', scope: 'project', repoRoot: repo, force: true }).results[0].action, 'OVERWRITTEN');
      assert.ok(!codes(doctor()).includes('CLAUDE_SKILL_UNMANAGED'));
      assert.equal(installSkills({ targets: 'claude', scope: 'project', repoRoot: repo }).results[0].action, 'UPDATED');
    } finally {
      remove(repo);
      remove(homeDir);
    }
  });

  it('keeps the host wording a shared .agents copy was written with', () => {
    const repo = makeRepo();
    try {
      initHost({ repo, host: 'antigravity' });
      const skillDir = path.join(repo, '.agents', 'skills', 'crafthelm');
      const written = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
      assert.equal(readJson(path.join(skillDir, MANIFEST)).host_profile, 'antigravity');

      // The `agents` target would otherwise write the generic wording over it.
      const status = getSkillsInstallStatus({ targets: 'agents', scope: 'project', repoRoot: repo }).targets[0];
      assert.deepEqual([status.status, status.host_profile], ['INSTALLED', 'antigravity']);
      const updated = installSkills({ targets: 'agents', scope: 'project', repoRoot: repo }).results[0];
      assert.deepEqual([updated.action, updated.host_profile], ['UPDATED', 'antigravity']);
      assert.equal(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), written);

      // --force is the way to change it.
      const forced = installSkills({ targets: 'agents', scope: 'project', repoRoot: repo, force: true }).results[0];
      assert.equal(forced.host_profile, 'generic');
      assert.notEqual(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), written);
    } finally {
      remove(repo);
    }
  });
});

describe('Run init: a run that was not opened leaves no run folders', () => {
  it('creates the folders with the checkpoint, and finishes an approval whose run was never opened', () => {
    const repo = makeRepo();
    try {
      const contractPath = writeContract(repo, 'INIT');
      const cli = (...args) => spawnSync(process.execPath, [path.join(CRAFTHELM_ROOT, 'scripts', 'crafthelm.mjs'), ...args], { cwd: repo, encoding: 'utf8' });
      // Approved through the CLI, as the chained command below is: the same actor on the same channel.
      assert.equal(cli('contract', 'approve', contractPath, '--actor', 'operator').status, 0);
      const runDir = getRunDir(repo, 'INIT-RUN');

      // Stopped before the checkpoint was written (here: a baseline that does not resolve).
      assert.throws(() => initCheckpoint({ repo, contract: contractPath, runId: 'INIT-RUN', baselineRef: 'no-such-ref' }), /BASELINE_REF_INVALID/);
      for (const sub of ['approvals', 'evidence', 'reports', 'checkpoint.json']) {
        assert.equal(fs.existsSync(path.join(runDir, sub)), false, `${sub} should not exist`);
      }

      // The same chained command again: the approval stands, the run is opened, and the notice says so.
      const res = cli('contract', 'approve', contractPath, '--actor', 'operator', '--init-run', '--repo', repo, '--run-id', 'INIT-RUN');
      assert.equal(res.status, 0, res.stderr);
      const out = JSON.parse(res.stdout);
      assert.deepEqual([out.already_approved, out.run.run_id, out.run.initialized], [true, 'INIT-RUN', true]);
      assert.match(res.stderr, /the approval was left as it is and run INIT-RUN was opened/);
      assert.doesNotMatch(res.stderr, /nothing was written/);
      assert.equal(readJson(getCheckpointPath(repo, 'INIT-RUN')).state, 'READY');
      for (const sub of ['approvals', 'evidence/tests', 'reports']) {
        assert.equal(fs.statSync(path.join(runDir, sub)).isDirectory(), true);
      }
    } finally {
      remove(repo);
    }
  });
});
