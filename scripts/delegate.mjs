import fs from 'node:fs';
import path from 'node:path';
import { getHostAdapter } from '../hosts/registry.mjs';
import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import { sha256Text } from './lib/crypto.mjs';
import { routeTask } from './lib/model-router.mjs';
import { getCheckpointPath, getContractPath, getRunDir } from './lib/paths.mjs';
import { assertValidSchema } from './lib/schema.mjs';

/**
 * Delegation records: make "who actually did the work, on which model tier" an observed fact.
 *
 * Routing used to be advice only: `route` printed a tier hint and nothing checked whether the host
 * followed it. Two paths now leave a record under `.crafthelm/runs/<run>/delegations/`:
 * - `run`: a CLI host is dispatched through its adapter and the record carries measured usage (`observed`).
 * - `record`: an in-session host (native subagents) cannot be launched by a script, so the lead files the
 *   worker's result packet; the record is marked `self_reported`.
 * A run with no record is reported as `UNOBSERVED`, never as delegated.
 */

// Worker runs outlast the 60s default of the command runner.
const DEFAULT_WORKER_TIMEOUT_MS = 15 * 60_000;

const VALID_ROLES = ['explorer', 'planner', 'builder', 'reviewer', 'learning_curator'];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getDelegationsDir(repoRoot, runId) {
  return path.join(getRunDir(repoRoot, runId), 'delegations');
}

