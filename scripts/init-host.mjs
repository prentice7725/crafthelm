import fs from 'node:fs';
import path from 'node:path';
import { normalizeHostId } from '../hosts/registry.mjs';
import { SKILL_MODULES, renderHostSkillMarkdown } from './install-skills.mjs';
import { applyClaudeScopeHook, applyClaudeStatusHook } from './lib/claude-hooks.mjs';
import { applyClaudePermissionGuards } from './lib/claude-permissions.mjs';
import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import { collectRelativeFiles } from './lib/crypto.mjs';
import { DEFAULT_IGNORED_DIRS } from './lib/impact-languages.mjs';
import { CRAFTHELM_ROOT, toPosixPath } from './lib/paths.mjs';
import { detectRepoTestRunners } from './lib/test-runners.mjs';

function collectRepoFilesForDetection(repoRoot) {
  const results = [];
  const walk = (dir, prefix) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) results.push(toPosixPath(rel));
    }
  };
  walk(repoRoot, '');
  return results;
}

function writeProtectedFile(absPath, content, force, written, skipped) {
  if (fs.existsSync(absPath) && !force) {
    skipped.push(absPath);
    return;
  }
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content.replace(/\r\n/g, '\n'), 'utf8');
  written.push(absPath);
}

function copyDirectoryProtected(srcDir, dstDir, force, written, skipped) {
  const files = collectRelativeFiles(srcDir);
  for (const rel of files) {
    const srcAbs = path.join(srcDir, rel);
    const dstAbs = path.join(dstDir, rel);
    const content = fs.readFileSync(srcAbs, 'utf8');
    writeProtectedFile(dstAbs, content, force, written, skipped);
  }
}

function writeHostSkillPackage(skillDir, hostProfile, force, written, skipped) {
  writeProtectedFile(
    path.join(skillDir, 'SKILL.md'),
    renderHostSkillMarkdown(hostProfile, CRAFTHELM_ROOT),
    force,
    written,
    skipped,
  );
  for (const mod of SKILL_MODULES) {
    const srcAbs = path.join(CRAFTHELM_ROOT, 'skills', mod, 'SKILL.md');
    const content = fs.readFileSync(srcAbs, 'utf8');
    writeProtectedFile(path.join(skillDir, 'references', `${mod}.md`), content, force, written, skipped);
  }
}

/**
 * Bootstrap CraftHelm host integration files inside a target repository.
 * Supports `antigravity`, `gemini`, `claude`, `codex`, `generic`, custom host IDs, or `all`.
 * @param {{ repo?: string, host?: string, cliCommand?: string, force?: boolean }} [options]
 */
