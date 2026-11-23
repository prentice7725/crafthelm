import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveExecutable, runCommand } from '../../scripts/lib/exec.mjs';
import { getGitHead, isGitRepo } from '../../scripts/lib/git.mjs';
import { verifyKouetsuAsset } from '../../scripts/lib/kouetsu-check.mjs';

/**
 * Antigravity Native Host Adapter (Antigravity-only; never invokes Claude or Codex CLIs).
 */
export const HOST_ID = 'antigravity';

/**
 * Probe installed `agy` CLI capabilities or explicit in-session Antigravity host mode.
 * @param {{ env?: NodeJS.ProcessEnv, runner?: Function, resolve?: Function, homeDir?: string, singleModel?: boolean, kouetsuRoot?: string, repoRoot?: string, inSession?: boolean }} [options]
 */
export function discoverCapabilities(options = {}) {
  const execOpts = { env: options.env, runner: options.runner, resolve: options.resolve };
  const resolved = resolveExecutable('agy', execOpts);
  const versionRes = resolved.found || options.runner
    ? runCommand('agy', ['--version'], execOpts)
    : { exitCode: 127, stdout: '', stderr: 'agy CLI not found', resolvedPath: null };

  const cliAvailable = versionRes.exitCode === 0 && Boolean(versionRes.stdout.trim());
  let helpText = '';
  if (cliAvailable) {
    const helpRes = runCommand('agy', ['--help'], execOpts);
    helpText = `${helpRes.stdout}\n${helpRes.stderr}`;
  }

  const env = options.env ?? process.env;
  const inSession = Boolean(options.inSession || env.CRAFTHELM_IN_SESSION === '1');
  const homeDir = options.homeDir ?? os.homedir();
  const geminiConfigPresent = fs.existsSync(path.join(homeDir, '.gemini', 'config'));
  const kouetsu = verifyKouetsuAsset('antigravity', {
    homeDir,
    kouetsuRoot: options.kouetsuRoot,
    repoRoot: options.repoRoot,
  });

  const supportsSubagents = cliAvailable && (/--agent\b/.test(helpText) || /\bagents\b/.test(helpText));
  const supportsPrintJson = cliAvailable && /--output-format\b/.test(helpText) && /(?:--print|-p)\b/.test(helpText);
  const supportsModelFlag = cliAvailable && /--model\b/.test(helpText);
  const supportsEffortFlag = cliAvailable && /--effort\b/.test(helpText);
  const supportsModeFlag = cliAvailable && /--mode\b/.test(helpText);
  const supportsSandbox = cliAvailable && /--sandbox\b/.test(helpText);
  const supportsJsonSchema = cliAvailable && /--json-schema\b/.test(helpText);
  const supportsMultiModel = cliAvailable && supportsModelFlag && !options.singleModel;

  const available = cliAvailable || inSession;
  const limitations = [];
  if (!cliAvailable && inSession) {
    limitations.push('agy_cli_unavailable_using_host_session');
  } else if (!cliAvailable) {
    limitations.push('agy_cli_unavailable');
  }
  if (cliAvailable && !supportsSubagents) limitations.push('native_subagents_unavailable');
  if (options.singleModel) limitations.push('single_model_mode_forced');
  if (!kouetsu.found) limitations.push('kouetsu_package_missing');
  if (kouetsu.status === 'TAMPERED') limitations.push('kouetsu_digest_mismatch');

  return {
    host: 'antigravity',
    status: available ? 'AVAILABLE' : 'UNAVAILABLE',
    execution_mode: cliAvailable ? 'agy_cli' : (inSession ? 'host_native_session' : 'UNAVAILABLE'),
    cli_found: cliAvailable,
    in_session: inSession,
    cli_path: versionRes.resolvedPath ?? resolved.path ?? null,
    cli_version: cliAvailable ? versionRes.stdout.trim().split(/\r?\n/)[0] : null,
    gemini_config_present: geminiConfigPresent,
    supports_subagents: supportsSubagents || inSession,
    supports_print_json: supportsPrintJson,
    supports_model_flag: supportsModelFlag,
    supports_effort_flag: supportsEffortFlag,
    supports_mode_flag: supportsModeFlag,
    supports_sandbox: supportsSandbox,
    supports_json_schema: supportsJsonSchema,
    supports_multi_model: supportsMultiModel,
    cross_provider_isolation: 'antigravity_only',
    independent_cross_model_review: 'UNAVAILABLE_SINGLE_PROVIDER',
    kouetsu,
    limitations,
  };
}

