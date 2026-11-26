import fs from 'node:fs';
import path from 'node:path';
import { recordRepairRound } from './checkpoint.mjs';
import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import { runShellCommand } from './lib/exec.mjs';
import { routeTask } from './lib/model-router.mjs';
import { CRAFTHELM_ROOT, getCheckpointPath, getContractPath, getRunDir, toPosixPath } from './lib/paths.mjs';
import { STATES } from './lib/state-machine.mjs';
import { publishReviewPackage } from './review-package.mjs';
import { runVerify } from './verify.mjs';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadRepoConfig(repoRoot) {
  const cfgPath = path.join(repoRoot, '.crafthelm', 'config.json');
  if (!fs.existsSync(cfgPath)) return {};
  try {
    return readJson(cfgPath);
  } catch {
    return {};
  }
}

/**
 * Execute CraftHelm's bounded automated verification -> AI feedback -> repair -> human approval request loop.
 * - On verification PASS: publishes Kouetsu-checked Review Package (`READY_FOR_HUMAN_REVIEW`) and returns explicit approval request (never creates `approvals/decision.json`).
 * - On verification FAIL: generates `evidence/feedback-packet.json`, routes next repair tier (`standard` -> `reasoning` on retry >= 2), and enforces the 3-round human escalation limit.
 * @param {object} options
 */
