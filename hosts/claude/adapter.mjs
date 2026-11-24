import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveExecutable, runCommand } from '../../scripts/lib/exec.mjs';
import { getGitHead, isGitRepo } from '../../scripts/lib/git.mjs';
import { verifyKouetsuAsset } from '../../scripts/lib/kouetsu-check.mjs';

/**
 * Claude Code Native Host Adapter (Claude-only; never invokes Codex or external providers).
 */
export const HOST_ID = 'claude';

/**
 * Probe installed Claude Code CLI capabilities without invoking any other provider CLI.
 * @param {{ env?: NodeJS.ProcessEnv, runner?: Function, resolve?: Function, homeDir?: string, singleModel?: boolean, kouetsuRoot?: string }} [options]
 */
export function discoverCapabilities(options = {}) {
  const execOpts = { env: options.env, runner: options.runner, resolve: options.resolve };
  const resolved = resolveExecutable('claude', execOpts);
  const versionRes = resolved.found || options.runner
    ? runCommand('claude', ['--version'], execOpts)
    : { exitCode: 127, stdout: '', stderr: 'claude CLI not found', resolvedPath: null };

  const available = versionRes.exitCode === 0 && Boolean(versionRes.stdout.trim());
  let helpText = '';
  if (available) {
    const helpRes = runCommand('claude', ['--help'], execOpts);
    helpText = `${helpRes.stdout}\n${helpRes.stderr}`;
  }

  const homeDir = options.homeDir ?? os.homedir();
  const claudeDirExists = fs.existsSync(path.join(homeDir, '.claude'));
  const kouetsu = verifyKouetsuAsset('claude', {
    homeDir,
    kouetsuRoot: options.kouetsuRoot,
  });

  const supportsSubagents = available && /--agents\b/.test(helpText);
  const supportsPrintJson = available && /--output-format\b/.test(helpText) && /--print\b|-p\b/.test(helpText);
  const supportsModelFlag = available && /--model\b/.test(helpText);
  const supportsPermissionMode = available && /--permission-mode\b/.test(helpText);
  const supportsMultiModel = available && supportsModelFlag && !options.singleModel;

  const limitations = [];
  if (!available) limitations.push('claude_cli_unavailable');
  if (!supportsSubagents) limitations.push('native_subagents_unavailable');
  if (options.singleModel) limitations.push('single_model_mode_forced');
  if (!kouetsu.found) limitations.push('kouetsu_plugin_missing');
  if (kouetsu.status === 'TAMPERED') limitations.push('kouetsu_digest_mismatch');

  return {
    host: 'claude',
    status: available ? 'AVAILABLE' : 'UNAVAILABLE',
    cli_found: available,
    cli_path: versionRes.resolvedPath ?? resolved.path ?? null,
    cli_version: available ? versionRes.stdout.trim().split(/\r?\n/)[0] : null,
    claude_dir_present: claudeDirExists,
    supports_subagents: supportsSubagents,
    supports_print_json: supportsPrintJson,
    supports_model_flag: supportsModelFlag,
    supports_permission_mode: supportsPermissionMode,
    supports_multi_model: supportsMultiModel,
    cross_provider_isolation: 'claude_only',
    independent_cross_model_review: 'UNAVAILABLE_SINGLE_PROVIDER',
    kouetsu,
    limitations,
  };
}

/**
 * Select worker execution mode for a CraftHelm role on Claude Code.
 * @param {'lead'|'explorer'|'planner'|'builder'|'reviewer'|'verifier'|'learning_curator'} role
 * @param {ReturnType<typeof discoverCapabilities>} capabilities
 */
export function selectWorker(role, capabilities, options = {}) {
  if (role === 'verifier' || options.tier === 'deterministic') {
    return {
      role,
      host: 'claude',
      execution_mode: 'deterministic_script',
      model_hint: null,
      status: 'AVAILABLE',
      independent_verification: 'DETERMINISTIC',
    };
  }
  if (!capabilities || capabilities.status !== 'AVAILABLE') {
    return {
      role,
      host: 'claude',
      execution_mode: 'UNAVAILABLE',
      model_hint: null,
      status: 'UNAVAILABLE',
      reason: 'Claude CLI is not available on this host',
    };
  }

  const singleModel = !capabilities.supports_multi_model;
  const roleDefaults = {
    lead: { tier: 'reasoning', model_hint: singleModel ? null : 'opus', isolated_context: false },
    explorer: { tier: 'lightweight', model_hint: singleModel ? null : 'haiku', isolated_context: capabilities.supports_subagents },
    planner: { tier: 'standard', model_hint: singleModel ? null : 'sonnet', isolated_context: capabilities.supports_subagents },
    builder: { tier: 'standard', model_hint: singleModel ? null : 'sonnet', isolated_context: capabilities.supports_subagents },
    reviewer: { tier: 'independent_context', model_hint: singleModel ? null : 'sonnet', isolated_context: true },
    learning_curator: { tier: 'lightweight', model_hint: singleModel ? null : 'haiku', isolated_context: capabilities.supports_subagents },
  };
  const cfg = roleDefaults[role] ?? roleDefaults.builder;
  const activeTier = options.tier ?? cfg.tier;
  const tierDefaultHint = activeTier === 'lightweight' ? 'haiku' : activeTier === 'reasoning' ? 'opus' : activeTier === 'standard' ? 'sonnet' : cfg.model_hint;
  const modelHint = singleModel
    ? null
    : (options.modelTiers && Object.hasOwn(options.modelTiers, activeTier)
      ? options.modelTiers[activeTier]
      : (options.tier ? tierDefaultHint : (role === 'lead' ? null : cfg.model_hint)));

  return {
    role,
    host: 'claude',
    status: 'AVAILABLE',
    execution_mode: singleModel ? 'sequential_single_model' : (cfg.isolated_context ? 'native_subagent' : 'native_session'),
    tier: role === 'lead' && !options.tier ? 'primary' : activeTier,
    model_hint: modelHint,
    isolated_context: cfg.isolated_context,
    independent_cross_model_review: 'UNVERIFIED',
    limitations: singleModel ? ['single_model_environment'] : [],
  };
}

