import { BUILTIN_CLI_HOSTS, getHostAdapter, normalizeHostId } from '../hosts/registry.mjs';
import { getSkillsInstallStatus } from './install-skills.mjs';
import { inspectClaudeScopeHook } from './lib/claude-hooks.mjs';
import { inspectClaudePermissionGuards } from './lib/claude-permissions.mjs';
import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import { runCommand } from './lib/exec.mjs';

/**
 * Probe host environment capabilities for any built-in or custom/generic single-provider host
 * without silently bypassing missing tools or calling unrelated provider CLIs.
 * @param {{ host?: string, cli?: string, inSession?: boolean, singleModel?: boolean, requireKouetsu?: boolean, env?: NodeJS.ProcessEnv, runner?: Function, resolve?: Function, homeDir?: string, kouetsuRoot?: string, repo?: string }} [options]
 */
export function runDoctor(options = {}) {
  const rawRequested = String(options.host ?? 'auto').trim().toLowerCase();
  const isAuto = rawRequested === 'auto' || rawRequested === '';
  const execOpts = { env: options.env, runner: options.runner, resolve: options.resolve };
  const gitRes = runCommand('git', ['--version'], execOpts);

  const probeOpts = {
    env: options.env,
    runner: options.runner,
    resolve: options.resolve,
    homeDir: options.homeDir,
    singleModel: Boolean(options.singleModel),
    kouetsuRoot: options.kouetsuRoot,
    repoRoot: options.repo,
    inSession: Boolean(options.inSession),
    cliCommand: options.cli,
  };

  const hosts = {};
  let requestedAvailable = false;

  if (isAuto) {
    for (const builtinId of BUILTIN_CLI_HOSTS) {
      const { adapter } = getHostAdapter(builtinId);
      const caps = adapter.discoverCapabilities(probeOpts);
      hosts[builtinId] = {
        ...caps,
        worker_roles: buildWorkerRoles(adapter, caps),
      };
    }
    const { adapter: genericAdapter } = getHostAdapter('generic', {
      hostConfig: options.cli ? { cli_command: options.cli } : {},
    });
    const genericCaps = genericAdapter.discoverCapabilities(probeOpts);
    hosts.generic = {
      ...genericCaps,
      worker_roles: buildWorkerRoles(genericAdapter, genericCaps),
    };
    const anyCliAvailable = BUILTIN_CLI_HOSTS.some((id) => hosts[id]?.status === 'AVAILABLE');
    requestedAvailable = anyCliAvailable || Boolean(options.inSession);
  } else {
    const normHost = normalizeHostId(rawRequested);
    const { adapter } = getHostAdapter(normHost, {
      hostConfig: options.cli ? { cli_command: options.cli } : {},
    });
    const caps = adapter.discoverCapabilities(probeOpts);
    hosts[normHost] = {
      ...caps,
      worker_roles: buildWorkerRoles(adapter, caps),
    };
    requestedAvailable = hosts[normHost]?.status === 'AVAILABLE';
  }

  let kouetsuOk = true;
  if (options.requireKouetsu) {
    kouetsuOk = Object.values(hosts).some(
      (h) => h.status === 'AVAILABLE' && h.kouetsu?.status === 'VERIFIED',
    );
  }

  // Claude Code setup drift: guards missing from settings, or a skill copy older than this checkout.
  // Advisory only: these never change `ok`, they tell the operator what to re-run.
  const warnings = [];
  if (hosts.claude) {
    const guards = inspectClaudePermissionGuards({ homeDir: options.homeDir, repoRoot: options.repo });
    hosts.claude.permission_guards = guards;
    if (guards.status !== 'GUARDED') {
      const missing = [...guards.missing.deny.map((r) => `deny ${r}`), ...guards.missing.ask.map((r) => `ask ${r}`)];
      warnings.push({
        code: 'CLAUDE_PERMISSION_GUARDS_MISSING',
        detail: `Claude settings lack ${missing.length} approval guard rule(s): ${missing.join(', ')}`,
        fix: 'node scripts/install-skills.mjs --targets claude (or init-host --host claude for a project)',
      });
    }
    for (const f of guards.files.filter((x) => x.error)) {
      warnings.push({ code: 'CLAUDE_SETTINGS_UNREADABLE', detail: `${f.path}: ${f.error}`, fix: 'Fix the JSON so its permission rules apply.' });
    }
    if (options.repo) {
      const scopeHook = inspectClaudeScopeHook({ repoRoot: options.repo });
      hosts.claude.scope_hook = scopeHook;
      if (scopeHook.status !== 'REGISTERED') {
        warnings.push({
          code: scopeHook.status === 'STALE' ? 'CLAUDE_SCOPE_HOOK_STALE' : 'CLAUDE_SCOPE_HOOK_MISSING',
          detail: scopeHook.status === 'STALE'
            ? `${scopeHook.settings_path} registers a scope guard from another CraftHelm path; writes outside scope.allow are not blocked until it points at this checkout`
            : `${scopeHook.settings_path} has no scope guard hook; writes outside scope.allow are reported by verify but not blocked beforehand`,
          fix: 'node scripts/init-host.mjs --host claude --repo <repo>',
        });
      }
    }
    const scopes = [{ scope: 'user' }, ...(options.repo ? [{ scope: 'project', repoRoot: options.repo }] : [])];
    const copies = scopes.flatMap((s) => getSkillsInstallStatus({ targets: 'claude', homeDir: options.homeDir, ...s }).targets)
      .map((t) => ({ scope: t.scope, skill_dir: t.skill_dir, status: t.status }));
    hosts.claude.skill_copies = copies;
    for (const c of copies.filter((x) => x.status === 'OUTDATED')) {
      warnings.push({
        code: 'CLAUDE_SKILL_OUTDATED',
        detail: `${c.scope} skill copy at ${c.skill_dir} differs from this CraftHelm checkout`,
        fix: `node scripts/install-skills.mjs --targets claude --scope ${c.scope}`,
      });
    }
  }

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const runtimeOk = nodeMajor >= 24 && gitRes.exitCode === 0;
  const ok = requestedAvailable && runtimeOk && kouetsuOk;

  return {
    ok,
    status: ok ? 'READY' : 'UNAVAILABLE',
    requested_host: isAuto ? 'auto' : normalizeHostId(rawRequested),
    runtime: {
      node: process.version,
      node_supported: nodeMajor >= 24,
      git_available: gitRes.exitCode === 0,
      git_version: gitRes.exitCode === 0 ? gitRes.stdout.trim() : null,
      platform: process.platform,
    },
    hosts,
    warnings,
  };
}

