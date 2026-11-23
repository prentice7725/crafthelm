import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveExecutable, runCommand } from '../../scripts/lib/exec.mjs';
import { getGitHead, isGitRepo } from '../../scripts/lib/git.mjs';
import { verifyKouetsuAsset } from '../../scripts/lib/kouetsu-check.mjs';

/**
 * Codex Native Host Adapter (Codex-only; never invokes Claude or external providers).
 */
export const HOST_ID = 'codex';

/**
 * Probe installed Codex CLI capabilities without invoking any other provider CLI.
 * @param {{ env?: NodeJS.ProcessEnv, runner?: Function, resolve?: Function, homeDir?: string, singleModel?: boolean, kouetsuRoot?: string }} [options]
 */
export function discoverCapabilities(options = {}) {
  const execOpts = { env: options.env, runner: options.runner, resolve: options.resolve };
  const resolved = resolveExecutable('codex', execOpts);
  const versionRes = resolved.found || options.runner
    ? runCommand('codex', ['--version'], execOpts)
    : { exitCode: 127, stdout: '', stderr: 'codex CLI not found', resolvedPath: null };

  const available = versionRes.exitCode === 0 && Boolean(versionRes.stdout.trim());
  let helpText = '';
  let execHelpText = '';
  if (available) {
    const helpRes = runCommand('codex', ['--help'], execOpts);
    helpText = `${helpRes.stdout}\n${helpRes.stderr}`;
    const execHelpRes = runCommand('codex', ['exec', '--help'], execOpts);
    execHelpText = `${execHelpRes.stdout}\n${execHelpRes.stderr}`;
  }

  const homeDir = options.homeDir ?? os.homedir();
  const codexDirExists = fs.existsSync(path.join(homeDir, '.codex'));
  const kouetsu = verifyKouetsuAsset('codex', {
    homeDir,
    kouetsuRoot: options.kouetsuRoot,
  });

  const supportsExec = available && /\bexec\b/.test(helpText);
  const supportsReview = available && /\breview\b/.test(helpText);
  const supportsAgents = available && /\bagents\b/.test(helpText);
  const supportsSandbox = available && /\bsandbox\b/.test(helpText);
  const supportsModelFlag = available && (/--model\b/.test(execHelpText) || /-m,\s*--model\b/.test(execHelpText));
  const supportsMultiModel = available && supportsModelFlag && !options.singleModel;

  const limitations = [];
  if (!available) limitations.push('codex_cli_unavailable');
  if (!supportsAgents) limitations.push('native_agents_unavailable');
  if (options.singleModel) limitations.push('single_model_mode_forced');
  if (!kouetsu.found) limitations.push('kouetsu_codex_package_missing');
  if (kouetsu.status === 'TAMPERED') limitations.push('kouetsu_digest_mismatch');

  return {
    host: 'codex',
    status: available ? 'AVAILABLE' : 'UNAVAILABLE',
    cli_found: available,
    cli_path: versionRes.resolvedPath ?? resolved.path ?? null,
    cli_version: available ? versionRes.stdout.trim().split(/\r?\n/)[0] : null,
    codex_dir_present: codexDirExists,
    supports_exec: supportsExec,
    supports_review: supportsReview,
    supports_agents: supportsAgents,
    supports_sandbox: supportsSandbox,
    supports_model_flag: supportsModelFlag,
    supports_multi_model: supportsMultiModel,
    cross_provider_isolation: 'codex_only',
    independent_cross_model_review: 'UNAVAILABLE_SINGLE_PROVIDER',
    kouetsu,
    limitations,
  };
}

/**
 * Select worker execution mode for a CraftHelm role on Codex.
 * @param {'lead'|'explorer'|'planner'|'builder'|'reviewer'|'verifier'|'learning_curator'} role
 * @param {ReturnType<typeof discoverCapabilities>} capabilities
 */
export function selectWorker(role, capabilities, options = {}) {
  if (role === 'verifier' || options.tier === 'deterministic') {
    return {
      role,
      host: 'codex',
      execution_mode: 'deterministic_script',
      model_hint: null,
      status: 'AVAILABLE',
      independent_verification: 'DETERMINISTIC',
    };
  }
  if (!capabilities || capabilities.status !== 'AVAILABLE') {
    return {
      role,
      host: 'codex',
      execution_mode: 'UNAVAILABLE',
      model_hint: null,
      status: 'UNAVAILABLE',
      reason: 'Codex CLI is not available on this host',
    };
  }

  const singleModel = !capabilities.supports_multi_model;
  const sequentialOnly = singleModel || !capabilities.supports_agents;
  const roleDefaults = {
    lead: { tier: 'primary', model_hint: null, isolated_context: false },
    explorer: { tier: 'lightweight', model_hint: null, isolated_context: capabilities.supports_agents },
    planner: { tier: 'standard', model_hint: null, isolated_context: capabilities.supports_agents },
    builder: { tier: 'standard', model_hint: null, isolated_context: capabilities.supports_agents },
    reviewer: { tier: 'independent_context', model_hint: null, isolated_context: true },
    learning_curator: { tier: 'lightweight', model_hint: null, isolated_context: capabilities.supports_agents },
  };
  const cfg = roleDefaults[role] ?? roleDefaults.builder;
  const activeTier = options.tier ?? cfg.tier;
  const modelHint = !singleModel && options.modelTiers && Object.hasOwn(options.modelTiers, activeTier)
    ? options.modelTiers[activeTier]
    : cfg.model_hint;

  return {
    role,
    host: 'codex',
    status: 'AVAILABLE',
    execution_mode: sequentialOnly ? 'sequential_single_model' : (cfg.isolated_context ? 'native_agent' : 'codex_exec'),
    tier: activeTier,
    model_hint: modelHint,
    isolated_context: cfg.isolated_context,
    independent_cross_model_review: 'UNVERIFIED',
    limitations: sequentialOnly ? ['single_model_or_sequential_fallback'] : [],
  };
}