function nextSequence(dir) {
  if (!fs.existsSync(dir)) return 1;
  const nums = fs.readdirSync(dir)
    .map((f) => /^D(\d+)\.json$/.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  return (nums.length > 0 ? Math.max(...nums) : 0) + 1;
}

function loadRunContext(repoRoot, runId, contractPathOverride) {
  const checkpointPath = getCheckpointPath(repoRoot, runId);
  if (!fs.existsSync(checkpointPath)) {
    throw new Error(`RUN_NOT_FOUND: no checkpoint for run "${runId}".`);
  }
  const checkpoint = readJson(checkpointPath);
  const contract = readJson(contractPathOverride ? path.resolve(contractPathOverride) : getContractPath(repoRoot, checkpoint.task_id));
  return { checkpoint, contract };
}

function allocateDelegationId(repoRoot, runId) {
  const dir = getDelegationsDir(repoRoot, runId);
  fs.mkdirSync(dir, { recursive: true });
  return `D${String(nextSequence(dir)).padStart(3, '0')}`;
}

function writeRecord(repoRoot, runId, record) {
  assertValidSchema('delegation-record', record, `delegation-record ${record.delegation_id}`);
  const rel = `delegations/${record.delegation_id}.json`;
  fs.writeFileSync(path.join(getRunDir(repoRoot, runId), rel), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return { record, file: rel };
}

/**
 * Route a task, dispatch it through the active host adapter, and record what actually ran.
 * Without `execute` the dispatch is only prepared and nothing is recorded.
 * @param {{ repo?: string, runId: string, role: string, taskType?: string, prompt: string, execute?: boolean, contract?: string, retryRound?: number, permissionMode?: string, allowedTools?: string[], timeoutMs?: number, runner?: Function, resolve?: Function, env?: NodeJS.ProcessEnv, capabilities?: object }} options
 */
export function runDelegation(options) {
  const repoRoot = path.resolve(options.repo ?? '.');
  if (!VALID_ROLES.includes(options.role)) {
    throw new Error(`Invalid --role "${options.role}". Expected one of: ${VALID_ROLES.join(', ')}.`);
  }
  if (!options.prompt || !String(options.prompt).trim()) {
    throw new Error('Delegation requires a non-empty prompt (--prompt or --prompt-file).');
  }
  const { contract } = loadRunContext(repoRoot, options.runId, options.contract);
  const { hostId, adapter } = getHostAdapter(contract.host, { hostConfig: contract.host_config ?? {} });
  const execOpts = { runner: options.runner, resolve: options.resolve, env: options.env };
  const capabilities = options.capabilities ?? adapter.discoverCapabilities({ ...execOpts, repoRoot });

  const route = routeTask(
    { task_type: options.taskType ?? 'implement', retry_round: options.retryRound ?? 0, host: hostId },
    { host: hostId, contract, repoRoot, capabilities, ...execOpts },
  );

  const dispatched = adapter.dispatch(
    {
      prompt: String(options.prompt),
      role: options.role,
      cwd: repoRoot,
      model: route.model_hint,
      permissionMode: options.permissionMode,
      allowedTools: options.allowedTools,
    },
    { ...execOpts, execute: Boolean(options.execute), capabilities, timeoutMs: options.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS },
  );

  if (!dispatched.executed) {
    return {
      ok: dispatched.status === 'PREPARED',
      status: dispatched.status,
      recorded: false,
      host: hostId,
      role: options.role,
      tier: route.tier,
      model_hint: route.model_hint,
      command: dispatched.command,
      args: dispatched.args,
      error: dispatched.error ?? null,
      note: dispatched.status === 'PREPARED'
        ? 'Dispatch prepared only. Re-run with --execute to run the worker and record the delegation.'
        : 'Host cannot be dispatched from a script. For in-session subagents, file the worker result with `delegate record`.',
    };
  }

  const result = adapter.collectResult(dispatched);
  const delegationId = allocateDelegationId(repoRoot, options.runId);
  // Keep the worker's raw output out of the lead's context: store it, return only a reference.
  const outRel = `delegations/${delegationId}.output.txt`;
  fs.writeFileSync(
    path.join(getRunDir(repoRoot, options.runId), outRel),
    typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? null, null, 2),
    'utf8',
  );
  const { record, file } = writeRecord(repoRoot, options.runId, {
    schema_version: '0.3',
    delegation_id: delegationId,
    run_id: options.runId,
    task_id: contract.task_id,
    observation: 'observed',
    host: hostId,
    role: options.role,
    task_type: options.taskType ?? 'implement',
    tier: route.tier,
    model_requested: route.model_hint ?? null,
    degraded_to_single_model: Boolean(route.degraded_to_single_model),
    status: result.status === 'OK' ? 'OK' : 'FAILED',
    exit_code: dispatched.exitCode ?? null,
    duration_ms: dispatched.durationMs ?? null,
    prompt_sha256: sha256Text(String(options.prompt)),
    usage: result.usage,
    output_file: outRel,
    recorded_at: new Date().toISOString(),
  });

  return {
    ok: record.status === 'OK',
    status: record.status,
    recorded: true,
    delegation_id: record.delegation_id,
    record_file: file,
    output_file: outRel,
    host: hostId,
    role: record.role,
    tier: record.tier,
    model_requested: record.model_requested,
    usage: record.usage,
  };
}

/**
 * File a worker result packet produced by an in-session subagent (Lead Context Contract).
 * The packet is schema-validated; the record is marked `self_reported` because no script observed the run.
 * @param {{ repo?: string, runId: string, role: string, taskType?: string, packet?: object, packetPath?: string, model?: string, contract?: string }} options
 */
export function recordWorkerResult(options) {
  const repoRoot = path.resolve(options.repo ?? '.');
  if (!VALID_ROLES.includes(options.role)) {
    throw new Error(`Invalid --role "${options.role}". Expected one of: ${VALID_ROLES.join(', ')}.`);
  }
  const { contract } = loadRunContext(repoRoot, options.runId, options.contract);
  const packet = options.packet ?? readJson(path.resolve(options.packetPath));
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
    throw new Error('WORKER_PACKET_INVALID: worker result packet must be a JSON object.');
  }

  const route = routeTask(
    { task_type: options.taskType ?? 'implement', host: contract.host },
    { host: contract.host, contract, repoRoot, capabilities: { status: 'AVAILABLE', supports_multi_model: Boolean(options.model) } },
  );

  const draft = {
    schema_version: '0.3',
    delegation_id: 'D000',
    run_id: options.runId,
    task_id: contract.task_id,
    observation: 'self_reported',
    host: route.host,
    role: options.role,
    task_type: options.taskType ?? 'implement',
    tier: route.tier,
    model_requested: options.model ?? null,
    degraded_to_single_model: !options.model,
    status: packet.status === 'completed' ? 'OK' : 'FAILED',
    exit_code: null,
    duration_ms: null,
    prompt_sha256: null,
    usage: { status: 'unknown', input_tokens: 'unknown', output_tokens: 'unknown', cache_tokens: 'unknown', cost_usd: 'unknown' },
    output_file: null,
    worker_result: packet,
    recorded_at: new Date().toISOString(),
  };
  // Validate the packet (Lead Context Contract) before anything is written.
  assertValidSchema('delegation-record', draft, 'worker result packet');
  if (packet.task_id !== contract.task_id) {
    throw new Error(`WORKER_PACKET_TASK_MISMATCH: packet task_id "${packet.task_id}" does not match run task "${contract.task_id}".`);
  }
  const { record, file } = writeRecord(repoRoot, options.runId, {
    ...draft,
    delegation_id: allocateDelegationId(repoRoot, options.runId),
  });

  return {
    ok: true,
    recorded: true,
    delegation_id: record.delegation_id,
    record_file: file,
    observation: record.observation,
    scope_violation: packet.scope_violation,
    decision_needed: packet.decision_needed ?? null,
  };
}

