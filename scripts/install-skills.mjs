import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import { applyClaudePermissionGuards } from './lib/claude-permissions.mjs';
import { sha256Text } from './lib/crypto.mjs';
import { CRAFTHELM_ROOT, toPosixPath } from './lib/paths.mjs';

export const SKILL_MODULES = Object.freeze([
  'interview',
  'plan',
  'implement',
  'verify',
  'review-publish',
  'learn',
]);

const VALID_TARGETS = new Set(['claude', 'codex', 'gemini', 'antigravity', 'agents', 'all']);
const INSTALL_MANIFEST_NAME = '.crafthelm-skill-install.json';

const HOST_PROFILE_META = Object.freeze({
  claude: {
    title: 'CraftHelm Claude Code Skill',
    doctorHost: 'claude',
    initHost: 'claude',
    routeHost: 'claude',
    isolationLine: 'Claude-only single-provider workflow (`--host claude`). Never invoke another provider CLI.',
    delegationLine: 'Use Claude native subagents or scoped session turns strictly inside `scope.allow`, routing classification to `lightweight` and architecture/escalation to `reasoning`.',
  },
  codex: {
    title: 'CraftHelm Codex Skill',
    doctorHost: 'codex',
    initHost: 'codex',
    routeHost: 'codex',
    isolationLine: 'Codex-only single-provider workflow (`--host codex`). Never invoke another provider CLI.',
    delegationLine: 'Execute scoped tasks sequentially in Codex inside `scope.allow`, routing classification to `lightweight` and architecture/escalation to `reasoning` when supported.',
  },
  antigravity: {
    title: 'CraftHelm Antigravity / Gemini Skill',
    doctorHost: 'antigravity',
    initHost: 'antigravity',
    routeHost: 'antigravity',
    isolationLine: 'Antigravity / Gemini single-provider workflow (`--host antigravity` or `--host generic`). Never invoke another provider CLI.',
    delegationLine: 'Use `invoke_subagent` (or `agy` worker) for scoped edits inside `scope.allow`, routing lightweight exploration to `flash_lite` and architecture/escalated repairs to `pro`.',
  },
  gemini: {
    title: 'CraftHelm Gemini Skill',
    doctorHost: 'generic',
    initHost: 'gemini',
    routeHost: 'generic',
    isolationLine: 'Gemini single-provider workflow (`--host gemini` / `--host generic`). Never invoke another provider CLI.',
    delegationLine: 'Use native Gemini session delegation or scoped turns inside `scope.allow`, routing tasks with `route` according to complexity and retry round.',
  },
  generic: {
    title: 'CraftHelm Universal Host Skill',
    doctorHost: 'generic',
    initHost: 'generic',
    routeHost: 'generic',
    isolationLine: 'Single-provider universal host workflow (`--host generic`). Never invoke another provider CLI.',
    delegationLine: 'Delegate or execute scoped turns inside `scope.allow`, honoring single-model capability reporting when multi-model tiers are unavailable.',
  },
});

/**
 * Render a host-isolated `SKILL.md` entrypoint referencing the installed CraftHelm CLI path.
 * @param {'claude'|'codex'|'antigravity'|'gemini'|'generic'} [hostProfile]
 * @param {string|null} [crafthelmRoot]
 * @returns {string}
 */