/**
 * Select worker execution mode for a CraftHelm role on Antigravity.
 * @param {'lead'|'explorer'|'planner'|'builder'|'reviewer'|'verifier'|'learning_curator'} role
 * @param {ReturnType<typeof discoverCapabilities>} capabilities
 */
export function selectWorker(role, capabilities, options = {}) {
  if (role === 'verifier' || options.tier === 'deterministic') {
    return {
      role,
      host: 'antigravity',
      execution_mode: 'deterministic_script',
      model_hint: null,
      status: 'AVAILABLE',
      independent_verification: 'DETERMINISTIC',
    };
  }
  if (!capabilities || capabilities.status !== 'AVAILABLE') {
    return {
      role,
      host: 'antigravity',
      execution_mode: 'UNAVAILABLE',
      model_hint: null,
      status: 'UNAVAILABLE',
      reason: 'Antigravity `agy` CLI is unavailable and in-session mode is not active',
    };
  }

  if (!capabilities.cli_found && capabilities.in_session) {
    return {
      role,
      host: 'antigravity',
      status: 'AVAILABLE',
      execution_mode: 'host_native_session',
      tier: options.tier ?? (role === 'lead' ? 'primary' : 'in_session_subagent'),
      model_hint: null,
      isolated_context: role === 'reviewer' || role === 'explorer' || role === 'builder',
      independent_cross_model_review: 'UNVERIFIED',
      limitations: ['agy_cli_unavailable_using_host_session'],
    };
  }

  const singleModel = !capabilities.supports_multi_model;
  const roleDefaults = {
    lead: { tier: 'reasoning', model_hint: 'pro', isolated_context: false },
    explorer: { tier: 'lightweight', model_hint: 'flash_lite', isolated_context: capabilities.supports_subagents },
    planner: { tier: 'standard', model_hint: 'flash', isolated_context: capabilities.supports_subagents },
    builder: { tier: 'standard', model_hint: 'flash', isolated_context: capabilities.supports_subagents },
    reviewer: { tier: 'independent_context', model_hint: 'flash', isolated_context: true },
    learning_curator: { tier: 'lightweight', model_hint: 'flash_lite', isolated_context: capabilities.supports_subagents },
  };
  const cfg = roleDefaults[role] ?? roleDefaults.builder;
  const activeTier = options.tier ?? cfg.tier;
  const tierDefaultHint = activeTier === 'lightweight' ? 'flash_lite' : activeTier === 'reasoning' ? 'pro' : activeTier === 'standard' ? 'flash' : cfg.model_hint;
  const modelHint = singleModel
    ? null
    : (options.modelTiers && Object.hasOwn(options.modelTiers, activeTier)
      ? options.modelTiers[activeTier]
      : (options.tier ? tierDefaultHint : (role === 'lead' ? null : (role === 'explorer' || role === 'learning_curator' ? 'flash' : null))));

  return {
    role,
    host: 'antigravity',
    status: 'AVAILABLE',
    execution_mode: singleModel ? 'sequential_single_model' : (cfg.isolated_context ? 'native_subagent' : 'agy_cli'),
    tier: role === 'lead' && !options.tier ? 'primary' : activeTier,
    model_hint: modelHint,
    isolated_context: cfg.isolated_context,
    independent_cross_model_review: 'UNVERIFIED',
    limitations: singleModel ? ['single_model_environment'] : [],
  };
}

