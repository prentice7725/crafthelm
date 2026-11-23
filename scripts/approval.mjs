import fs from 'node:fs';
import path from 'node:path';
import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import { sha256CanonicalJson, sha256File } from './lib/crypto.mjs';
import { computeSnapshotDigest } from './lib/git.mjs';
import {
  getApprovalDecisionPath,
  getApprovalHistoryPath,
  getCheckpointPath,
  getContractPath,
  getEvidenceManifestPath,
  getReviewPackagePath,
  getVerificationStampPath,
} from './lib/paths.mjs';
import { assertValidSchema } from './lib/schema.mjs';
import { STATES, assertTransition } from './lib/state-machine.mjs';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

const DECISION_MAP = {
  accept: 'accepted',
  accepted: 'accepted',
  'changes-requested': 'changes_requested',
  changes_requested: 'changes_requested',
  reject: 'rejected',
  rejected: 'rejected',
  'request-verification': 'verification_requested',
  verification_requested: 'verification_requested',
};

/**
 * Record an explicit human review decision (`accepted`, `changes_requested`, `rejected`, `verification_requested`).
 * Verifies current state is READY_FOR_HUMAN_REVIEW and all artifact digests match current disk/snapshot state.
 */
export function recordHumanDecision(options) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const runId = options.runId;
  const normalizedDecision = DECISION_MAP[String(options.decision ?? '').toLowerCase()];
  if (!normalizedDecision) {
    throw new Error(`Invalid --decision "${options.decision}". Expected accept, changes-requested, reject, or request-verification.`);
  }
  if (!options.actor || !String(options.actor).trim()) {
    throw new Error('Explicit --actor is required to record a human acceptance decision.');
  }
  if (!options.rationale || !String(options.rationale).trim()) {
    throw new Error('Explicit --rationale is required to record a human acceptance decision.');
  }

  const checkpointPath = getCheckpointPath(repoRoot, runId);
  const checkpoint = readJson(checkpointPath);
  if (checkpoint.state !== STATES.READY_FOR_HUMAN_REVIEW) {
    throw new Error(`ACCOUNTABILITY_BLOCK: Run state is ${checkpoint.state}; human decision requires READY_FOR_HUMAN_REVIEW.`);
  }

  const contract = readJson(options.contract ? path.resolve(options.contract) : getContractPath(repoRoot, checkpoint.task_id));
  const contractSha = sha256CanonicalJson(contract);
  const manifestPath = getEvidenceManifestPath(repoRoot, runId);
  const reportPath = getReviewPackagePath(repoRoot, runId);
  const stampPath = getVerificationStampPath(repoRoot, runId);

  if (!fs.existsSync(manifestPath) || !fs.existsSync(reportPath) || !fs.existsSync(stampPath)) {
    throw new Error('MISSING_ARTIFACTS: Cannot record human decision without evidence manifest, verification stamp, and review package.');
  }

  const manifest = readJson(manifestPath);
  const stamp = readJson(stampPath);
  const reportSha = sha256File(reportPath);
  const currentSnapshot = computeSnapshotDigest(repoRoot);

  // H03 / E14: Block approval if snapshot or report changed since READY_FOR_HUMAN_REVIEW
  if (currentSnapshot !== stamp.target_snapshot_digest || currentSnapshot !== checkpoint.target_snapshot_digest) {
    throw new Error('STALE_SNAPSHOT: Code snapshot changed after review package generation; re-verify and re-publish before approving.');
  }
  if (reportSha !== manifest.human_review?.package_sha256) {
    throw new Error('STALE_REPORT: review-package.md was modified after verification; re-publish before approving.');
  }
  if (contractSha !== checkpoint.contract_sha256) {
    throw new Error('CONTRACT_MISMATCH: execution contract changed without replan.');
  }

  const nextStateMap = {
    accepted: STATES.ACCEPTED,
    changes_requested: STATES.CHANGES_REQUESTED,
    rejected: STATES.REJECTED,
    verification_requested: STATES.VERIFYING,
  };
  const targetState = nextStateMap[normalizedDecision];
  const actor = String(options.actor).trim();
  assertTransition(checkpoint.state, targetState, {
    humanDecision: { decision: normalizedDecision, actor },
  });

  const manifestHumanStatus = {
    accepted: 'ACCEPTED',
    changes_requested: 'CHANGES_REQUESTED',
    rejected: 'REJECTED',
    verification_requested: 'PENDING',
  }[normalizedDecision];
  manifest.human_review.status = manifestHumanStatus;
  writeJson(manifestPath, manifest);

  stamp.human_acceptance = {
    accepted: 'ACCEPTED',
    changes_requested: 'CHANGES_REQUESTED',
    rejected: 'REJECTED',
    verification_requested: 'VERIFICATION_REQUESTED',
  }[normalizedDecision];
  writeJson(stampPath, stamp);

  const finalManifestSha = sha256File(manifestPath);
  const record = {
    schema_version: '0.2',
    run_id: runId,
    task_id: contract.task_id,
    contract_sha256: contractSha,
    report_sha256: reportSha,
    evidence_manifest_sha256: finalManifestSha,
    target_snapshot_digest: currentSnapshot,
    decision: normalizedDecision,
    actor,
    recorded_at: new Date().toISOString(),
    rationale: String(options.rationale).trim(),
    accepted_risks: Array.isArray(options.acceptedRisks) ? options.acceptedRisks : [],
    ...(Array.isArray(options.relatedRequirements) && options.relatedRequirements.length > 0
      ? { related_requirements: options.relatedRequirements }
      : {}),
    ...(options.reproConditions ? { repro_conditions: String(options.reproConditions) } : {}),
    verification_type: 'local_explicit_input_not_identity_verified',
  };

  assertValidSchema('human-decision', record, `human-decision ${runId}`);

  const decisionPath = getApprovalDecisionPath(repoRoot, runId);
  writeJson(decisionPath, record);

  const historyPath = getApprovalHistoryPath(repoRoot, runId);
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.appendFileSync(historyPath, `${JSON.stringify(record)}\n`, 'utf8');

  checkpoint.state = targetState;
  checkpoint.current_stage = 'human_acceptance';
  checkpoint.last_decision_file = 'approvals/decision.json';
  checkpoint.updated_at = record.recorded_at;
  assertValidSchema('checkpoint', checkpoint, `checkpoint ${runId}`);
  writeJson(checkpointPath, checkpoint);

  return {
    ok: true,
    run_id: runId,
    decision: normalizedDecision,
    state: targetState,
    decision_file: 'approvals/decision.json',
    target_snapshot_digest: currentSnapshot,
    report_sha256: reportSha,
    verification_type: record.verification_type,
  };
}