export async function runFeedbackLoop(options = {}) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const runId = options.runId;
  if (!runId) {
    throw new Error('runFeedbackLoop requires --run-id');
  }

  const runDir = getRunDir(repoRoot, runId);
  const checkpointPath = getCheckpointPath(repoRoot, runId);
  const initialCp = readJson(checkpointPath);
  const contractPath = options.contract ? path.resolve(options.contract) : getContractPath(repoRoot, initialCp.task_id);
  const contract = readJson(contractPath);
  const repoConfig = loadRepoConfig(repoRoot);
  const effectiveRepairCmd = options.repairCmd ?? repoConfig.feedback_loop?.repair_command ?? null;
  const approvalScriptPosix = toPosixPath(path.join(CRAFTHELM_ROOT, 'scripts', 'approval.mjs'));
  const maxRounds = Math.min(3, options.maxRounds ?? contract.budgets?.max_worker_retries_per_cause ?? 3);

  if (initialCp.state === STATES.BLOCKED_HUMAN_ATTENTION) {
    return {
      ok: false,
      status: 'ESCALATED_HUMAN_ATTENTION',
      error_code: 'REPAIR_LIMIT_EXCEEDED',
      state: STATES.BLOCKED_HUMAN_ATTENTION,
      rounds_executed: 0,
      escalation_file: initialCp.escalation?.escalation_file ?? 'evidence/escalation.json',
      history: [],
    };
  }

  const history = [];
  const maxIterations = maxRounds + 1;

  for (let attempt = 0; attempt < maxIterations; attempt++) {
    const verifyRes = runVerify({
      repo: repoRoot,
      runId,
      contract: contractPath,
      writer: options.writer,
      selective: Boolean(options.selective),
      mutationProbe: Boolean(options.mutationProbe),
      reviewFile: options.reviewFile,
      policyDir: options.policyDir,
    });

    if (verifyRes.ok) {
      if (options.publishOnPass === false) {
        return {
          ok: true,
          status: 'CONVERGED',
          state: STATES.VERIFYING,
          rounds_executed: history.length,
          verify_result: verifyRes,
          history,
        };
      }

      const pkg = publishReviewPackage({
        repo: repoRoot,
        runId,
        contract: contractPath,
        writer: options.writer,
        preset: options.preset,
        kouetsuRoot: options.kouetsuRoot,
        homeDir: options.homeDir,
      });

      if (!pkg.ok) {
        return {
          ok: false,
          status: 'REVIEW_PACKAGE_BLOCKED',
          error_code: pkg.error_code,
          rounds_executed: history.length,
          verify_result: verifyRes,
          review_package: pkg,
          history,
        };
      }

      return {
        ok: true,
        status: 'READY_FOR_HUMAN_APPROVAL',
        state: pkg.state,
        rounds_executed: history.length,
        verify_result: verifyRes,
        review_package: pkg,
        approval_request: {
          state: pkg.state,
          auto_approved: false,
          review_package_file: pkg.report_file,
          report_sha256: pkg.report_sha256,
          target_snapshot_digest: pkg.target_snapshot_digest,
          approval_command: `node "${approvalScriptPosix}" record --repo "${toPosixPath(repoRoot)}" --run-id "${runId}" --decision accept --actor <name> --rationale "<reason>"`,
        },
        history,
      };
    }

    const packetRel = verifyRes.feedback_packet_file ?? 'evidence/feedback-packet.json';
    const packetAbs = path.join(runDir, packetRel);
    const feedbackPacket = fs.existsSync(packetAbs)
      ? readJson(packetAbs)
      : {
          root_cause_category: 'TEST_FAILURE',
          failed_checks: [],
          impacted_functions: [],
          impacted_classes: [],
          impacted_features: [],
        };

    const causeId = options.causeId ?? feedbackPacket.root_cause_category ?? 'TEST_FAILURE';
    const currentCp = readJson(checkpointPath);
    const nextRoundNumber = (currentCp.repair_rounds?.[causeId] ?? 0) + 1;
    const impactRel = verifyRes.impact_analysis_file ?? 'evidence/impact-analysis.json';
    const impactAbs = path.join(runDir, impactRel);
    const impactReport = fs.existsSync(impactAbs) ? readJson(impactAbs) : null;
    const impactedFilesCount = impactReport?.impacted_files?.length ?? 0;

    const routeDecision = routeTask(
      {
        task_type: 'repair',
        retry_round: nextRoundNumber,
        impacted_files_count: impactedFilesCount,
        host: contract.host,
      },
      {
        host: contract.host,
        contract,
        repoRoot,
        capabilities: options.capabilities,
        inSession: Boolean(options.inSession ?? contract.host_config?.in_session),
        singleModel: Boolean(options.singleModel),
      },
    );

    const firstFailed = feedbackPacket.failed_checks?.[0];
    const repairRecord = recordRepairRound({
      repo: repoRoot,
      runId,
      contract: contractPath,
      cause: causeId,
      check: firstFailed?.id ?? 'unknown',
      command: contract.acceptance.find((a) => a.id === firstFailed?.id)?.command ?? 'not_provided',
      note: `Round ${nextRoundNumber} feedback (${routeDecision.tier}): ${verifyRes.failure_reasons.join('; ')}`,
    });

    history.push({
      attempt: attempt + 1,
      cause_id: causeId,
      round_recorded: repairRecord.rounds_attempted,
      escalated: Boolean(repairRecord.escalated),
      recommended_tier: routeDecision.tier,
      model_hint: routeDecision.model_hint,
      feedback_packet_file: packetRel,
      failure_reasons: verifyRes.failure_reasons,
    });

    if (repairRecord.escalated || repairRecord.error_code === 'REPAIR_LIMIT_EXCEEDED' || repairRecord.error_code === 'BLOCKED_HUMAN_ATTENTION') {
      return {
        ok: false,
        status: 'ESCALATED_HUMAN_ATTENTION',
        error_code: 'BLOCKED_HUMAN_ATTENTION',
        state: STATES.BLOCKED_HUMAN_ATTENTION,
        rounds_executed: history.length,
        escalation_file: repairRecord.escalation_file ?? 'evidence/escalation.json',
        feedback_packet_file: packetRel,
        history,
      };
    }

    if (typeof options.onRepair === 'function') {
      await options.onRepair(feedbackPacket, routeDecision, repairRecord);
    } else if (effectiveRepairCmd) {
      const cmdRes = runShellCommand(effectiveRepairCmd, {
        cwd: repoRoot,
        env: {
          ...process.env,
          CRAFTHELM_HOST: routeDecision.host,
          CRAFTHELM_EXECUTION_MODE: routeDecision.execution_mode,
          CRAFTHELM_RECOMMENDED_ROLE: routeDecision.recommended_role,
          CRAFTHELM_RUN_ID: runId,
          CRAFTHELM_REPO: repoRoot,
          CRAFTHELM_IMPACT_FILE: impactAbs,
          CRAFTHELM_CAUSE_ID: causeId,
          CRAFTHELM_FEEDBACK_PACKET: packetAbs,
          CRAFTHELM_RECOMMENDED_TIER: routeDecision.tier,
          CRAFTHELM_MODEL_HINT: routeDecision.model_hint ?? '',
          CRAFTHELM_REPAIR_ROUND: String(repairRecord.rounds_attempted),
        },
      });
      if (cmdRes.exitCode !== 0) {
        return {
          ok: false,
          status: 'REPAIR_COMMAND_FAILED',
          error_code: 'REPAIR_HOOK_FAILED',
          exit_code: cmdRes.exitCode,
          stderr: cmdRes.stderr,
          rounds_executed: history.length,
          history,
        };
      }
    } else {
      return {
        ok: false,
        status: 'REPAIR_REQUIRED',
        error_code: 'NO_REPAIR_HANDLER_PROVIDED',
        rounds_executed: history.length,
        recommended_tier: routeDecision.tier,
        model_hint: routeDecision.model_hint,
        route_decision: routeDecision,
        impact_analysis_file: impactRel,
        feedback_packet_file: packetRel,
        history,
      };
    }
  }

  return {
    ok: false,
    status: 'ESCALATED_HUMAN_ATTENTION',
    error_code: 'BLOCKED_HUMAN_ATTENTION',
    state: STATES.BLOCKED_HUMAN_ATTENTION,
    rounds_executed: history.length,
    history,
  };
}

function printUsage() {
  process.stdout.write(
    [
      'CraftHelm Feedback Loop CLI (Bounded Verify -> Feedback -> Repair -> READY_FOR_HUMAN_REVIEW)',
      '',
      'Usage: feedback-loop.mjs --repo <path> --run-id <id> [--contract <path>] [--selective] [--repair-cmd "<cmd>"] [--cause <id>] [--preset <name>] [--kouetsu-root <path>] [--no-publish]',
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
  runFeedbackLoop({
    repo: args.repo,
    runId: args['run-id'],
    contract: args.contract,
    selective: Boolean(args.selective),
    mutationProbe: Boolean(args['mutation-probe']),
    writer: typeof args.writer === 'string' ? args.writer : undefined,
    publishOnPass: !args['no-publish'],
    repairCmd: args['repair-cmd'],
    causeId: args.cause,
    preset: args.preset,
    kouetsuRoot: args['kouetsu-root'],
  })
    .then((res) => {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      if (!res.ok) process.exit(1);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}