export function renderHostSkillMarkdown(hostProfile = 'generic', crafthelmRoot = CRAFTHELM_ROOT) {
  const profileKey = Object.hasOwn(HOST_PROFILE_META, hostProfile) ? hostProfile : 'generic';
  const meta = HOST_PROFILE_META[profileKey];
  const cliCmd = crafthelmRoot
    ? `node "${toPosixPath(path.join(path.resolve(crafthelmRoot), 'scripts', 'crafthelm.mjs'))}"`
    : 'node scripts/crafthelm.mjs';

  return [
    '---',
    'name: crafthelm',
    'description: >-',
    '  Single-provider, interview-first, methodology-composable, evidence-driven development operating',
    '  framework. Use when driving a coding task through Source-First interview, execution contract,',
    '  AST/call-graph impact analysis, selective regression verification, and READY_FOR_HUMAN_REVIEW.',
    '---',
    '',
    `# ${meta.title}`,
    '',
    '> **The Lead Steers. Workers Build. Evidence Decides.**',
    '',
    `- **Isolation:** ${meta.isolationLine}`,
    `- **Delegation:** ${meta.delegationLine}`,
    '',
    '## Workflow Gate Sequence',
    '',
    `1. **Doctor & Bootstrap:** Run \`${cliCmd} doctor --host ${meta.doctorHost} --json\` and \`${cliCmd} init-host --repo . --host ${meta.initHost}\` if \`.crafthelm/config.json\` is missing.`,
    `2. **Source-First Interview:** Read target SOT files first, then run \`${cliCmd} interview --repo . --task-id <ID> --request "<task>" --host ${meta.initHost}\`. Never guess unresolved \`BLOCKER\`s.`,
    `3. **Contract, Skills Lock & Checkpoint:** Approve the contract (\`contract approve\`), lock skills (\`skills lock --repo . --host ${meta.initHost}\`), and initialize checkpoint (\`checkpoint init\`).`,
    `4. **Cost-Aware Routing & Scoped Implementation:** Acquire single-writer lock (\`checkpoint acquire-lock\`), pick tier with \`${cliCmd} route --task-type <type> --host ${meta.routeHost} --repo . --json\`, edit strictly inside \`scope.allow\`, and release the writer lock.`,
    `5. **Impact Analysis & Bounded Regression Loop:** Run \`${cliCmd} impact --repo . --json\` and \`${cliCmd} verify --repo . --run-id <RUN> --selective\` (or \`${cliCmd} feedback --repo . --run-id <RUN> --selective\`). Respect the 3-round repair limit (\`BLOCKED_HUMAN_ATTENTION\`).`,
    `6. **Review Package & Human Handoff:** Run \`${cliCmd} review-package --repo . --run-id <RUN>\` and stop strictly at \`READY_FOR_HUMAN_REVIEW\`. Only explicit human input runs \`approve record\`.`,
    '',
    '## Stage Reference Modules',
    '',
    '- [interview](./references/interview.md)',
    '- [plan](./references/plan.md)',
    '- [implement](./references/implement.md)',
    '- [verify](./references/verify.md)',
    '- [review-publish](./references/review-publish.md)',
    '- [learn](./references/learn.md)',
    '',
    '## Non-Negotiable Invariants',
    '',
    '- Never introduce a `COMPLETE` state.',
    '- Never create `approvals/decision.json` automatically without explicit human input.',
    '- Never fabricate token counts or dollar costs; report `"unknown"` when unmeasured.',
    '',
  ].join('\n');
}

function readSkillReferenceFiles(crafthelmRoot = CRAFTHELM_ROOT) {
  const refs = {};
  for (const mod of SKILL_MODULES) {
    const src = path.join(crafthelmRoot, 'skills', mod, 'SKILL.md');
    const content = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
    refs[`references/${mod}.md`] = content;
  }
  return refs;
}

function buildExpectedFilesMap(hostProfile, crafthelmRoot = CRAFTHELM_ROOT, cliRoot = crafthelmRoot) {
  return {
    'SKILL.md': renderHostSkillMarkdown(hostProfile, cliRoot),
    ...readSkillReferenceFiles(crafthelmRoot),
  };
}

function computeSkillPayloadDigest(filesMap) {
  const keys = Object.keys(filesMap).sort();
  const payload = keys.map((k) => `${k}\n${filesMap[k]}`).join('\n---\n');
  return sha256Text(payload);
}

/**
 * Resolve host-specific user or project skill installation directories.
 * @param {{ targets?: string|string[], scope?: 'user'|'project', homeDir?: string, repoRoot?: string }} [options]
 */