/**
 * Re-verify whether an existing human approval decision still applies to current artifacts (`H03` / `E14`).
 */
export function verifyHumanDecision(options) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const runId = options.runId;
  const decisionPath = getApprovalDecisionPath(repoRoot, runId);

  if (!fs.existsSync(decisionPath)) {
    return {
      valid: false,
      status: 'NO_DECISION_RECORD',
      mismatches: ['approvals/decision.json does not exist'],
    };
  }

  const decision = readJson(decisionPath);
  assertValidSchema('human-decision', decision, decisionPath);

  const contract = readJson(options.contract ? path.resolve(options.contract) : getContractPath(repoRoot, decision.task_id));
  const currentContractSha = sha256CanonicalJson(contract);
  const currentSnapshot = computeSnapshotDigest(repoRoot);
  const reportPath = getReviewPackagePath(repoRoot, runId);
  const manifestPath = getEvidenceManifestPath(repoRoot, runId);

  const mismatches = [];
  if (decision.contract_sha256 !== currentContractSha) {
    mismatches.push('contract_sha256 changed after decision');
  }
  if (decision.target_snapshot_digest !== currentSnapshot) {
    mismatches.push('target_snapshot_digest changed after decision');
  }
  if (!fs.existsSync(reportPath) || sha256File(reportPath) !== decision.report_sha256) {
    mismatches.push('report_sha256 changed after decision');
  }
  if (!fs.existsSync(manifestPath) || sha256File(manifestPath) !== decision.evidence_manifest_sha256) {
    mismatches.push('evidence_manifest_sha256 changed after decision');
  }

  if (mismatches.length > 0) {
    return {
      valid: false,
      status: 'INVALIDATED',
      decision: decision.decision,
      mismatches,
    };
  }

  return {
    valid: true,
    status: 'VALID',
    decision: decision.decision,
    actor: decision.actor,
    recorded_at: decision.recorded_at,
    mismatches: [],
  };
}

function printUsage() {
  process.stdout.write(
    [
      'CraftHelm Human Approval CLI (Explicit Human Acceptance Decision Record & Verification)',
      '',
      'Usage:',
      '  approval.mjs record --repo <path> --run-id <id> --decision <ACCEPTED|CHANGES_REQUESTED|REJECTED|NEED_MORE_EVIDENCE> --actor <name> [--rationale "<text>"] [--contract <path>]',
      '  approval.mjs verify --repo <path> --run-id <id> [--contract <path>]',
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
  const args = parseArgs(argv, {
    multiFlags: ['accepted-risk', 'related-req'],
  });
  const sub = args._[0];
  try {
    if (sub === 'record') {
      const res = recordHumanDecision({
        repo: args.repo,
        runId: args['run-id'],
        contract: args.contract,
        decision: args.decision,
        actor: args.actor,
        rationale: args.rationale,
        acceptedRisks: args['accepted-risk'],
        relatedRequirements: args['related-req'],
        reproConditions: args.repro,
      });
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else if (sub === 'verify') {
      const res = verifyHumanDecision({
        repo: args.repo,
        runId: args['run-id'],
        contract: args.contract,
      });
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      process.exit(res.valid ? 0 : 1);
    } else {
      throw new Error('Usage: approval.mjs <record|verify> --repo <path> --run-id <id> ...');
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
