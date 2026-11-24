import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runDoctor } from '../../scripts/doctor.mjs';
import { initHost } from '../../scripts/init-host.mjs';
import { getSkillsInstallStatus, installSkills } from '../../scripts/install-skills.mjs';
import {
  applyClaudePermissionGuards,
  getClaudeGuardRules,
  inspectClaudePermissionGuards,
} from '../../scripts/lib/claude-permissions.mjs';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function claudeRunner(cmd, args) {
  if (cmd === 'git') return { exitCode: 0, stdout: 'git version 2.54.0', stderr: '' };
  if (cmd === 'claude' && args[0] === '--version') return { exitCode: 0, stdout: '2.1.311 (Claude Code)\n', stderr: '' };
  if (cmd === 'claude' && args[0] === '--help') return { exitCode: 0, stdout: '--agents --output-format --print --model --permission-mode', stderr: '' };
  throw new Error(`Unexpected command: ${cmd}`);
}
const claudeResolve = (cmd) => ({ found: cmd === 'claude' || cmd === 'git', path: cmd, kind: 'exe' });

describe('Claude permission guards reach the real settings files', () => {
  it('derives the guard set from the example: approval denies and every ask, not the general rules', () => {
    const guards = getClaudeGuardRules();
    assert.ok(guards.deny.includes('Bash(*crafthelm approve record*)'));
    assert.ok(guards.deny.includes('Bash(*approval.mjs keygen*)'));
    assert.ok(guards.ask.includes('Bash(*--approve-contract*)'));
    assert.ok(!guards.deny.includes('Bash(git push*)'));
    assert.ok(!guards.deny.includes('Bash(rm -rf*)'));
  });

  it('merges guards into existing settings without touching other rules, and is idempotent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-perm-'));
    try {
      const settingsPath = path.join(dir, 'settings.json');
      fs.writeFileSync(settingsPath, JSON.stringify({
        model: 'opus',
        permissions: { allow: ['Bash(npm test*)'], deny: ['Bash(*approval.mjs keygen*)', 'Bash(*contract.mjs approve*)'] },
      }));
      const guards = getClaudeGuardRules();

      const dry = applyClaudePermissionGuards({ settingsPath, dryRun: true });
      assert.equal(dry.action, 'WOULD_ADD');
      assert.equal(readJson(settingsPath).permissions.ask, undefined);

      const first = applyClaudePermissionGuards({ settingsPath });
      assert.equal(first.action, 'ADDED');
      // Already-denied rules are not added again, and a denied rule is not downgraded to ask.
      assert.equal(first.added.deny.length, guards.deny.length - 1);
      assert.ok(!first.added.ask.includes('Bash(*contract.mjs approve*)'));
      const after = readJson(settingsPath);
      assert.equal(after.model, 'opus');
      assert.deepEqual(after.permissions.allow, ['Bash(npm test*)']);
      assert.deepEqual(after.permissions.deny.slice(0, 2), ['Bash(*approval.mjs keygen*)', 'Bash(*contract.mjs approve*)']);

      assert.equal(applyClaudePermissionGuards({ settingsPath }).action, 'UNCHANGED');

      const broken = path.join(dir, 'broken.json');
      fs.writeFileSync(broken, '{ "permissions": { // comment\n } }');
      const skipped = applyClaudePermissionGuards({ settingsPath: broken });
      assert.equal(skipped.action, 'SKIPPED_INVALID');
      assert.equal(fs.readFileSync(broken, 'utf8'), '{ "permissions": { // comment\n } }');

      // The write goes through a temp file and rename, leaving no stray temp files behind.
      assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);

      // An unreadable settings path (here a directory) is reported, not thrown.
      const home = path.join(dir, 'home');
      fs.mkdirSync(path.join(home, '.claude', 'settings.json'), { recursive: true });
      const inspected = inspectClaudePermissionGuards({ homeDir: home });
      assert.equal(inspected.status, 'MISSING');
      assert.match(inspected.files[0].error, /^unreadable: /);
      assert.equal(applyClaudePermissionGuards({ settingsPath: path.join(home, '.claude', 'settings.json') }).action, 'SKIPPED_INVALID');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('install-skills writes the guards for the claude target only, and honours dry-run and the opt-out', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-perm-home-'));
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-perm-proj-'));
    try {
      const userSettings = path.join(homeDir, '.claude', 'settings.json');

      const dry = installSkills({ targets: 'claude', scope: 'user', homeDir, dryRun: true });
      assert.equal(dry.results[0].claude_permissions.action, 'WOULD_ADD');
      assert.equal(fs.existsSync(userSettings), false);

      const skipped = installSkills({ targets: 'claude', scope: 'user', homeDir, skipClaudePermissions: true });
      assert.equal(skipped.results[0].claude_permissions, undefined);
      assert.equal(fs.existsSync(userSettings), false);
      assert.equal(getSkillsInstallStatus({ targets: 'claude', scope: 'user', homeDir }).targets[0].claude_permissions.action, 'MISSING');

      const res = installSkills({ targets: ['claude', 'codex'], scope: 'user', homeDir });
      assert.equal(res.results.find((r) => r.target === 'claude').claude_permissions.action, 'ADDED');
      assert.equal(res.results.find((r) => r.target === 'codex').claude_permissions, undefined);
      assert.equal(inspectClaudePermissionGuards({ homeDir }).status, 'GUARDED');
      assert.equal(getSkillsInstallStatus({ targets: 'claude', scope: 'user', homeDir }).targets[0].claude_permissions.action, 'UNCHANGED');

      // Project scope writes the project's settings.json, not the user's.
      installSkills({ targets: 'claude', scope: 'project', homeDir, repoRoot });
      assert.ok(readJson(path.join(repoRoot, '.claude', 'settings.json')).permissions.deny.length > 0);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('init-host --host claude merges guards into the project settings', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-perm-init-'));
    try {
      const settingsPath = path.join(repo, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Read'] } }));
      const res = initHost({ repo, host: 'claude' });
      assert.equal(res.claude_permissions.action, 'ADDED');
      assert.ok(res.written.includes(settingsPath));
      assert.deepEqual(readJson(settingsPath).permissions.allow, ['Read']);
      assert.equal(inspectClaudePermissionGuards({ homeDir: repo, repoRoot: repo }).status, 'GUARDED');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('doctor warns about missing guards and outdated skill copies without failing readiness', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-perm-doctor-'));
    try {
      const doctor = () => runDoctor({ host: 'claude', homeDir, runner: claudeRunner, resolve: claudeResolve });

      const bare = doctor();
      assert.equal(bare.ok, true);
      assert.equal(bare.hosts.claude.permission_guards.status, 'MISSING');
      assert.deepEqual(bare.warnings.map((w) => w.code), ['CLAUDE_PERMISSION_GUARDS_MISSING']);

      installSkills({ targets: 'claude', scope: 'user', homeDir });
      const guarded = doctor();
      assert.equal(guarded.hosts.claude.permission_guards.status, 'GUARDED');
      assert.deepEqual(guarded.warnings, []);
      assert.deepEqual(guarded.hosts.claude.skill_copies.map((c) => c.status), ['INSTALLED']);

      fs.appendFileSync(path.join(homeDir, '.claude', 'skills', 'crafthelm', 'SKILL.md'), '\nlocal edit\n');
      assert.deepEqual(doctor().warnings.map((w) => w.code), ['CLAUDE_SKILL_OUTDATED']);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
