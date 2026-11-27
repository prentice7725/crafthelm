import { requirementsWithoutAcceptance } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import { sha256CanonicalJson, sha256File, sha256Text } from './lib/crypto.mjs';
import { cliInvocation, getContractPath, unsupportedGlobSyntax } from './lib/paths.mjs';
import { readTaskReceipt, withTaskWrite, writeAtomic, writeTaskReceipt } from './lib/task-artifacts.mjs';
import { classifyApprovalChannel } from './lib/human-gate.mjs';
import { LITE_ELIGIBLE_CHANGE_KINDS, isLiteContract, liteExemptsE2eByContract } from './lib/lite-profile.mjs';
import { composeMethodologyPlan } from './lib/methodology.mjs';
import { assertValidSchema, validateAgainstSchema } from './lib/schema.mjs';

// Executable test kinds that can stand for "a test written for this change" (not e2e, not manual).
const TARGETED_TEST_KINDS = new Set(['unit', 'fast', 'property', 'differential']);

function normalizeCommand(command) {
  return String(command ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * Evaluate execution policy readiness (beyond schema validity), such as functional E2E requirements.
 * @param {object} contract
 * @returns {{ policy_ready: boolean, warnings: Array<{ code: string, message: string, guidance: string }> }}
 */
export function checkContractReadiness(contract) {
  const warnings = [];
  const changeKind = contract?.change_kind ?? 'feature';
  if (isLiteContract(contract) && !LITE_ELIGIBLE_CHANGE_KINDS.includes(changeKind)) {
    warnings.push({
      code: 'LITE_PROFILE_NOT_ELIGIBLE',
      message: `process_profile "lite" is only available for change_kind ${LITE_ELIGIBLE_CHANGE_KINDS.join(', ')}; this contract is "${changeKind}".`,
      guidance: 'Remove process_profile (or set it to "full"), or re-plan the task as a bugfix if that is what it is.',
    });
  }
  // A lite bugfix may run without E2E; verify re-checks the size and evidence conditions on the real diff.
  const requiresE2e =
    (changeKind === 'feature' || changeKind === 'bugfix' || !contract?.change_kind) &&
    contract?.verification_policy?.require_e2e_for_functional !== false &&
    !liteExemptsE2eByContract(contract);

  if (requiresE2e) {
    const acceptance = Array.isArray(contract?.acceptance) ? contract.acceptance : [];
    const hasE2e = acceptance.some((ac) => ac?.kind === 'e2e' && ac.applicable !== false);
    if (!hasE2e) {
      warnings.push({
        code: 'E2E_MISSING',
        message: 'Functional feature/bugfix contract requires at least one e2e acceptance check; verify will fail with E2E_MISSING unless added or require_e2e_for_functional is false.',
        guidance: 'Add an acceptance item with kind: "e2e" (or pass --e2e-cmd "<command>" during interview).',
      });
    }
  }

  // Without E2E, a lite run stands on its tailored test. A lone umbrella command (kind "test") is
  // graded SINGLE_GENERIC_CHECK (weak) by verify, which always revokes the exemption: say so before approval.
  if (liteExemptsE2eByContract(contract)) {
    const acceptance = (Array.isArray(contract?.acceptance) ? contract.acceptance : []).filter((ac) => ac && ac.applicable !== false);
    const umbrella = new Set(acceptance.filter((ac) => ac.kind === 'test').map((ac) => normalizeCommand(ac.command)));
    // Only an executed test counts, and re-listing the umbrella command under another kind does not.
    const hasTargeted = acceptance.some((ac) => TARGETED_TEST_KINDS.has(ac.kind) && !umbrella.has(normalizeCommand(ac.command)));
    if (!hasTargeted) {
      warnings.push({
        code: 'LITE_TARGETED_TEST_MISSING',
        message: 'A lite contract without E2E needs an executed test written for this change (kind unit, fast, property or differential, with a command other than the umbrella test command); a single umbrella test command is weak evidence, and verify will revoke the exemption (SINGLE_GENERIC_CHECK).',
        guidance: 'Add the command that runs the test for the changed code: contract add-test <contract> --test-cmd "<command>" (or pass --test-cmd to start).',
      });
    }
  }

  // A requirement nothing checks is approved and reviewed as if it were covered.
  const uncovered = requirementsWithoutAcceptance(contract);
  if (uncovered.length > 0) {
    warnings.push({
      code: 'REQUIREMENT_WITHOUT_ACCEPTANCE',
      message: `No acceptance check refers to ${uncovered.map((r) => r.id).join(', ')}; verify will report ${uncovered.length === 1 ? 'it' : 'them'} as unverified and the run will be PARTIAL, not VERIFIED.`,
      guidance: 'Add an acceptance item for each (kind "manual" with manual_method when it can only be checked by a person), or remove the requirement from this contract.',
    });
  }

  for (const ac of Array.isArray(contract?.acceptance) ? contract.acceptance : []) {
    for (const pattern of ac?.allowed_diffs ?? []) {
      try {
        new RegExp(pattern);
      } catch (err) {
        warnings.push({
          code: 'ALLOWED_DIFFS_INVALID_REGEX',
          message: `acceptance ${ac.id} allowed_diffs pattern "${pattern}" is not a valid regular expression (${err.message}); verify would fail that check.`,
          guidance: 'Fix the pattern, escaping characters that are meant literally.',
        });
      }
    }
  }

  // An unsupported pattern is matched literally and so matches nothing; in scope.protect that fails open.
  for (const list of ['allow', 'protect']) {
    for (const pattern of contract?.scope?.[list] ?? []) {
      const unsupported = unsupportedGlobSyntax(pattern);
      if (unsupported) {
        warnings.push({
          code: 'SCOPE_GLOB_UNSUPPORTED',
          message: `scope.${list} pattern "${pattern}" uses ${unsupported}, which CraftHelm globs do not support; it would match no file${list === 'protect' ? ' and protect nothing' : ''}.`,
          guidance: 'Use only **, * and ? (or a trailing "/" for a directory), and list each alternative as its own pattern.',
        });
      }
    }
  }

  return {
    policy_ready: warnings.length === 0,
    warnings,
  };
}

/**
 * Validate an execution contract JSON file against `execution.schema.json`.
 * @param {string} contractPath
 */
export function validateContractFile(contractPath) {
  const absPath = path.resolve(contractPath);
  const contract = JSON.parse(fs.readFileSync(absPath, 'utf8'));
  const result = validateAgainstSchema('execution', contract);
  const readiness = result.valid
    ? checkContractReadiness(contract)
    : { policy_ready: false, warnings: [] };
  return {
    valid: result.valid,
    errors: result.errors,
    policy_ready: readiness.policy_ready,
    warnings: readiness.warnings,
    contract_path: absPath,
    contract_sha256: sha256CanonicalJson(contract),
    contract,
  };
}

/**
 * Generate the 4-axis methodology plan for a contract file.
 * @param {string} contractPath
 */
export function planFromContract(contractPath) {
  const validated = validateContractFile(contractPath);
  if (!validated.valid) {
    throw new Error(`Invalid contract: ${validated.errors.join('; ')}`);
  }
  return {
    task_id: validated.contract.task_id,
    contract_sha256: validated.contract_sha256,
    plan: composeMethodologyPlan(validated.contract.methodology, validated.contract.change_kind ?? 'feature'),
  };
}

/**
 * Record explicit contract approval (authorizes execution only, NOT human final acceptance).
 * @param {string} contractPath
 * @param {string} actor
 * @param {{ strictReadiness?: boolean, channel?: 'programmatic'|'agent_session'|'interactive_terminal'|'non_interactive' }} [options]
 */
export function approveContractFile(contractPath, actor, options = {}) {
  return withContractWrite(contractPath, file => approveContract(file, actor, options));
}

function approveContract(absPath, actor, options) {
  if (!actor || !String(actor).trim()) {
    throw new Error('Explicit --actor is required to approve an execution contract.');
  }
  const contract = JSON.parse(fs.readFileSync(absPath, 'utf8'));
  assertValidSchema('execution', contract, absPath);

  const readiness = checkContractReadiness(contract);
  if (options.strictReadiness && !readiness.policy_ready) {
    const details = readiness.warnings.map((w) => `${w.code}: ${w.message}`).join('; ');
    throw new Error(`CONTRACT_POLICY_NOT_READY: ${details}`);
  }

  // Approving an approved contract again as the same actor is a no-op. Rewriting the time would
  // change the contract hash, and a run already opened on it would then demand a re-plan.
  const trimmedActor = String(actor).trim();
  const channel = options.channel ?? 'programmatic';
  if (contract.approval?.contract_approved === true && contract.approval.contract_approved_by === trimmedActor
    && (contract.approval.contract_approved_via ?? 'programmatic') === channel) {
    return {
      ok: true,
      already_approved: true,
      task_id: contract.task_id,
      contract_path: absPath,
      contract_sha256: sha256CanonicalJson(contract),
      approved_by: contract.approval.contract_approved_by,
      approved_at: contract.approval.contract_approved_at,
      approved_via: contract.approval.contract_approved_via ?? 'programmatic',
      policy_ready: readiness.policy_ready,
      warnings: readiness.warnings,
      note: 'This contract was already approved with this content; nothing was written. A changed request is not in it: rebuild the contract with interview --overwrite, or amend it with contract add-e2e / add-test, and approve the result.',
    };
  }

  contract.approval = {
    ...contract.approval,
    contract_approved: true,
    contract_approved_by: String(actor).trim(),
    contract_approved_at: new Date().toISOString(),
    contract_approved_via: options.channel ?? 'programmatic',
  };

  assertValidSchema('execution', contract, absPath);
  persistContract(absPath, contract);

  return {
    ok: true,
    task_id: contract.task_id,
    contract_path: absPath,
    contract_sha256: sha256CanonicalJson(contract),
    approved_by: contract.approval.contract_approved_by,
    approved_at: contract.approval.contract_approved_at,
    approved_via: contract.approval.contract_approved_via,
    policy_ready: readiness.policy_ready,
    warnings: readiness.warnings,
    note: 'Execution contract approved. Final human acceptance remains PENDING until human review.',
  };
}

function withContractWrite(contractPath, action) {
  const file = path.resolve(contractPath);
  const repo = path.resolve(path.dirname(file), '../..');
  const taskId = path.basename(file, '.json');
  if (getContractPath(repo, taskId) !== file) return action(file);
  return withTaskWrite(repo, taskId, () => action(file));
}

function persistContract(file, contract, updatedDocHash) {
  const text = `${JSON.stringify(contract, null, 2)}\n`;
  const repo = path.resolve(path.dirname(file), '../..');
  if (getContractPath(repo, contract.task_id) === file) {
    const receipt = readTaskReceipt(repo, contract.task_id);
    if (receipt) {
      // Approving or amending a manually edited contract does not turn the
      // pre-existing edits into generated output for a different task.
      if (receipt.contract === sha256File(file)) receipt.contract = sha256Text(text);
      if (updatedDocHash) receipt.docs['acceptance.md'] = updatedDocHash;
      writeTaskReceipt(repo, contract.task_id, receipt);
    }
  }
  writeAtomic(file, text);
}

function appendAcceptanceRow(file, taskId, ac, docsDir) {
  const repo = path.resolve(path.dirname(file), '../..');
  if (getContractPath(repo, taskId) !== file) return;
  const receipt = readTaskReceipt(repo, taskId);
  const preferredDir = docsDir ?? receipt?.docs_dir;
  const dirs = preferredDir !== undefined ? [preferredDir] : [`docs/tasks/${taskId}`, 'docs'];
  for (const dir of dirs) {
    const doc = path.join(repo, dir, 'acceptance.md');
    if (!fs.existsSync(doc)) continue;
    const old = fs.readFileSync(doc, 'utf8');
    const lines = old.split(/\r?\n/);
    if (lines[0] !== `# Acceptance Criteria — ${taskId}`) continue;
    const row = `| ${ac.id} | ${ac.requirement} | ${ac.kind} | \`${ac.command}\` | exit 0 |`;
    if (lines.includes(row)) {
      // Recover a previous interrupted append without claiming unrelated edits.
      lines.splice(lines.indexOf(row), 1);
      return receipt?.docs['acceptance.md'] === sha256Text(lines.join('\n')) ? sha256Text(old) : undefined;
    }
    let end = lines.findIndex(line => line.startsWith('| AC ID |'));
    if (end < 0) throw new Error(`Cannot locate the acceptance table in ${doc}.`);
    while (lines[end]?.startsWith('|')) end++;
    lines.splice(end, 0, row);
    const next = lines.join('\n');
    writeAtomic(doc, next);
    if (receipt?.docs['acceptance.md'] === sha256Text(old)) return sha256Text(next);
    return;
  }
}

/** Amend a saved contract without reconstructing it from onboarding defaults. */
export function addE2eCriterion(contractPath, command, options = {}) {
  if (typeof command !== 'string' || !command.trim()) throw new Error('A non-empty --e2e-cmd is required.');
  return withContractWrite(contractPath, file => amendCheck(file, 'e2e', command.trim(), options));
}

/** Add the test written for this change (kind "unit"), which a lite contract needs when it has no E2E. */
export function addTargetedTest(contractPath, command, options = {}) {
  if (typeof command !== 'string' || !command.trim()) throw new Error('A non-empty --test-cmd is required.');
  return withContractWrite(contractPath, file => amendCheck(file, 'unit', command.trim(), options));
}

function amendCheck(file, kind, command, options) {
  const contract = JSON.parse(fs.readFileSync(file, 'utf8'));
  assertValidSchema('execution', contract, file);
  if (kind === 'unit' && contract.acceptance.some((ac) => ac.kind === 'test' && normalizeCommand(ac.command) === normalizeCommand(command))) {
    throw new Error(`--test-cmd "${command}" is the umbrella test command already in the contract; give the command that runs the test for the changed code.`);
  }
  const existing = contract.acceptance.find(ac => ac.kind === kind && ac.applicable !== false && ac.command === command);
  if (!existing) {
    let n = 1;
    const ids = new Set(contract.acceptance.map(ac => ac.id));
    while (ids.has(`AC-${String(n).padStart(2, '0')}`)) n++;
    const ac = {
      id: `AC-${String(n).padStart(2, '0')}`, requirement: contract.acceptance[0].requirement,
      kind, command, expected_exit_code: 0,
      ...(options.timeoutMs !== undefined ? { timeout_ms: options.timeoutMs } : {}),
    };
    contract.acceptance.push(ac);
    contract.approval = { require_on: contract.approval.require_on, contract_approved: false };
    assertValidSchema('execution', contract, file);
    const updatedDocHash = appendAcceptanceRow(file, contract.task_id, ac, options.docsDir);
    persistContract(file, contract, updatedDocHash);
  }
  const readiness = checkContractReadiness(contract);
  const needsApproval = readiness.policy_ready && !contract.approval.contract_approved;
  const nextCommand = needsApproval
    ? `${cliInvocation()} contract approve "${file}" --actor operator`
    : `${cliInvocation()} contract validate "${file}"`;
  return {
    ok: true, contract_path: file, task_id: contract.task_id, ...readiness,
    next_command: nextCommand,
  };
}

function parseTimeoutMs(raw) {
  if (raw === undefined) return undefined;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < 1000) throw new Error(`--timeout-ms must be a whole number of milliseconds, at least 1000 (got "${raw}").`);
  return ms;
}

function printUsage() {
  process.stdout.write(
    [
      'CraftHelm Contract CLI (Validate Schema & Policy Readiness, Plan, Approve)',
      '',
      'Usage:',
      '  contract.mjs validate <contractPath>',
      '  contract.mjs plan     <contractPath>',
      '  contract.mjs add-e2e  <contractPath> --e2e-cmd "<command>" [--docs-dir <dir>]',
      '  contract.mjs add-test <contractPath> --test-cmd "<command>" [--docs-dir <dir>]   (test written for this change, kind "unit")',
      '  contract.mjs approve  <contractPath> --actor <name> [--strict] [--init-run [--repo <path>] [--run-id <id>] [--baseline-ref <commit>]]',
      '',
      '  --init-run   After approval, also freeze the run baseline (checkpoint init). Implies --strict.',
      '  --baseline-ref  With --init-run: start the run at an earlier commit, so work already committed is verified too.',
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
  const subcommand = args._[0];
  // The contract can be named by path or by task id (.crafthelm/contracts/<id>.json under --repo).
  const target = args.contract ?? args._[1]
    ?? (typeof args['task-id'] === 'string' ? getContractPath(path.resolve(typeof args.repo === 'string' ? args.repo : '.'), args['task-id']) : undefined);

  try {
    const known = ['validate', 'plan', 'add-e2e', 'add-test', 'approve'];
    if (known.includes(subcommand) && typeof target !== 'string') {
      throw new Error(`contract ${subcommand} needs the contract file: contract ${subcommand} <contractPath>${subcommand === 'approve' ? ' --actor <name> [--init-run --repo <path> --run-id <id>]' : ''} (or --task-id <id> with --repo <path>). Contracts live in .crafthelm/contracts/<task-id>.json.`);
    }
    if (known.includes(subcommand) && !fs.existsSync(target)) {
      throw new Error(`Contract not found at ${target}. Run "status --repo <path>" to list pending contracts.`);
    }
    if (subcommand === 'validate') {
      const res = validateContractFile(target);
      process.stdout.write(
        `${JSON.stringify(
          {
            valid: res.valid,
            errors: res.errors,
            policy_ready: res.policy_ready,
            warnings: res.warnings,
            contract_sha256: res.contract_sha256,
          },
          null,
          2,
        )}\n`,
      );
      process.exit(res.valid ? 0 : 1);
    } else if (subcommand === 'add-e2e') {
      const res = addE2eCriterion(target, args['e2e-cmd'], { docsDir: args['docs-dir'], timeoutMs: parseTimeoutMs(args['timeout-ms']) });
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else if (subcommand === 'add-test') {
      const res = addTargetedTest(target, args['test-cmd'], { docsDir: args['docs-dir'], timeoutMs: parseTimeoutMs(args['timeout-ms']) });
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else if (subcommand === 'plan') {
      const res = planFromContract(target);
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else if (subcommand === 'approve') {
      const channel = classifyApprovalChannel();
      const approve = () => approveContractFile(target, args.actor, {
        strictReadiness: Boolean(args.strict) || Boolean(args['init-run']),
        channel,
      });
      let res;
      if (args['init-run']) {
        const { withNewRun } = await import('./checkpoint.mjs');
        const repo = typeof args.repo === 'string' ? args.repo : '.';
        const runId = typeof args['run-id'] === 'string' ? args['run-id'] : `${validateContractFile(target).contract.task_id}-RUN-001`;
        res = withNewRun(repo, runId, initialize => {
          const result = approve();
          const cp = initialize({ contract: result.contract_path, baselineRef: typeof args['baseline-ref'] === 'string' ? args['baseline-ref'] : undefined });
          result.run = { run_id: cp.run_id, initialized: true, state: cp.state, baseline_git_head: cp.baseline_git_head };
          result.next_command = `${cliInvocation()} feedback --repo "${repo}" --run-id ${cp.run_id} --selective`;
          return result;
        });
      } else {
        res = approve();
      }
      for (const w of res.warnings ?? []) process.stderr.write(`[warning] ${w.code}: ${w.message}\n`);
      if (res.already_approved) {
        process.stderr.write(`[notice] Contract ${res.task_id} was already approved by "${res.approved_by}" at ${res.approved_at}, and its content is the same; nothing was written. If the request changed, this contract does not contain the change.\n`);
      } else if (channel === 'agent_session') {
        // The name in --actor is whatever the caller typed; say plainly what the record will show.
        process.stderr.write(`[notice] This approval ran inside an AI agent session. It is recorded as contract_approved_via "agent_session" with actor "${String(args.actor).trim()}", and the review package shows that. Use a person's name only if that person approved this contract in the conversation.\n`);
      }
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else {
      throw new Error('Usage: contract.mjs <validate|plan|add-e2e|add-test|approve> <contractPath> [options]');
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