/**
 * Prepare or execute a Codex-native task dispatch via `codex exec`.
 * @param {{ prompt: string, role?: string, cwd?: string, model?: string|null }} taskSpec
 * @param {{ execute?: boolean, runner?: Function, env?: NodeJS.ProcessEnv, resolve?: Function, capabilities?: object }} [options]
 */
export function dispatch(taskSpec, options = {}) {
  const caps = options.capabilities ?? discoverCapabilities(options);
  if (caps.status !== 'AVAILABLE' || !caps.supports_exec) {
    return {
      host: 'codex',
      status: 'UNAVAILABLE',
      executed: false,
      command: null,
      args: [],
      error: 'Cannot dispatch: Codex CLI or `codex exec` is UNAVAILABLE',
    };
  }

  const args = ['exec'];
  if (taskSpec.model && caps.supports_model_flag) {
    args.push('--model', taskSpec.model);
  }
  args.push(taskSpec.prompt);

  if (!options.execute) {
    return {
      host: 'codex',
      status: 'PREPARED',
      executed: false,
      command: 'codex',
      args,
    };
  }

  const res = runCommand('codex', args, {
    cwd: taskSpec.cwd,
    timeoutMs: options.timeoutMs,
    env: options.env,
    runner: options.runner,
    resolve: options.resolve,
  });

  return {
    host: 'codex',
    status: res.exitCode === 0 ? 'EXECUTED' : 'FAILED',
    executed: true,
    command: 'codex',
    args,
    exitCode: res.exitCode,
    stdout: res.stdout,
    stderr: res.stderr,
    durationMs: res.durationMs,
  };
}

/**
 * Normalize a Codex dispatch result without fabricating missing success or usage metrics.
 * @param {ReturnType<typeof dispatch>} dispatchResult
 */
export function collectResult(dispatchResult) {
  if (!dispatchResult || dispatchResult.status === 'UNAVAILABLE') {
    return { status: 'UNAVAILABLE', output: null, usage: observeUsage(null) };
  }
  if (!dispatchResult.executed) {
    return { status: dispatchResult.status, output: null, usage: observeUsage(null) };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(dispatchResult.stdout);
  } catch {
    parsed = null;
  }
  return {
    status: dispatchResult.exitCode === 0 ? 'OK' : 'FAILED',
    exitCode: dispatchResult.exitCode,
    output: parsed?.output ?? dispatchResult.stdout,
    raw: parsed,
    usage: observeUsage(parsed),
  };
}

/**
 * Human acceptance cannot be performed by the model; return explicit human CLI boundary.
 */
export function requestApproval(requestSpec) {
  return {
    host: 'codex',
    supported_for_auto_accept: false,
    requires_explicit_human_cli: true,
    run_id: requestSpec?.run_id ?? null,
    command: `node scripts/approval.mjs record --run-id ${requestSpec?.run_id ?? '<run-id>'} --decision accept --actor <name> --rationale "<reason>"`,
  };
}

/**
 * Extract observed token usage if explicitly present, or return `"unknown"`.
 * @param {unknown} rawOutput
 */
export function observeUsage(rawOutput) {
  if (!rawOutput || typeof rawOutput !== 'object' || !rawOutput.usage) {
    return {
      status: 'unknown',
      input_tokens: 'unknown',
      output_tokens: 'unknown',
      cache_tokens: 'unknown',
      cost_usd: 'unknown',
    };
  }
  const u = rawOutput.usage;
  return {
    status: 'measured',
    input_tokens: typeof u.input_tokens === 'number' ? u.input_tokens : 'unknown',
    output_tokens: typeof u.output_tokens === 'number' ? u.output_tokens : 'unknown',
    cache_tokens: typeof u.cached_input_tokens === 'number' ? u.cached_input_tokens : 'unknown',
    cost_usd: 'unknown',
  };
}

/**
 * Capture host environment snapshot for checkpoint/audit records.
 * @param {string} repoRoot
 * @param {object} [options]
 */
export function captureSessionContext(repoRoot, options = {}) {
  const caps = options.capabilities ?? discoverCapabilities(options);
  return {
    host: 'codex',
    cli_version: caps.cli_version,
    status: caps.status,
    git_head: isGitRepo(repoRoot) ? getGitHead(repoRoot) : 'NO_GIT',
    kouetsu_status: caps.kouetsu.status,
    captured_at: new Date().toISOString(),
  };
}