function buildWorkerRoles(adapter, caps) {
  return {
    lead: adapter.selectWorker('lead', caps),
    builder: adapter.selectWorker('builder', caps),
    reviewer: adapter.selectWorker('reviewer', caps),
    verifier: adapter.selectWorker('verifier', caps),
  };
}

function printUsage() {
  process.stdout.write(
    [
      'CraftHelm Doctor CLI (Probe Host & Runtime Readiness)',
      '',
      'Usage: doctor.mjs [--host auto|claude|codex|antigravity|generic|custom] [--cli "<cmd>"] [--repo .] [--in-session] [--single-model] [--require-kouetsu] [--json]',
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
  const report = runDoctor({
    host: args.host ?? 'auto',
    cli: args.cli,
    inSession: Boolean(args['in-session']),
    singleModel: Boolean(args['single-model']),
    requireKouetsu: Boolean(args['require-kouetsu']),
    repo: args.repo,
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`CraftHelm Doctor (${report.requested_host}): ${report.status}\n`);
    process.stdout.write(`- Node: ${report.runtime.node} (supported=${report.runtime.node_supported})\n`);
    process.stdout.write(`- Git: ${report.runtime.git_version ?? 'UNAVAILABLE'}\n`);
    for (const [name, h] of Object.entries(report.hosts)) {
      const detail = h.cli_version ?? h.execution_mode ?? 'not found';
      process.stdout.write(`- Host [${name}]: ${h.status} (${detail}) | Kouetsu: ${h.kouetsu.status}\n`);
      if (h.limitations?.length) {
        process.stdout.write(`  Limitations: ${h.limitations.join(', ')}\n`);
      }
    }
    for (const w of report.warnings) {
      process.stdout.write(`- Warning [${w.code}]: ${w.detail}\n  Fix: ${w.fix}\n`);
    }
  }
  process.exit(report.ok ? 0 : 1);
}
