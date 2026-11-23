import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { initHost } from '../../scripts/init-host.mjs';
import {
  SKILL_MODULES,
  getSkillsInstallStatus,
  installSkills,
  renderHostSkillMarkdown,
  uninstallSkills,
} from '../../scripts/install-skills.mjs';
import { CRAFTHELM_ROOT, toPosixPath } from '../../scripts/lib/paths.mjs';
import { auditSkillDirectory } from '../../scripts/skills.mjs';

describe('Universal Host Skill Installation (Claude, Codex, Gemini/Antigravity)', () => {
  it('installs, statuses, detects drift, and uninstalls CraftHelm skills cleanly in user & project scopes', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-home-'));
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-proj-'));
    const posixRoot = toPosixPath(path.resolve(CRAFTHELM_ROOT));

    try {
      // Dry-run writes zero files
      const dry = installSkills({ targets: 'all', scope: 'user', homeDir, dryRun: true });
      assert.equal(dry.ok, true);
      assert.equal(dry.results.length, 4);
      assert.ok(dry.results.every((r) => r.action === 'WOULD_INSTALL'));
      assert.equal(fs.existsSync(path.join(homeDir, '.claude', 'skills', 'crafthelm')), false);

      // Initial status reports NOT_INSTALLED across all 4 user paths
      const stBefore = getSkillsInstallStatus({ targets: 'all', scope: 'user', homeDir });
      assert.equal(stBefore.targets.length, 4);
      assert.ok(stBefore.targets.every((t) => t.status === 'NOT_INSTALLED'));

      // Real install into all 4 targets with --with-kouetsu
      const res = installSkills({ targets: ['claude', 'codex', 'gemini'], scope: 'user', homeDir, withKouetsu: true });
      assert.equal(res.ok, true);
      assert.equal(res.results.length, 4);
      assert.ok(res.results.every((r) => r.action === 'INSTALLED'));

      const expectedDirs = {
        claude: path.join(homeDir, '.claude', 'skills', 'crafthelm'),
        codex: path.join(homeDir, '.codex', 'skills', 'crafthelm'),
        geminiAntigravity: path.join(homeDir, '.gemini', 'config', 'skills', 'crafthelm'),
        geminiCli: path.join(homeDir, '.gemini', 'skills', 'crafthelm'),
      };

      for (const dir of Object.values(expectedDirs)) {
        assert.equal(fs.existsSync(path.join(dir, 'SKILL.md')), true);
        assert.equal(fs.existsSync(path.join(dir, '.crafthelm-skill-install.json')), true);
        assert.equal(fs.existsSync(path.join(path.dirname(dir), 'kouetsu', 'SKILL.md')), true);
        for (const mod of SKILL_MODULES) {
          assert.equal(fs.existsSync(path.join(dir, 'references', `${mod}.md`)), true);
        }
        const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
        assert.match(md, /^---\nname:\s*crafthelm\n/);
        assert.equal(md.includes(posixRoot), true);
        assert.equal(md.includes('\r\n'), false);
      }

      // Must never create or mutate ~/.claude/plugins
      assert.equal(fs.existsSync(path.join(homeDir, '.claude', 'plugins')), false);

      // Single-provider isolation checks
      const claudeMd = fs.readFileSync(path.join(expectedDirs.claude, 'SKILL.md'), 'utf8');
      assert.equal(/\bcodex\b/i.test(claudeMd), false);
      assert.equal(/\bagy\b/i.test(claudeMd), false);
      assert.equal(/\bantigravity\b/i.test(claudeMd), false);
      assert.equal(auditSkillDirectory(expectedDirs.claude, { host: 'claude' }).ok, true);

      const codexMd = fs.readFileSync(path.join(expectedDirs.codex, 'SKILL.md'), 'utf8');
      assert.equal(/\bclaude\b/i.test(codexMd), false);
      assert.equal(/\bagy\b/i.test(codexMd), false);
      assert.equal(/\bantigravity\b/i.test(codexMd), false);
      assert.equal(auditSkillDirectory(expectedDirs.codex, { host: 'codex' }).ok, true);

      const gemAgyMd = fs.readFileSync(path.join(expectedDirs.geminiAntigravity, 'SKILL.md'), 'utf8');
      assert.equal(/\bclaude\b/i.test(gemAgyMd), false);
      assert.equal(/\bcodex\b/i.test(gemAgyMd), false);
      assert.equal(auditSkillDirectory(expectedDirs.geminiAntigravity, { host: 'antigravity' }).ok, true);

      const gemCliMd = fs.readFileSync(path.join(expectedDirs.geminiCli, 'SKILL.md'), 'utf8');
      assert.equal(/\bclaude\b/i.test(gemCliMd), false);
      assert.equal(/\bcodex\b/i.test(gemCliMd), false);
      assert.equal(/\bagy\b/i.test(gemCliMd), false);
      assert.equal(auditSkillDirectory(expectedDirs.geminiCli, { host: 'gemini' }).ok, true);

      // Status reports INSTALLED, then OUTDATED on disk modification, then NOT_INSTALLED after uninstall
      const stInstalled = getSkillsInstallStatus({ targets: 'all', scope: 'user', homeDir });
      assert.ok(stInstalled.targets.every((t) => t.status === 'INSTALLED'));

      fs.appendFileSync(path.join(expectedDirs.codex, 'SKILL.md'), '\n<!-- drift -->\n', 'utf8');
      const stOutdated = getSkillsInstallStatus({ targets: 'codex', scope: 'user', homeDir });
      assert.equal(stOutdated.targets[0].status, 'OUTDATED');

      const unRes = uninstallSkills({ targets: 'all', scope: 'user', homeDir });
      assert.equal(unRes.ok, true);
      assert.ok(unRes.results.every((r) => r.action === 'UNINSTALLED'));
      const stAfter = getSkillsInstallStatus({ targets: 'all', scope: 'user', homeDir });
      assert.ok(stAfter.targets.every((t) => t.status === 'NOT_INSTALLED'));

      // Project scope installation covers .claude, .codex, .gemini, .agents
      const projRes = installSkills({ targets: 'all', scope: 'project', repoRoot });
      assert.equal(projRes.ok, true);
      assert.equal(projRes.results.length, 4);
      assert.equal(fs.existsSync(path.join(repoRoot, '.claude', 'skills', 'crafthelm', 'SKILL.md')), true);
      assert.equal(fs.existsSync(path.join(repoRoot, '.codex', 'skills', 'crafthelm', 'SKILL.md')), true);
      assert.equal(fs.existsSync(path.join(repoRoot, '.gemini', 'skills', 'crafthelm', 'SKILL.md')), true);
      assert.equal(fs.existsSync(path.join(repoRoot, '.agents', 'skills', 'crafthelm', 'SKILL.md')), true);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite or uninstall unmanaged directories without --force', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-unmanaged-'));
    try {
      const customDir = path.join(homeDir, '.claude', 'skills', 'crafthelm');
      fs.mkdirSync(customDir, { recursive: true });
      fs.writeFileSync(path.join(customDir, 'SKILL.md'), '---\nname: crafthelm\n---\n# Custom\n', 'utf8');

      const st = getSkillsInstallStatus({ targets: 'claude', scope: 'user', homeDir });
      assert.equal(st.targets[0].status, 'UNMANAGED');

      const skippedRes = installSkills({ targets: 'claude', scope: 'user', homeDir });
      assert.equal(skippedRes.results[0].action, 'SKIPPED_UNMANAGED');
      assert.match(fs.readFileSync(path.join(customDir, 'SKILL.md'), 'utf8'), /# Custom/);

      const refuseUn = uninstallSkills({ targets: 'claude', scope: 'user', homeDir });
      assert.equal(refuseUn.ok, false);
      assert.equal(refuseUn.results[0].action, 'REFUSED_UNMANAGED');
      assert.equal(fs.existsSync(path.join(customDir, 'SKILL.md')), true);

      const forceRes = installSkills({ targets: 'claude', scope: 'user', homeDir, force: true });
      assert.equal(forceRes.results[0].action, 'OVERWRITTEN');
      assert.equal(getSkillsInstallStatus({ targets: 'claude', scope: 'user', homeDir }).targets[0].status, 'INSTALLED');
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('validates repo manifests, static host packages, and initHost --host gemini', () => {
    const pluginManifest = JSON.parse(fs.readFileSync(path.join(CRAFTHELM_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.equal(pluginManifest.name, 'crafthelm');
    assert.equal(pluginManifest.skills, './hosts/claude/skills');

    const geminiManifest = JSON.parse(fs.readFileSync(path.join(CRAFTHELM_ROOT, 'gemini-extension.json'), 'utf8'));
    assert.equal(geminiManifest.name, 'crafthelm');
    assert.equal(geminiManifest.contextFileName, 'GEMINI.md');

    for (const host of ['claude', 'codex', 'antigravity']) {
      const staticDir = path.join(CRAFTHELM_ROOT, 'hosts', host, 'skills', 'crafthelm');
      assert.equal(fs.existsSync(path.join(staticDir, 'SKILL.md')), true);
      assert.equal(auditSkillDirectory(staticDir, { host }).ok, true);
    }

    assert.match(renderHostSkillMarkdown('generic', null), /^---\nname: crafthelm\n/);

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-init-gem-'));
    try {
      const initRes = initHost({ repo, host: 'gemini' });
      assert.equal(initRes.ok, true);
      assert.equal(fs.existsSync(path.join(repo, '.gemini', 'skills', 'crafthelm', 'SKILL.md')), true);
      assert.equal(fs.existsSync(path.join(repo, '.gemini', 'skills', 'crafthelm', 'references', 'verify.md')), true);
      assert.equal(fs.existsSync(path.join(repo, '.agents', 'skills', 'crafthelm', 'SKILL.md')), true);
      assert.equal(fs.existsSync(path.join(repo, '.agents', 'skills', 'kouetsu', 'SKILL.md')), true);
      assert.equal(fs.existsSync(path.join(repo, 'GEMINI.md')), true);
      assert.equal(fs.existsSync(path.join(repo, '.crafthelm', 'config.json')), true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
