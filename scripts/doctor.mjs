import { findCraftHelmRepo } from './lib/scope-guard.mjs';
import { BUILTIN_CLI_HOSTS, getHostAdapter, normalizeHostId } from '../hosts/registry.mjs';
import { getSkillsInstallStatus } from './install-skills.mjs';
import { inspectClaudeScopeHook, inspectClaudeStatusHook } from './lib/claude-hooks.mjs';
import { inspectClaudePermissionGuards } from './lib/claude-permissions.mjs';
import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import { runCommand } from './lib/exec.mjs';
import { cliInvocation } from './lib/paths.mjs';

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
  // Fix commands are run from the target repository, where `scripts/` is not CraftHelm's.
  const cli = cliInvocation(options.repo ?? process.cwd());
  const repoFlag = options.repo ? ` --repo "${options.repo}"` : ' --repo <repo>';
  if (hosts.claude) {
    const guards = inspectClaudePermissionGuards({ homeDir: options.homeDir, repoRoot: options.repo });
    hosts.claude.permission_guards = guards;
    if (guards.status !== 'GUARDED') {
      const missing = [...guards.missing.deny.map((r) => `deny ${r}`), ...guards.missing.ask.map((r) => `ask ${r}`)];
      warnings.push({
        code: 'CLAUDE_PERMISSION_GUARDS_MISSING',
        detail: `Claude settings lack ${missing.length} approval guard rule(s): ${missing.join(', ')}`,
        fix: `${cli} install-skills --targets claude (or ${cli} init-host --host claude${repoFlag} for a project)`,
      });
    }
    for (const f of guards.files.filter((x) => x.error)) {
      warnings.push({ code: 'CLAUDE_SETTINGS_UNREADABLE', detail: `${f.path}: ${f.error}`, fix: 'Fix the JSON so its permission rules apply.' });
    }
    if (options.repo) {
      const statusHook = inspectClaudeStatusHook({ repoRoot: options.repo });
      hosts.claude.status_hook = statusHook;
      if (statusHook.status !== 'REGISTERED') {
        warnings.push({
          code: statusHook.status === 'STALE' ? 'CLAUDE_STATUS_HOOK_STALE' : 'CLAUDE_STATUS_HOOK_MISSING',
          detail: `${statusHook.settings_path} does not register the session status hook of this checkout; later turns of a session are not reminded of the open run and its scope`,
          fix: `${cli} init-host --host claude${repoFlag}`,
        });
      }
      const scopeHook = inspectClaudeScopeHook({ repoRoot: options.repo });
      hosts.claude.scope_hook = scopeHook;
      if (scopeHook.status !== 'REGISTERED') {
        warnings.push({
          code: scopeHook.status === 'STALE' ? 'CLAUDE_SCOPE_HOOK_STALE' : 'CLAUDE_SCOPE_HOOK_MISSING',
          detail: scopeHook.status === 'STALE'
            ? `${scopeHook.settings_path} registers a scope guard from another CraftHelm path; writes outside scope.allow are not blocked until it points at this checkout`
            : `${scopeHook.settings_path} has no scope guard hook; writes outside scope.allow are reported by verify but not blocked beforehand`,
          fix: `${cli} init-host --host claude${repoFlag}`,
        });
      }
    }
    const scopes = [{ scope: 'user' }, ...(options.repo ? [{ scope: 'project', repoRoot: options.repo }] : [])];
    const copies = scopes.flatMap((s) => getSkillsInstallStatus({ targets: 'claude', homeDir: options.homeDir, ...s }).targets)
      .map((t) => ({ scope: t.scope, skill_dir: t.skill_dir, status: t.status, ...(t.differs === undefined ? {} : { differs: t.differs }) }));
    hosts.claude.skill_copies = copies;
    const scopeFlags = (c) => `--scope ${c.scope}${c.scope === 'project' ? repoFlag : ''}`;
    for (const c of copies.filter((x) => x.status === 'OUTDATED')) {
      warnings.push({
        code: 'CLAUDE_SKILL_OUTDATED',
        detail: `${c.scope} skill copy at ${c.skill_dir} differs from this CraftHelm checkout`,
        fix: `${cli} install-skills --targets claude ${scopeFlags(c)}`,
      });
    }
    // A copy with no install manifest is skipped by install-skills, so updating the skill leaves it
    // as it was. In a project it is also the copy the agent reads when both scopes have one.
    for (const c of copies.filter((x) => x.status === 'UNMANAGED' && x.differs)) {
      warnings.push({
        code: 'CLAUDE_SKILL_UNMANAGED',
        detail: `${c.scope} skill copy at ${c.skill_dir} differs from this CraftHelm checkout and has no install manifest, so install-skills does not update it${c.scope === 'project' ? '; a project copy is read in place of the user copy' : ''}`,
        fix: `${cli} install-skills --targets claude ${scopeFlags(c)} --force (replaces the copy; keep any edits you made to it first)`,
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
    // Run inside a repository CraftHelm has set up, the project checks apply to it without --repo:
    // a setup older than the hooks is otherwise never reported.
    repo: typeof args.repo === 'string' ? args.repo : (findCraftHelmRepo(process.cwd()) ?? undefined),
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
