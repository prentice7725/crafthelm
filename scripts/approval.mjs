import fs from 'node:fs';
import path from 'node:path';
import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import { sha256CanonicalJson, sha256File } from './lib/crypto.mjs';
import { findAlteredEvidenceLogs, writeJsonAtomic } from './lib/evidence-io.mjs';
import { computeSnapshotDigest } from './lib/git.mjs';
import {
  VERIFICATION_TYPES,
  assertHumanInteractive,
  confirmByTyping,
  evaluateDecisionIdentity,
  fingerprintOfPrivateKeyFile,
  generateApproverKeyPair,
  loadApproversPolicy,
  signDecisionRecord,
} from './lib/human-gate.mjs';
import {
  getApprovalDecisionPath,
  getApprovalHistoryPath,
  getCheckpointPath,
  getContractPath,
  getEvidenceManifestPath,
  getReviewPackagePath,
  getRunDir,
  getVerificationStampPath,
} from './lib/paths.mjs';
import { assertValidSchema } from './lib/schema.mjs';
import { STATES, assertTransition } from './lib/state-machine.mjs';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const writeJson = writeJsonAtomic;

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

function resolvePolicyBaseRef(contract, checkpoint) {
  return contract.verification_policy?.policy_base_ref ?? checkpoint.baseline_git_head;
}