export function resolveSkillTargets(options = {}) {
  const scope = String(options.scope ?? 'user').trim().toLowerCase();
  if (scope !== 'user' && scope !== 'project') {
    throw new Error(`Invalid scope "${scope}". Expected "user" or "project".`);
  }

  const rawTargets = Array.isArray(options.targets)
    ? options.targets
    : String(options.targets ?? 'all')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

  const requested = rawTargets.length > 0 ? rawTargets.map((t) => String(t).trim().toLowerCase()) : ['all'];
  for (const t of requested) {
    if (!VALID_TARGETS.has(t)) {
      throw new Error(`Unknown skill target "${t}". Valid targets: claude, codex, gemini, antigravity, agents, all`);
    }
  }

  const expanded = [];
  for (const t of requested) {
    if (t === 'all') {
      expanded.push('claude', 'codex', 'gemini');
    } else {
      expanded.push(t);
    }
  }

  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const entries = [];

  for (const target of expanded) {
    if (target === 'claude') {
      entries.push({
        target: 'claude',
        hostProfile: 'claude',
        scope,
        skillDir: scope === 'user'
          ? path.join(homeDir, '.claude', 'skills', 'crafthelm')
          : path.join(repoRoot, '.claude', 'skills', 'crafthelm'),
        kouetsuBundle: 'universal',
        settingsPath: scope === 'user'
          ? path.join(homeDir, '.claude', 'settings.json')
          : path.join(repoRoot, '.claude', 'settings.json'),
      });
    } else if (target === 'codex') {
      entries.push({
        target: 'codex',
        hostProfile: 'codex',
        scope,
        skillDir: scope === 'user'
          ? path.join(homeDir, '.codex', 'skills', 'crafthelm')
          : path.join(repoRoot, '.codex', 'skills', 'crafthelm'),
        kouetsuBundle: 'codex',
      });
    } else if (target === 'gemini') {
      if (scope === 'user') {
        entries.push(
          {
            target: 'gemini-antigravity',
            hostProfile: 'antigravity',
            scope,
            skillDir: path.join(homeDir, '.gemini', 'config', 'skills', 'crafthelm'),
            kouetsuBundle: 'universal',
          },
          {
            target: 'gemini-cli',
            hostProfile: 'gemini',
            scope,
            skillDir: path.join(homeDir, '.gemini', 'skills', 'crafthelm'),
            kouetsuBundle: 'universal',
          },
        );
      } else {
        entries.push(
          {
            target: 'gemini-cli',
            hostProfile: 'gemini',
            scope,
            skillDir: path.join(repoRoot, '.gemini', 'skills', 'crafthelm'),
            kouetsuBundle: 'universal',
          },
          {
            target: 'gemini-agents',
            hostProfile: 'generic',
            scope,
            skillDir: path.join(repoRoot, '.agents', 'skills', 'crafthelm'),
            kouetsuBundle: 'universal',
          },
        );
      }
    } else if (target === 'antigravity') {
      entries.push({
        target: 'antigravity',
        hostProfile: 'antigravity',
        scope,
        skillDir: scope === 'user'
          ? path.join(homeDir, '.gemini', 'config', 'skills', 'crafthelm')
          : path.join(repoRoot, '.agents', 'skills', 'crafthelm'),
        kouetsuBundle: 'universal',
      });
    } else if (target === 'agents') {
      entries.push({
        target: 'agents',
        hostProfile: 'generic',
        scope,
        skillDir: scope === 'user'
          ? path.join(homeDir, '.agents', 'skills', 'crafthelm')
          : path.join(repoRoot, '.agents', 'skills', 'crafthelm'),
        kouetsuBundle: 'universal',
      });
    }
  }

  const deduped = [];
  const seenDirs = new Set();
  for (const item of entries) {
    const normKey = process.platform === 'win32' ? path.resolve(item.skillDir).toLowerCase() : path.resolve(item.skillDir);
    if (seenDirs.has(normKey)) continue;
    seenDirs.add(normKey);
    deduped.push(item);
  }
  return deduped;
}

