import fs from 'node:fs';
import path from 'node:path';
import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import { sha256CanonicalJson } from './lib/crypto.mjs';
import { classifyApprovalChannel } from './lib/human-gate.mjs';
import { LITE_ELIGIBLE_CHANGE_KINDS, isLiteContract, liteExemptsE2eByContract } from './lib/lite-profile.mjs';
import { composeMethodologyPlan } from './lib/methodology.mjs';
import { assertValidSchema, validateAgainstSchema } from './lib/schema.mjs';

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
    const hasE2e = acceptance.some((ac) => ac && ac.kind === 'e2e');
    if (!hasE2e) {
      warnings.push({
        code: 'E2E_MISSING',
        message: 'Functional feature/bugfix contract requires at least one e2e acceptance check; verify will fail with E2E_MISSING unless added or require_e2e_for_functional is false.',
        guidance: 'Add an acceptance item with kind: "e2e" (or pass --e2e-cmd "<command>" during interview).',
      });
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
  if (!actor || !String(actor).trim()) {
    throw new Error('Explicit --actor is required to approve an execution contract.');
  }
  const absPath = path.resolve(contractPath);
  const contract = JSON.parse(fs.readFileSync(absPath, 'utf8'));
  assertValidSchema('execution', contract, absPath);

  const readiness = checkContractReadiness(contract);
  if (options.strictReadiness && !readiness.policy_ready) {
    const details = readiness.warnings.map((w) => `${w.code}: ${w.message}`).join('; ');
    throw new Error(`CONTRACT_POLICY_NOT_READY: ${details}`);
  }

  contract.approval = {
    ...contract.approval,
    contract_approved: true,
    contract_approved_by: String(actor).trim(),
    contract_approved_at: new Date().toISOString(),
    contract_approved_via: options.channel ?? 'programmatic',
  };

  assertValidSchema('execution', contract, absPath);
  fs.writeFileSync(absPath, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');

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

function printUsage() {
  process.stdout.write(
    [
      'CraftHelm Contract CLI (Validate Schema & Policy Readiness, Plan, Approve)',
      '',
      'Usage:',
      '  contract.mjs validate <contractPath>',
      '  contract.mjs plan     <contractPath>',
      '  contract.mjs approve  <contractPath> --actor <name> [--strict] [--init-run [--repo <path>] [--run-id <id>]]',
      '',
      '  --init-run   After approval, also freeze the run baseline (checkpoint init). Implies --strict.',
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
  const target = args.contract ?? args._[1];

  try {
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
    } else if (subcommand === 'plan') {
      const res = planFromContract(target);
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else if (subcommand === 'approve') {
      const res = approveContractFile(target, args.actor, {
        strictReadiness: Boolean(args.strict) || Boolean(args['init-run']),
        channel: classifyApprovalChannel(),
      });
      for (const w of res.warnings ?? []) {
        process.stderr.write(`[warning] ${w.code}: ${w.message}\n`);
      }
      if (args['init-run']) {
        const { initCheckpoint } = await import('./checkpoint.mjs');
        const cp = initCheckpoint({
          repo: typeof args.repo === 'string' ? args.repo : '.',
          contract: res.contract_path,
          runId: typeof args['run-id'] === 'string' ? args['run-id'] : undefined,
        });
        res.run = { run_id: cp.run_id, initialized: true, state: cp.state, baseline_git_head: cp.baseline_git_head };
        res.next_command = `node scripts/crafthelm.mjs feedback --repo ${typeof args.repo === 'string' ? args.repo : '.'} --run-id ${cp.run_id} --selective`;
      }
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else {
      throw new Error('Usage: contract.mjs <validate|plan|approve> <contractPath> [--actor <name>]');
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