/**
 * Record an explicit human review decision (`accepted`, `changes_requested`, `rejected`, `verification_requested`).
 * Verifies current state is READY_FOR_HUMAN_REVIEW and all artifact digests match current disk/snapshot state.
 *
 * Identity tier: `signKeyPath` yields `signed_ed25519`; `ttyConfirmed` (set only by the interactive CLI)
 * yields `local_tty_confirmed_not_identity_verified`; otherwise `local_explicit_input_not_identity_verified`.
 * When the protected approvers policy sets `require_signed`, only a signature from a listed approver is accepted.
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
  const alteredLogs = findAlteredEvidenceLogs(getRunDir(repoRoot, runId), manifest);
  if (alteredLogs.length > 0) {
    throw new Error(`EVIDENCE_LOG_ALTERED: ${alteredLogs.join('; ')}. Re-run verify and re-publish before approving.`);
  }

  // Identity gate: evaluated before any artifact is mutated.
  const approversPolicy = loadApproversPolicy(repoRoot, resolvePolicyBaseRef(contract, checkpoint));
  const actorName = String(options.actor).trim();
  if (options.signKeyPath) {
    const fingerprint = fingerprintOfPrivateKeyFile(path.resolve(options.signKeyPath));
    const listed = approversPolicy.approvers.some(
      (a) => a.public_key_fingerprint === fingerprint && a.actor === actorName,
    );
    if (approversPolicy.require_signed && !listed) {
      throw new Error(
        `APPROVER_NOT_TRUSTED: actor "${actorName}" with key ${fingerprint.slice(0, 16)}... is not listed in the protected approvers policy (${approversPolicy.source}).`,
      );
    }
  } else if (approversPolicy.require_signed) {
    throw new Error(
      `SIGNATURE_REQUIRED: the protected approvers policy (${approversPolicy.source}) requires a signed decision; pass --sign-key <ed25519 private key>.`,
    );
  }

  const nextStateMap = {
    accepted: STATES.ACCEPTED,
    changes_requested: STATES.CHANGES_REQUESTED,
    rejected: STATES.REJECTED,
    verification_requested: STATES.VERIFYING,
  };
  const targetState = nextStateMap[normalizedDecision];
  const actor = actorName;
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
    verification_type: options.signKeyPath
      ? VERIFICATION_TYPES.SIGNED
      : options.ttyConfirmed
        ? VERIFICATION_TYPES.TTY_CONFIRMED
        : VERIFICATION_TYPES.EXPLICIT_INPUT,
  };
  if (options.signKeyPath) {
    record.signature = signDecisionRecord(record, path.resolve(options.signKeyPath));
  }

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
    identity: evaluateDecisionIdentity(record, approversPolicy).identity,
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
  } else {
    // The manifest is intact, so the log hashes in it are the ones the decision was made on.
    for (const altered of findAlteredEvidenceLogs(getRunDir(repoRoot, runId), readJson(manifestPath))) {
      mismatches.push(`evidence log altered after decision: ${altered}`);
    }
  }

  // Identity: a broken signature, or a missing/untrusted one under `require_signed`, invalidates the decision.
  const checkpointPath = getCheckpointPath(repoRoot, runId);
  const checkpoint = fs.existsSync(checkpointPath) ? readJson(checkpointPath) : {};
  const approversPolicy = loadApproversPolicy(repoRoot, resolvePolicyBaseRef(contract, checkpoint));
  const identity = evaluateDecisionIdentity(decision, approversPolicy);
  if (identity.identity === 'SIGNATURE_INVALID') {
    mismatches.push(`signature invalid: ${identity.detail}`);
  } else if (approversPolicy.require_signed && identity.identity !== 'SIGNATURE_TRUSTED') {
    mismatches.push(`protected approvers policy requires a trusted signature: ${identity.detail}`);
  }

  if (mismatches.length > 0) {
    return {
      valid: false,
      status: 'INVALIDATED',
      decision: decision.decision,
      verification_type: decision.verification_type,
      identity: identity.identity,
      mismatches,
    };
  }

  return {
    valid: true,
    status: 'VALID',
    decision: decision.decision,
    actor: decision.actor,
    recorded_at: decision.recorded_at,
    verification_type: decision.verification_type,
    identity: identity.identity,
    mismatches: [],
  };
}

function printUsage() {
  process.stdout.write(
    [
      'CraftHelm Human Approval CLI (Explicit Human Acceptance Decision Record & Verification)',
      '',
      'Usage:',
      '  approval.mjs record --repo <path> --run-id <id> --decision <accept|changes-requested|reject|request-verification> --actor <name> --rationale "<text>" [--sign-key <ed25519.pem>] [--contract <path>]',
      '  approval.mjs verify --repo <path> --run-id <id> [--contract <path>]',
      '  approval.mjs keygen --out <private-key-path> --actor <name>',
      '',
      'Human gate:',
      '  record refuses to run inside a detected AI agent session and requires an interactive terminal,',
      '  where the operator confirms by typing the last 8 characters of the review package SHA-256.',
      '  With --sign-key the decision is signed (ed25519) and the terminal confirmation is skipped.',
      '  A committed .crafthelm/approvers.json with "require_signed": true makes signatures from listed approvers mandatory.',
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
      assertHumanInteractive({
        action: 'Recording a human decision',
        allowNonTty: Boolean(args['sign-key']),
      });
      let ttyConfirmed = false;
      if (!args['sign-key']) {
        const reportSha = sha256File(getReviewPackagePath(path.resolve(args.repo ?? '.'), args['run-id']));
        process.stderr.write(
          `Run ${args['run-id']}: decision "${args.decision}" by "${args.actor}"\nReview package SHA-256: ${reportSha}\n`,
        );
        ttyConfirmed = await confirmByTyping({
          expected: reportSha.slice(-8),
          message: 'Type the last 8 characters of the SHA-256 above to confirm you reviewed this package: ',
        });
        if (!ttyConfirmed) {
          throw new Error('HUMAN_GATE_CONFIRMATION_MISMATCH: confirmation code did not match; nothing was recorded.');
        }
      }
      const res = recordHumanDecision({
        signKeyPath: args['sign-key'],
        ttyConfirmed,
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
    } else if (sub === 'keygen') {
      assertHumanInteractive({ action: 'Generating an approver key', allowNonTty: true });
      if (!args.out || args.out === true) throw new Error('keygen requires --out <private-key-path>.');
      const outPath = path.resolve(String(args.out));
      if (fs.existsSync(outPath)) throw new Error(`Refusing to overwrite existing key file: ${outPath}`);
      const pair = generateApproverKeyPair();
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, pair.private_key_pem, { encoding: 'utf8', mode: 0o600 });
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            private_key_path: outPath,
            approvers_entry: {
              actor: typeof args.actor === 'string' ? args.actor : '<name>',
              public_key_fingerprint: pair.public_key_fingerprint,
            },
            note: 'Keep the private key outside the repository and outside paths an AI agent can read. Commit approvers_entry into .crafthelm/approvers.json on the protected base branch.',
          },
          null,
          2,
        )}\n`,
      );
    } else {
      throw new Error('Usage: approval.mjs <record|verify|keygen> --repo <path> --run-id <id> ...');
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