/**
 * Summarize delegation records for a run. No record means `UNOBSERVED`, not "delegated".
 * @param {string} repoRoot
 * @param {string} runId
 */
export function summarizeDelegations(repoRoot, runId) {
  const dir = getDelegationsDir(path.resolve(repoRoot), runId);
  const records = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /^D\d+\.json$/.test(f)).sort().map((f) => readJson(path.join(dir, f)))
    : [];
  const observed = records.filter((r) => r.observation === 'observed');
  const status = records.length === 0
    ? 'UNOBSERVED'
    : observed.length === records.length
      ? 'OBSERVED'
      : observed.length > 0
        ? 'MIXED'
        : 'SELF_REPORTED';
  const sumMeasured = (field) => {
    const values = observed.map((r) => r.usage?.[field]).filter((v) => typeof v === 'number');
    return values.length === observed.length && values.length > 0 ? values.reduce((a, b) => a + b, 0) : 'unknown';
  };
  return {
    status,
    record_count: records.length,
    observed_count: observed.length,
    self_reported_count: records.length - observed.length,
    roles: [...new Set(records.map((r) => r.role))].sort(),
    tiers: [...new Set(records.map((r) => r.tier))].sort(),
    models_requested: [...new Set(records.map((r) => r.model_requested).filter(Boolean))].sort(),
    failed_count: records.filter((r) => r.status !== 'OK').length,
    measured_input_tokens: sumMeasured('input_tokens'),
    measured_output_tokens: sumMeasured('output_tokens'),
    measured_cost_usd: sumMeasured('cost_usd'),
  };
}

function printUsage() {
  process.stdout.write(
    [
      'CraftHelm Delegate CLI (Dispatch Workers Through the Host Adapter & Record What Ran)',
      '',
      'Usage:',
      '  delegate.mjs run    --repo <path> --run-id <id> --role <explorer|planner|builder|reviewer|learning_curator>',
      '                      [--task-type <type>] (--prompt "<text>" | --prompt-file <path>) [--execute]',
      '                      [--permission-mode <mode>] [--allowed-tools a,b] [--retry-round <n>] [--timeout-ms <n>]',
      '  delegate.mjs record --repo <path> --run-id <id> --role <role> --packet <worker-result.json> [--task-type <type>] [--model <name>]',
      '  delegate.mjs status --repo <path> --run-id <id>',
      '',
      '  run     Routes the task to a model tier and dispatches it on the active host only. Without --execute it prints',
      '          the prepared command and records nothing. With --execute it records measured usage (observed).',
      '  record  Files a worker result packet from an in-session subagent (self_reported; usage stays "unknown").',
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
  const sub = args._[0];
  try {
    let out;
    if (sub === 'run') {
      const prompt = typeof args['prompt-file'] === 'string'
        ? fs.readFileSync(path.resolve(args['prompt-file']), 'utf8')
        : args.prompt;
      out = runDelegation({
        repo: args.repo,
        runId: args['run-id'],
        role: args.role,
        taskType: args['task-type'],
        prompt,
        execute: Boolean(args.execute),
        contract: args.contract,
        retryRound: args['retry-round'] ? Number(args['retry-round']) : 0,
        permissionMode: args['permission-mode'],
        allowedTools: typeof args['allowed-tools'] === 'string' ? args['allowed-tools'].split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        timeoutMs: args['timeout-ms'] ? Number(args['timeout-ms']) : undefined,
      });
    } else if (sub === 'record') {
      out = recordWorkerResult({
        repo: args.repo,
        runId: args['run-id'],
        role: args.role,
        taskType: args['task-type'],
        packetPath: args.packet,
        model: typeof args.model === 'string' ? args.model : undefined,
        contract: args.contract,
      });
    } else if (sub === 'status') {
      out = summarizeDelegations(path.resolve(args.repo ?? '.'), args['run-id']);
    } else {
      throw new Error('Usage: delegate.mjs <run|record|status> --repo <path> --run-id <id> ...');
    }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (out.ok === false) process.exit(1);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
