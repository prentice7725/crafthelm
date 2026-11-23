import { resolveExecutable, runCommand } from '../../scripts/lib/exec.mjs';
import { getGitHead, isGitRepo } from '../../scripts/lib/git.mjs';
import { verifyKouetsuAsset } from '../../scripts/lib/kouetsu-check.mjs';

export const HOST_ID = 'generic';

/**
 * Create a universal single-provider host adapter for either:
 * 1) an active AI IDE/chat session (`host_native_session` when no `cli_command` is configured), or
 * 2) any user-configured CLI agent (`hostConfig.cli_command` / `options.cliCommand`).
 * Never invokes vendor-specific CLIs (`claude`, `codex`, `agy`) implicitly.
 * @param {string} [hostId]
 * @param {{ cli_command?: string, version_args?: string[], help_args?: string[], exec_args?: string[], model_flag?: string, supports_json?: boolean, in_session?: boolean }} [hostConfig]
 */
export function createGenericAdapter(hostId = 'generic', hostConfig = {}) {
  const cleanHostId = String(hostId || 'generic').trim().toLowerCase();

  function discoverCapabilities(options = {}) {
    const cliCommand = options.cliCommand ?? hostConfig.cli_command ?? null;
    const execOpts = { env: options.env, runner: options.runner, resolve: options.resolve };
    const kouetsu = verifyKouetsuAsset(cleanHostId, {
      homeDir: options.homeDir,
      kouetsuRoot: options.kouetsuRoot,
      repoRoot: options.repoRoot,
    });

    const limitations = [];
    if (!kouetsu.found) limitations.push('kouetsu_package_missing');
    if (kouetsu.status === 'TAMPERED') limitations.push('kouetsu_digest_mismatch');

    if (cliCommand) {
      const versionArgs = hostConfig.version_args ?? ['--version'];
      const helpArgs = hostConfig.help_args ?? ['--help'];
      const resolved = resolveExecutable(cliCommand, execOpts);
      const versionRes = resolved.found || options.runner
        ? runCommand(cliCommand, versionArgs, execOpts)
        : { exitCode: 127, stdout: '', stderr: `${cliCommand} CLI not found`, resolvedPath: null };

      const available = versionRes.exitCode === 0 && Boolean(versionRes.stdout.trim());
      let helpText = '';
      if (available) {
        const helpRes = runCommand(cliCommand, helpArgs, execOpts);
        helpText = `${helpRes.stdout}\n${helpRes.stderr}`;
      }
      if (!available) limitations.push('custom_cli_unavailable');
      if (options.singleModel) limitations.push('single_model_mode_forced');

      const supportsModelFlag = Boolean(
        available && (hostConfig.model_flag ? helpText.includes(hostConfig.model_flag) : /--model\b/.test(helpText)),
      );
      return {
        host: cleanHostId,
        status: available ? 'AVAILABLE' : 'UNAVAILABLE',
        execution_mode: available ? 'custom_cli' : 'UNAVAILABLE',
        cli_found: available,
        cli_command: cliCommand,
        cli_path: versionRes.resolvedPath ?? resolved.path ?? null,
        cli_version: available ? versionRes.stdout.trim().split(/\r?\n/)[0] : null,
        in_session: Boolean(hostConfig.in_session ?? options.inSession),
        supports_subagents: false,
        supports_model_flag: supportsModelFlag,
        supports_multi_model: available && supportsModelFlag && !options.singleModel,
        cross_provider_isolation: `${cleanHostId}_only`,
        independent_cross_model_review: 'UNAVAILABLE_SINGLE_PROVIDER',
        kouetsu,
        limitations,
      };
    }

    const supportsMultiModel = Boolean(hostConfig.supports_multi_model) && !options.singleModel;
    if (options.singleModel) limitations.push('single_model_mode_forced');
    limitations.push('in_session_host_only_no_worker_cli');
    return {
      host: cleanHostId,
      status: 'AVAILABLE',
      execution_mode: 'host_native_session',
      cli_found: false,
      cli_command: null,
      cli_path: null,
      cli_version: null,
      in_session: true,
      supports_subagents: false,
      supports_model_flag: false,
      supports_multi_model: supportsMultiModel,
      cross_provider_isolation: `${cleanHostId}_only`,
      independent_cross_model_review: 'UNAVAILABLE_SINGLE_PROVIDER',
      kouetsu,
      limitations,
    };
  }

  function selectWorker(role, capabilities, options = {}) {
    if (role === 'verifier' || options.tier === 'deterministic') {
      return {
        role,
        host: cleanHostId,
        execution_mode: 'deterministic_script',
        model_hint: null,
        status: 'AVAILABLE',
        independent_verification: 'DETERMINISTIC',
      };
    }
    if (!capabilities || capabilities.status !== 'AVAILABLE') {
      return {
        role,
        host: cleanHostId,
        execution_mode: 'UNAVAILABLE',
        model_hint: null,
        status: 'UNAVAILABLE',
        reason: `Configured CLI "${capabilities?.cli_command ?? cleanHostId}" is unavailable`,
      };
    }

    if (capabilities.execution_mode === 'host_native_session') {
      const activeTier = options.tier ?? (role === 'lead' ? 'primary' : 'session_context');
      const modelHint = capabilities.supports_multi_model && options.modelTiers && Object.hasOwn(options.modelTiers, activeTier)
        ? options.modelTiers[activeTier]
        : null;
      return {
        role,
        host: cleanHostId,
        status: 'AVAILABLE',
        execution_mode: 'host_native_session',
        tier: activeTier,
        model_hint: modelHint,
        isolated_context: role === 'reviewer',
        independent_cross_model_review: 'UNVERIFIED',
        limitations: ['in_session_host_only_no_worker_cli'],
      };
    }

    const singleModel = !capabilities.supports_multi_model;
    const activeTier = options.tier ?? (role === 'lead' ? 'primary' : 'standard');
    const modelHint = !singleModel && options.modelTiers && Object.hasOwn(options.modelTiers, activeTier)
      ? options.modelTiers[activeTier]
      : null;
    return {
      role,
      host: cleanHostId,
      status: 'AVAILABLE',
      execution_mode: singleModel ? 'sequential_single_model' : 'custom_cli',
      tier: activeTier,
      model_hint: modelHint,
      isolated_context: role === 'reviewer',
      independent_cross_model_review: 'UNVERIFIED',
      limitations: singleModel ? ['single_model_environment'] : [],
    };
  }

  function dispatch(taskSpec, options = {}) {
    const caps = options.capabilities ?? discoverCapabilities(options);
    if (caps.status !== 'AVAILABLE') {
      return {
        host: cleanHostId,
        status: 'UNAVAILABLE',
        executed: false,
        command: null,
        args: [],
        error: `Cannot dispatch: host "${cleanHostId}" is UNAVAILABLE`,
      };
    }

    if (caps.execution_mode === 'host_native_session' || !caps.cli_command) {
      return {
        host: cleanHostId,
        status: 'HOST_SESSION_DELEGATION_REQUIRED',
        executed: false,
        execution_mode: 'host_native_session',
        command: null,
        args: [],
        prompt: taskSpec.prompt,
        note: 'Execute step directly in the active host session or subagent; CLI execution is deterministic.',
      };
    }

    const args = [...(hostConfig.exec_args ?? [])];
    if (taskSpec.model && caps.supports_model_flag) {
      args.push(hostConfig.model_flag ?? '--model', taskSpec.model);
    }
    args.push(taskSpec.prompt);

    if (!options.execute) {
      return {
        host: cleanHostId,
        status: 'PREPARED',
        executed: false,
        command: caps.cli_command,
        args,
      };
    }

    const res = runCommand(caps.cli_command, args, {
      cwd: taskSpec.cwd,
      timeoutMs: options.timeoutMs,
      env: options.env,
      runner: options.runner,
      resolve: options.resolve,
    });

    return {
      host: cleanHostId,
      status: res.exitCode === 0 ? 'EXECUTED' : 'FAILED',
      executed: true,
      command: caps.cli_command,
      args,
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      durationMs: res.durationMs,
    };
  }

  function collectResult(dispatchResult) {
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

  function requestApproval(requestSpec) {
    return {
      host: cleanHostId,
      supported_for_auto_accept: false,
      requires_explicit_human_cli: true,
      run_id: requestSpec?.run_id ?? null,
      command: `node scripts/approval.mjs record --run-id ${requestSpec?.run_id ?? '<run-id>'} --decision accept --actor <name> --rationale "<reason>"`,
    };
  }

  function observeUsage(rawOutput) {
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

  function captureSessionContext(repoRoot, options = {}) {
    const caps = options.capabilities ?? discoverCapabilities({ ...options, repoRoot });
    return {
      host: cleanHostId,
      cli_version: caps.cli_version,
      execution_mode: caps.execution_mode,
      status: caps.status,
      git_head: isGitRepo(repoRoot) ? getGitHead(repoRoot) : 'NO_GIT',
      kouetsu_status: caps.kouetsu.status,
      captured_at: new Date().toISOString(),
    };
  }

  return {
    HOST_ID: cleanHostId,
    discoverCapabilities,
    selectWorker,
    dispatch,
    collectResult,
    requestApproval,
    observeUsage,
    captureSessionContext,
  };
}

const defaultGeneric = createGenericAdapter('generic');

export const discoverCapabilities = defaultGeneric.discoverCapabilities;
export const selectWorker = defaultGeneric.selectWorker;
export const dispatch = defaultGeneric.dispatch;
export const collectResult = defaultGeneric.collectResult;
export const requestApproval = defaultGeneric.requestApproval;
export const observeUsage = defaultGeneric.observeUsage;
export const captureSessionContext = defaultGeneric.captureSessionContext;
