import { BUILTIN_CLI_HOSTS, getHostAdapter, normalizeHostId } from '../hosts/registry.mjs';
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
  }
  process.exit(report.ok ? 0 : 1);
}