function readInstallManifest(skillDir) {
  const manifestPath = path.join(skillDir, INSTALL_MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

function copyKouetsuSiblingIfMissing(skillDir, kouetsuBundle, crafthelmRoot, force) {
  const siblingDir = path.join(path.dirname(skillDir), 'kouetsu');
  const siblingSkill = path.join(siblingDir, 'SKILL.md');
  if (fs.existsSync(siblingSkill) && !force) {
    return { status: 'ALREADY_PRESENT', path: siblingDir };
  }
  const srcDir = path.join(crafthelmRoot, 'hosts', kouetsuBundle, 'skills', 'kouetsu');
  const walkCopy = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      const sPath = path.join(src, ent.name);
      const dPath = path.join(dst, ent.name);
      if (ent.isDirectory()) {
        walkCopy(sPath, dPath);
      } else if (ent.isFile()) {
        const buf = fs.readFileSync(sPath);
        if (/\.(?:md|txt|json)$/i.test(ent.name) || ent.name === 'LICENSE') {
          fs.writeFileSync(dPath, buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
        } else {
          fs.writeFileSync(dPath, buf);
        }
      }
    }
  };
  walkCopy(srcDir, siblingDir);
  return { status: 'INSTALLED', path: siblingDir };
}

/**
 * Install CraftHelm host-isolated skills into Claude Code, Codex, Gemini/Antigravity, or `.agents`.
 * Supports `--dry-run`, `--force`, and `--with-kouetsu`. Never touches `~/.claude/plugins/`.
 * @param {object} [options]
 */
export function installSkills(options = {}) {
  const crafthelmRoot = path.resolve(options.crafthelmRoot ?? CRAFTHELM_ROOT);
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const withKouetsu = Boolean(options.withKouetsu);
  const skipClaudePermissions = Boolean(options.skipClaudePermissions);
  const targets = resolveSkillTargets(options);
  // The skill is only half the install on Claude Code: its approval guards live in settings.json.
  const guardClaude = (entry) => (entry.settingsPath && !skipClaudePermissions
    ? { claude_permissions: applyClaudePermissionGuards({ settingsPath: entry.settingsPath, dryRun }) }
    : {});
  const results = [];

  for (const entry of targets) {
    const filesMap = buildExpectedFilesMap(entry.hostProfile, crafthelmRoot, crafthelmRoot);
    const skillSha256 = computeSkillPayloadDigest(filesMap);
    const exists = fs.existsSync(entry.skillDir);
    const existingManifest = exists ? readInstallManifest(entry.skillDir) : null;
    const isManaged = existingManifest?.managed_by === 'crafthelm';

    if (exists && !isManaged && !force) {
      results.push({
        target: entry.target,
        host_profile: entry.hostProfile,
        scope: entry.scope,
        skill_dir: entry.skillDir,
        action: 'SKIPPED_UNMANAGED',
        skill_sha256: skillSha256,
        reason: 'Directory exists without CraftHelm install manifest (pass --force to overwrite)',
      });
      continue;
    }

    if (dryRun) {
      results.push({
        target: entry.target,
        host_profile: entry.hostProfile,
        scope: entry.scope,
        skill_dir: entry.skillDir,
        action: exists ? (isManaged ? 'WOULD_UPDATE' : 'WOULD_OVERWRITE') : 'WOULD_INSTALL',
        skill_sha256: skillSha256,
        planned_files: [...Object.keys(filesMap).sort(), INSTALL_MANIFEST_NAME],
        ...(withKouetsu ? { planned_kouetsu_dir: path.join(path.dirname(entry.skillDir), 'kouetsu') } : {}),
        ...guardClaude(entry),
      });
      continue;
    }

    for (const [rel, content] of Object.entries(filesMap)) {
      const dest = path.join(entry.skillDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content.replace(/\r\n/g, '\n'), 'utf8');
    }

    const manifestObj = {
      schema_version: '0.3',
      managed_by: 'crafthelm',
      skill_name: 'crafthelm',
      target: entry.target,
      host_profile: entry.hostProfile,
      scope: entry.scope,
      crafthelm_root: toPosixPath(crafthelmRoot),
      skill_sha256: skillSha256,
      installed_at: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(entry.skillDir, INSTALL_MANIFEST_NAME),
      `${JSON.stringify(manifestObj, null, 2)}\n`,
      'utf8',
    );

    const kouetsuInfo = withKouetsu
      ? copyKouetsuSiblingIfMissing(entry.skillDir, entry.kouetsuBundle, crafthelmRoot, force)
      : null;

    results.push({
      target: entry.target,
      host_profile: entry.hostProfile,
      scope: entry.scope,
      skill_dir: entry.skillDir,
      action: exists ? (isManaged ? 'UPDATED' : 'OVERWRITTEN') : 'INSTALLED',
      skill_sha256: skillSha256,
      ...(kouetsuInfo ? { kouetsu: kouetsuInfo } : {}),
      ...guardClaude(entry),
    });
  }

  return {
    ok: true,
    dry_run: dryRun,
    scope: String(options.scope ?? 'user').trim().toLowerCase(),
    crafthelm_root: toPosixPath(crafthelmRoot),
    results,
  };
}

/**
 * Inspect installation status across resolved host skill directories.
 * @param {object} [options]
 */
export function getSkillsInstallStatus(options = {}) {
  const crafthelmRoot = path.resolve(options.crafthelmRoot ?? CRAFTHELM_ROOT);
  const targets = resolveSkillTargets(options);
  const statuses = [];

  for (const entry of targets) {
    const skillMdPath = path.join(entry.skillDir, 'SKILL.md');
    if (!fs.existsSync(entry.skillDir) || !fs.existsSync(skillMdPath)) {
      statuses.push({
        target: entry.target,
        host_profile: entry.hostProfile,
        scope: entry.scope,
        skill_dir: entry.skillDir,
        status: 'NOT_INSTALLED',
      });
      continue;
    }

    const manifest = readInstallManifest(entry.skillDir);
    if (!manifest || manifest.managed_by !== 'crafthelm') {
      statuses.push({
        target: entry.target,
        host_profile: entry.hostProfile,
        scope: entry.scope,
        skill_dir: entry.skillDir,
        status: 'UNMANAGED',
      });
      continue;
    }

    const expectedMap = buildExpectedFilesMap(entry.hostProfile, crafthelmRoot, crafthelmRoot);
    const expectedDigest = computeSkillPayloadDigest(expectedMap);
    const diskMap = {};
    let allPresent = true;
    for (const rel of Object.keys(expectedMap)) {
      const p = path.join(entry.skillDir, rel);
      if (!fs.existsSync(p)) {
        allPresent = false;
        break;
      }
      diskMap[rel] = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    }
    const diskDigest = allPresent ? computeSkillPayloadDigest(diskMap) : null;
    const isCurrent = Boolean(
      allPresent &&
      diskDigest === expectedDigest &&
      manifest.skill_sha256 === expectedDigest,
    );

    statuses.push({
      target: entry.target,
      host_profile: entry.hostProfile,
      scope: entry.scope,
      skill_dir: entry.skillDir,
      status: isCurrent ? 'INSTALLED' : 'OUTDATED',
      installed_sha256: manifest.skill_sha256 ?? null,
      disk_sha256: diskDigest,
      expected_sha256: expectedDigest,
    });
  }

  // One status per target, in order: report whether that scope's settings.json still lacks guards.
  targets.forEach((entry, i) => {
    if (entry.settingsPath) {
      const check = applyClaudePermissionGuards({ settingsPath: entry.settingsPath, dryRun: true });
      statuses[i].claude_permissions = { ...check, action: check.action === 'WOULD_ADD' ? 'MISSING' : check.action };
    }
  });

  return {
    ok: true,
    scope: String(options.scope ?? 'user').trim().toLowerCase(),
    crafthelm_root: toPosixPath(crafthelmRoot),
    targets: statuses,
  };
}

/**
 * Safely uninstall only CraftHelm-managed skill directories (`managed_by === "crafthelm"`).
 * @param {object} [options]
 */
export function uninstallSkills(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const targets = resolveSkillTargets(options);
  const results = [];

  for (const entry of targets) {
    if (!fs.existsSync(entry.skillDir)) {
      results.push({
        target: entry.target,
        scope: entry.scope,
        skill_dir: entry.skillDir,
        ok: true,
        action: 'NOT_INSTALLED',
      });
      continue;
    }

    const manifest = readInstallManifest(entry.skillDir);
    if (!manifest || manifest.managed_by !== 'crafthelm') {
      results.push({
        target: entry.target,
        scope: entry.scope,
        skill_dir: entry.skillDir,
        ok: false,
        action: 'REFUSED_UNMANAGED',
        reason: 'Directory is not managed by CraftHelm (.crafthelm-skill-install.json missing or invalid)',
      });
      continue;
    }

    if (dryRun) {
      results.push({
        target: entry.target,
        scope: entry.scope,
        skill_dir: entry.skillDir,
        ok: true,
        action: 'WOULD_UNINSTALL',
      });
      continue;
    }

    fs.rmSync(entry.skillDir, { recursive: true, force: true });
    results.push({
      target: entry.target,
      scope: entry.scope,
      skill_dir: entry.skillDir,
      ok: true,
      action: 'UNINSTALLED',
    });
  }

  return {
    ok: results.every((r) => r.ok !== false),
    dry_run: dryRun,
    scope: String(options.scope ?? 'user').trim().toLowerCase(),
    results,
  };
}

function printUsage() {
  process.stdout.write(
    [
      'CraftHelm Skill Installer CLI (Claude Code / Codex / Gemini & Antigravity)',
      '',
      'Usage: install-skills.mjs [--targets all|claude,codex,gemini] [--scope user|project] [--repo <path>] [--home-dir <path>] [--with-kouetsu] [--skip-claude-permissions] [--dry-run] [--force] [--status] [--uninstall]',
      '',
      'Installing the claude target also adds the approval guard rules (deny "approve record|keygen", ask on',
      'contract/stage approvals) to that scope\'s .claude/settings.json. Rules are only added, never removed.',
      '',
    ].join('\n'),
  );
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (isHelpRequested(argv)) {
    printUsage();
    process.exit(0);
  }
  const args = parseArgs(argv, { multiFlags: ['targets', 'target'] });
  try {
    const rawTargets = Array.isArray(args.targets) && args.targets.length > 0
      ? args.targets
      : Array.isArray(args.target) && args.target.length > 0
        ? args.target
        : (args.targets ?? args.target ?? 'all');

    const commonOpts = {
      targets: rawTargets,
      scope: args.scope ?? 'user',
      homeDir: args['home-dir'],
      repoRoot: args.repo,
      crafthelmRoot: args['crafthelm-root'],
      dryRun: Boolean(args['dry-run']),
      force: Boolean(args.force),
      withKouetsu: Boolean(args['with-kouetsu']),
      skipClaudePermissions: Boolean(args['skip-claude-permissions']),
    };

    let res;
    if (args.status) {
      res = getSkillsInstallStatus(commonOpts);
    } else if (args.uninstall) {
      res = uninstallSkills(commonOpts);
    } else {
      res = installSkills(commonOpts);
    }

    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    if (!res.ok) process.exit(1);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