/**
 * Prepare or execute a Claude-native task dispatch.
 * @param {{ prompt: string, role?: string, cwd?: string, model?: string|null, permissionMode?: string, allowedTools?: string[] }} taskSpec
 * @param {{ execute?: boolean, runner?: Function, env?: NodeJS.ProcessEnv, resolve?: Function, capabilities?: object }} [options]
 */
export function dispatch(taskSpec, options = {}) {
  const caps = options.capabilities ?? discoverCapabilities(options);
  if (caps.status !== 'AVAILABLE') {
    return {
      host: 'claude',
      status: 'UNAVAILABLE',
      executed: false,
      command: null,
      args: [],
      error: 'Cannot dispatch: Claude CLI is UNAVAILABLE',
    };
  }

  const args = ['-p', '--output-format', 'json'];
  if (taskSpec.model && caps.supports_model_flag) {
    args.push('--model', taskSpec.model);
  }
  if (taskSpec.permissionMode && caps.supports_permission_mode) {
    args.push('--permission-mode', taskSpec.permissionMode);
  }
  if (Array.isArray(taskSpec.allowedTools) && taskSpec.allowedTools.length > 0) {
    args.push('--allowedTools', taskSpec.allowedTools.join(','));
  }
  args.push(taskSpec.prompt);

  if (!options.execute) {
    return {
      host: 'claude',
      status: 'PREPARED',
      executed: false,
      command: 'claude',
      args,
    };
  }

  const res = runCommand('claude', args, {
    cwd: taskSpec.cwd,
    timeoutMs: options.timeoutMs,
    env: options.env,
    runner: options.runner,
    resolve: options.resolve,
  });

  return {
    host: 'claude',
    status: res.exitCode === 0 ? 'EXECUTED' : 'FAILED',
    executed: true,
    command: 'claude',
    args,
    exitCode: res.exitCode,
    stdout: res.stdout,
    stderr: res.stderr,
    durationMs: res.durationMs,
  };
}

/**
 * Normalize a Claude dispatch result without fabricating missing success or usage metrics.
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
    output: parsed?.result ?? dispatchResult.stdout,
    raw: parsed,
    usage: observeUsage(parsed),
  };
}

/**
 * Human acceptance cannot be performed by the model; return explicit human CLI boundary.
 */
export function requestApproval(requestSpec) {
  return {
    host: 'claude',
    supported_for_auto_accept: false,
    requires_explicit_human_cli: true,
    run_id: requestSpec?.run_id ?? null,
    command: `node scripts/approval.mjs record --run-id ${requestSpec?.run_id ?? '<run-id>'} --decision accept --actor <name> --rationale "<reason>"`,
  };
}

/**
 * Extract actual observed token usage from Claude JSON output, or return `"unknown"`.
 * Never estimates or fabricates token counts.
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
    // `input_tokens` excludes cached prompt tokens, which dominate a Claude Code call; report both cache sides.
    cache_tokens: typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 'unknown',
    cache_creation_tokens: typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 'unknown',
    cost_usd: typeof rawOutput.total_cost_usd === 'number' ? rawOutput.total_cost_usd : 'unknown',
    // Models the CLI actually billed, so "host default" runs show what really ran.
    models_used: rawOutput.modelUsage && typeof rawOutput.modelUsage === 'object' ? Object.keys(rawOutput.modelUsage).sort() : [],
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
    host: 'claude',
    cli_version: caps.cli_version,
    status: caps.status,
    git_head: isGitRepo(repoRoot) ? getGitHead(repoRoot) : 'NO_GIT',
    kouetsu_status: caps.kouetsu.status,
    captured_at: new Date().toISOString(),
  };
}