export function initHost(options = {}) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const rawHost = String(options.host ?? 'generic').trim().toLowerCase();
  const isAll = rawHost === 'all';
  const normHost = isAll ? 'all' : normalizeHostId(rawHost);
  const force = Boolean(options.force);

  const written = [];
  const skipped = [];
  let claudePermissions = null;
  let claudeScopeHook = null;
  let claudeStatusHook = null;

  const universalKouetsuDir = path.join(CRAFTHELM_ROOT, 'hosts', 'universal', 'skills', 'kouetsu');
  const codexKouetsuDir = path.join(CRAFTHELM_ROOT, 'hosts', 'codex', 'skills', 'kouetsu');

  const baseTiers = normHost === 'claude'
    ? { lightweight: 'haiku', standard: 'sonnet', reasoning: 'opus' }
    : normHost === 'antigravity'
      ? { lightweight: 'flash_lite', standard: 'flash', reasoning: 'pro' }
      : { lightweight: null, standard: null, reasoning: null };
  const defaultTiers = {
    lightweight: options.lightweightModel !== undefined ? options.lightweightModel : baseTiers.lightweight,
    standard: options.standardModel !== undefined ? options.standardModel : baseTiers.standard,
    reasoning: options.reasoningModel !== undefined ? options.reasoningModel : baseTiers.reasoning,
  };

  const detected = detectRepoTestRunners(repoRoot, collectRepoFilesForDetection(repoRoot));
  const hostConfig = {
    ...(options.cliCommand ? { cli_command: options.cliCommand } : {}),
    ...(options.supportsMultiModel ? { supports_multi_model: true } : {}),
  };

  const configPath = path.join(repoRoot, '.crafthelm', 'config.json');
  const configObj = {
    schema_version: '0.3',
    default_host: isAll ? 'generic' : normHost,
    crafthelm_root: CRAFTHELM_ROOT.replace(/\\/g, '/'),
    detected_languages: detected.languages,
    detected_test_runners: detected.runners,
    ...(Object.keys(hostConfig).length > 0 ? { host_config: hostConfig } : {}),
    verification_policy: {
      require_e2e_for_functional: true,
      require_kouetsu: true,
      regression_mode: 'selective',
      ...(options.testCommandTemplate ? { test_command_template: options.testCommandTemplate } : {}),
      ...(options.customAnalyzer ? { custom_impact_analyzer: options.customAnalyzer } : {}),
    },
    ...(options.requireRun ? { require_run_for_edits: true } : {}),
    model_routing: {
      enabled: true,
      escalate_on_retry: 2,
      model_tiers: defaultTiers,
    },
  };
  writeProtectedFile(configPath, `${JSON.stringify(configObj, null, 2)}\n`, force, written, skipped);

  const installAgentsBundle = isAll || normHost === 'antigravity' || normHost === 'gemini' || normHost === 'generic' || (normHost !== 'claude' && normHost !== 'codex');
  if (installAgentsBundle) {
    const agentsProfile = normHost === 'antigravity' ? 'antigravity' : (normHost === 'gemini' ? 'gemini' : 'generic');
    writeHostSkillPackage(
      path.join(repoRoot, '.agents', 'skills', 'crafthelm'),
      agentsProfile,
      force,
      written,
      skipped,
    );
    copyDirectoryProtected(
      universalKouetsuDir,
      path.join(repoRoot, '.agents', 'skills', 'kouetsu'),
      force,
      written,
      skipped,
    );
  }

  if (isAll || normHost === 'gemini') {
    writeHostSkillPackage(
      path.join(repoRoot, '.gemini', 'skills', 'crafthelm'),
      'gemini',
      force,
      written,
      skipped,
    );
  }

  if (isAll || normHost === 'antigravity' || normHost === 'gemini') {
    const geminiContent = [
      '# GEMINI.md — CraftHelm Gemini / Antigravity Workspace Rules',
      '',
      '- Execute CraftHelm workflow gates (`doctor`, `interview`, `contract`, `checkpoint`, `verify`, `review-package`, `approve`) using Node.js scripts under `crafthelm_root`.',
      '- Use scoped subagent or native session turns inside `scope.allow`; keep verification deterministic via `scripts/verify.mjs`.',
      '- Automation terminates at `READY_FOR_HUMAN_REVIEW`; never create `approvals/decision.json` without explicit human input or introduce a `COMPLETE` state.',
      '',
    ].join('\n');
    writeProtectedFile(path.join(repoRoot, 'GEMINI.md'), geminiContent, force, written, skipped);
  }

  if (isAll || normHost === 'claude') {
    writeHostSkillPackage(
      path.join(repoRoot, '.claude', 'skills', 'crafthelm'),
      'claude',
      force,
      written,
      skipped,
    );
    // Merged, not overwritten: approval guards are added to any existing project settings.
    if (!options.skipClaudePermissions) {
      claudePermissions = applyClaudePermissionGuards({ settingsPath: path.join(repoRoot, '.claude', 'settings.json') });
      if (claudePermissions.action === 'ADDED') written.push(claudePermissions.settings_path);
    }
    // The scope guard blocks a write outside the active contract's scope before it happens.
    if (!options.skipClaudeHooks) {
      claudeScopeHook = applyClaudeScopeHook({ settingsPath: path.join(repoRoot, '.claude', 'settings.json') });
      if (['ADDED', 'UPDATED'].includes(claudeScopeHook.action) && !written.includes(claudeScopeHook.settings_path)) {
        written.push(claudeScopeHook.settings_path);
      }
      // The status hook repeats the open run and its scope on every turn; a skill is only read once.
      claudeStatusHook = applyClaudeStatusHook({ settingsPath: path.join(repoRoot, '.claude', 'settings.json') });
      if (['ADDED', 'UPDATED'].includes(claudeStatusHook.action) && !written.includes(claudeStatusHook.settings_path)) {
        written.push(claudeStatusHook.settings_path);
      }
    }
  }

  if (isAll || normHost === 'codex') {
    writeHostSkillPackage(
      path.join(repoRoot, '.codex', 'skills', 'crafthelm'),
      'codex',
      force,
      written,
      skipped,
    );
    copyDirectoryProtected(
      codexKouetsuDir,
      path.join(repoRoot, '.codex', 'skills', 'kouetsu'),
      force,
      written,
      skipped,
    );
  }

  return {
    ok: true,
    repo: repoRoot,
    host: normHost,
    detected_languages: detected.languages,
    detected_test_runners: detected.runners,
    written,
    skipped,
    ...(claudePermissions ? { claude_permissions: claudePermissions } : {}),
    ...(claudeScopeHook ? { claude_scope_hook: claudeScopeHook } : {}),
    ...(claudeStatusHook ? { claude_status_hook: claudeStatusHook } : {}),
  };
}

function printUsage() {
  process.stdout.write(
    [
      'CraftHelm Host Initializer CLI',
      '',
      'Usage: init-host.mjs [--repo .] [--host generic|claude|codex|antigravity|gemini|custom|all] [--cli "<cmd>"] [--lightweight-model <m>] [--standard-model <m>] [--reasoning-model <m>] [--supports-multi-model] [--test-command-template "<tpl>"] [--custom-analyzer "<cmd>"] [--skip-claude-permissions] [--skip-claude-hooks] [--require-run] [--force]',
      '',
      'With --host claude|all, approval guard rules are merged into <repo>/.claude/settings.json (added, never removed).',
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
  const args = parseArgs(argv);
  try {
    const res = initHost({
      repo: args.repo ?? '.',
      host: args.host ?? 'generic',
      cliCommand: args.cli,
      lightweightModel: args['lightweight-model'],
      standardModel: args['standard-model'],
      reasoningModel: args['reasoning-model'],
      supportsMultiModel: Boolean(args['supports-multi-model']),
      testCommandTemplate: args['test-command-template'],
      customAnalyzer: args['custom-analyzer'],
      force: Boolean(args.force),
      skipClaudePermissions: Boolean(args['skip-claude-permissions']),
      skipClaudeHooks: Boolean(args['skip-claude-hooks']),
      requireRun: Boolean(args['require-run']),
    });
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