/**
 * Prepare or execute an Antigravity-native task dispatch via `agy -p`.
 * @param {{ prompt: string, role?: string, cwd?: string, model?: string|null, agent?: string, effort?: string, mode?: string, sandbox?: boolean }} taskSpec
 * @param {{ execute?: boolean, runner?: Function, env?: NodeJS.ProcessEnv, resolve?: Function, capabilities?: object }} [options]
 */
export function dispatch(taskSpec, options = {}) {
  const caps = options.capabilities ?? discoverCapabilities(options);
  if (caps.status !== 'AVAILABLE') {
    return {
      host: 'antigravity',
      status: 'UNAVAILABLE',
      executed: false,
      command: null,
      args: [],
      error: 'Cannot dispatch: Antigravity CLI is UNAVAILABLE',
    };
  }

  if (!caps.cli_found && caps.in_session) {
    return {
      host: 'antigravity',
      status: 'HOST_SESSION_DELEGATION_REQUIRED',
      executed: false,
      execution_mode: 'host_native_session',
      command: null,
      args: [],
      prompt: taskSpec.prompt,
      note: 'Execute inside active Antigravity host session via invoke_subagent or direct lead action',
    };
  }

  const args = ['-p'];
  if (caps.supports_print_json) {
    args.push('--output-format', 'json');
  }
  if (taskSpec.model && caps.supports_model_flag) {
    args.push('--model', taskSpec.model);
  }
  if (taskSpec.agent && caps.supports_subagents) {
    args.push('--agent', taskSpec.agent);
  }
  if (taskSpec.effort && caps.supports_effort_flag) {
    args.push('--effort', taskSpec.effort);
  }
  if (taskSpec.mode && caps.supports_mode_flag) {
    args.push('--mode', taskSpec.mode);
  }
  if (taskSpec.sandbox && caps.supports_sandbox) {
    args.push('--sandbox');
  }
  args.push(taskSpec.prompt);

  if (!options.execute) {
    return {
      host: 'antigravity',
      status: 'PREPARED',
      executed: false,
      command: 'agy',
      args,
    };
  }

  const res = runCommand('agy', args, {
    cwd: taskSpec.cwd,
    env: options.env,
    runner: options.runner,
    resolve: options.resolve,
  });

  return {
    host: 'antigravity',
    status: res.exitCode === 0 ? 'EXECUTED' : 'FAILED',
    executed: true,
    command: 'agy',
    args,
    exitCode: res.exitCode,
    stdout: res.stdout,
    stderr: res.stderr,
    durationMs: res.durationMs,
  };
}

/**
 * Normalize an Antigravity dispatch result without fabricating success or usage counts.
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
    output: parsed?.result ?? parsed?.output ?? dispatchResult.stdout,
    raw: parsed,
    usage: observeUsage(parsed),
  };
}

/**
 * Human acceptance cannot be performed by the model; return explicit human CLI boundary.
 */
export function requestApproval(requestSpec) {
  return {
    host: 'antigravity',
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
    cache_tokens: typeof u.cache_tokens === 'number' ? u.cache_tokens : 'unknown',
    cost_usd: typeof rawOutput.cost_usd === 'number' ? rawOutput.cost_usd : 'unknown',
  };
}

/**
 * Capture host environment snapshot for checkpoint/audit records.
 * @param {string} repoRoot
 * @param {object} [options]
 */
export function captureSessionContext(repoRoot, options = {}) {
  const caps = options.capabilities ?? discoverCapabilities({ ...options, repoRoot });
  return {
    host: 'antigravity',
    cli_version: caps.cli_version,
    execution_mode: caps.execution_mode,
    status: caps.status,
    git_head: isGitRepo(repoRoot) ? getGitHead(repoRoot) : 'NO_GIT',
    kouetsu_status: caps.kouetsu.status,
    captured_at: new Date().toISOString(),
  };
}
