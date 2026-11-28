import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { closeRun } from './checkpoint.mjs';
import { appendTrialRecord, assessAcceptanceTrial, summarizeAcceptanceTrial } from './lib/acceptance-trial.mjs';
import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import { sha256CanonicalJson, sha256File, sha256Text } from './lib/crypto.mjs';
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
  toPosixPath,
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
 * Everything a decision on a run depends on, and what stands in its way. `record` refuses on the
 * first problem; the review queue shows them, so a person sees why a run cannot be decided before
 * choosing it.
 */
function inspectReviewRun(repoRoot, runId, options = {}) {
  const checkpointPath = getCheckpointPath(repoRoot, runId);
  const checkpoint = readJson(checkpointPath);
  const contract = readJson(options.contract ? path.resolve(options.contract) : getContractPath(repoRoot, checkpoint.task_id));
  const contractSha = sha256CanonicalJson(contract);
  const manifestPath = getEvidenceManifestPath(repoRoot, runId);
  const reportPath = getReviewPackagePath(repoRoot, runId);
  const stampPath = getVerificationStampPath(repoRoot, runId);
  const base = { checkpointPath, checkpoint, contract, contractSha, manifestPath, reportPath, stampPath };

  if (!fs.existsSync(manifestPath) || !fs.existsSync(reportPath) || !fs.existsSync(stampPath)) {
    return { ...base, problems: [{ code: 'MISSING_ARTIFACTS', message: 'Cannot record human decision without evidence manifest, verification stamp, and review package.' }] };
  }
  const manifest = readJson(manifestPath);
  const stamp = readJson(stampPath);
  const reportSha = sha256File(reportPath);
  // The digest covers the whole tree; a caller deciding several runs computes it once.
  const currentSnapshot = options.currentSnapshot ?? computeSnapshotDigest(repoRoot);
  const problems = [];
  // A decision is about what was verified: the snapshot in the stamp, the report and the logs,
  // each bound by hash below. The stamp and the checkpoint must name the same snapshot; if verify
  // ran again without the package being published again, the package describes another tree.
  const verifiedSnapshot = stamp.target_snapshot_digest;
  if (verifiedSnapshot !== checkpoint.target_snapshot_digest) {
    problems.push({ code: 'STALE_SNAPSHOT', message: 'The run was verified again after its review package was published; publish the package again before approving.' });
  }
  // The tree moving on afterwards (the next task was started) does not stand in the way. It is
  // reported with the decision: which of this run's files are no longer what was verified, when
  // the manifest recorded their hashes, and otherwise only that the tree differs.
  const treeChanged = currentSnapshot !== verifiedSnapshot;
  let changedSince = null;
  if (treeChanged && manifest.scope?.changed_file_hashes) {
    changedSince = Object.entries(manifest.scope.changed_file_hashes)
      .filter(([rel, hash]) => {
        const abs = path.join(repoRoot, rel);
        const now = fs.existsSync(abs) && fs.statSync(abs).isFile() ? sha256File(abs) : 'DELETED';
        return now !== hash;
      })
      .map(([rel]) => rel)
      .sort();
  }
  if (reportSha !== manifest.human_review?.package_sha256) {
    problems.push({ code: 'STALE_REPORT', message: 'review-package.md was modified after verification; re-publish before approving.' });
  }
  if (contractSha !== checkpoint.contract_sha256) {
    problems.push({ code: 'CONTRACT_MISMATCH', message: 'execution contract changed without replan.' });
  }
  const alteredLogs = findAlteredEvidenceLogs(getRunDir(repoRoot, runId), manifest);
  if (alteredLogs.length > 0) {
    problems.push({ code: 'EVIDENCE_LOG_ALTERED', message: `${alteredLogs.join('; ')}. Re-run verify and re-publish before approving.` });
  }
  return { ...base, manifest, stamp, reportSha, currentSnapshot, verifiedSnapshot, treeChanged, changedSince, problems };
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

  const inspected = inspectReviewRun(repoRoot, runId, { contract: options.contract, currentSnapshot: options.currentSnapshot });
  if (inspected.problems.length > 0) {
    throw new Error(`${inspected.problems[0].code}: ${inspected.problems[0].message}`);
  }
  const { contract, contractSha, manifestPath, stampPath, manifest, stamp, reportSha, currentSnapshot, verifiedSnapshot, treeChanged, changedSince } = inspected;

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
    target_snapshot_digest: verifiedSnapshot,
    // Present when the tree was no longer the verified one at the time of the decision.
    ...(treeChanged ? { tree_at_decision_digest: currentSnapshot } : {}),
    ...(treeChanged && changedSince ? { changed_since_verification: changedSince } : {}),
    decision: normalizedDecision,
    actor,
    recorded_at: new Date().toISOString(),
    rationale: String(options.rationale).trim(),
    accepted_risks: Array.isArray(options.acceptedRisks) ? options.acceptedRisks : [],
    ...(Array.isArray(options.relatedRequirements) && options.relatedRequirements.length > 0
      ? { related_requirements: options.relatedRequirements }
      : {}),
    ...(options.reproConditions ? { repro_conditions: String(options.reproConditions) } : {}),
    // Decided in one sitting with other runs, under one confirmation covering all of them.
    ...(Array.isArray(options.batchRunIds) && options.batchRunIds.length > 1 ? { batch: { run_ids: [...options.batchRunIds] } } : {}),
    verification_type: options.signKeyPath
      ? VERIFICATION_TYPES.SIGNED
      : options.ttyConfirmed
        ? VERIFICATION_TYPES.TTY_CONFIRMED
        : options.reviewPageConfirmed
          ? VERIFICATION_TYPES.REVIEW_PAGE
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
  appendTrialRecord(repoRoot, {
    run_id: runId,
    task_id: contract.task_id,
    decision: normalizedDecision,
    zone: manifest.zone?.classification,
    trial: assessAcceptanceTrial(manifest, stamp),
  });

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
    target_snapshot_digest: verifiedSnapshot,
    tree_changed_since_verification: treeChanged,
    ...(treeChanged ? { changed_since_verification: changedSince } : {}),
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
  // The decision names the snapshot that was verified. The tree moving on does not undo it; the
  // result says whether the tree is still that snapshot.
  const treeMatches = decision.target_snapshot_digest === currentSnapshot;
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
    tree_matches_decision: treeMatches,
    mismatches: [],
  };
}

const DEFAULT_CLOSE_REASON = 'Replaced by later work; closed without acceptance.';

/**
 * The runs waiting for a human decision, and for each whether it can be decided as it stands.
 * Reads only. The tree is hashed once for the whole list.
 * @param {{ repo?: string }} [options]
 */
export function listReviewQueue(options = {}) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const runsRoot = path.join(repoRoot, '.crafthelm', 'runs');
  const waiting = [];
  if (fs.existsSync(runsRoot)) {
    for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const checkpointPath = getCheckpointPath(repoRoot, entry.name);
      if (!fs.existsSync(checkpointPath)) continue;
      let checkpoint;
      try { checkpoint = readJson(checkpointPath); } catch { continue; }
      if (checkpoint.state === STATES.READY_FOR_HUMAN_REVIEW) waiting.push({ runId: entry.name, updatedAt: checkpoint.updated_at ?? '' });
    }
  }
  waiting.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.runId.localeCompare(b.runId));
  const currentSnapshot = waiting.length > 0 ? computeSnapshotDigest(repoRoot) : null;
  const runs = waiting.map(({ runId, updatedAt }) => {
    let inspected;
    try {
      inspected = inspectReviewRun(repoRoot, runId, { currentSnapshot });
    } catch (err) {
      return { run_id: runId, task_id: null, request: null, technical_status: null, updated_at: updatedAt, package_path: null, package_sha256: null, acceptable: false, problems: [{ code: 'UNREADABLE', message: err.message }] };
    }
    return {
      run_id: runId,
      task_id: inspected.checkpoint.task_id,
      request: inspected.contract.request ?? null,
      technical_status: inspected.manifest?.technical_status ?? null,
      updated_at: updatedAt,
      package_path: toPosixPath(path.relative(repoRoot, inspected.reportPath)),
      package_sha256: inspected.reportSha ?? null,
      acceptable: inspected.problems.length === 0,
      problems: inspected.problems,
      zone: inspected.manifest?.zone ?? null,
      trial: assessAcceptanceTrial(inspected.manifest ?? null, inspected.stamp ?? null, inspected.problems),
      tree_changed: Boolean(inspected.treeChanged),
      changed_since: inspected.changedSince ?? null,
    };
  });
  return { repo: repoRoot, current_snapshot: currentSnapshot, runs };
}

// "1 3", "1,3", "2-4" or a keyword; numbers are the ones shown in the list.
function parseSelection(answer, count, keywords = {}) {
  const text = String(answer ?? '').trim().toLowerCase();
  if (!text || text === 'none') return [];
  if (keywords[text]) return keywords[text];
  const picked = new Set();
  for (const token of text.split(/[\s,]+/).filter(Boolean)) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(token);
    const from = range ? Number(range[1]) : NaN;
    const to = range ? Number(range[2] ?? range[1]) : NaN;
    if (!range || from < 1 || to > count || from > to) {
      throw new Error(`REVIEW_DESK_SELECTION_INVALID: "${token}" is not a number from the list (1-${count}); nothing was recorded.`);
    }
    for (let n = from; n <= to; n += 1) picked.add(n - 1);
  }
  return [...picked].sort((a, b) => a - b);
}

/**
 * Decide the waiting runs in one sitting: accept the ones that can be accepted as they stand, and
 * close the ones later work replaced. One confirmation covers the accepted set. The caller is
 * responsible for the human gate; `ask` puts a question to the person and returns the answer.
 * @param {{ repo?: string, actor: string, rationale?: string, signKeyPath?: string, ask: (message: string) => Promise<string>, write?: (text: string) => void }} options
 */
export async function runReviewDesk(options) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const actor = typeof options.actor === 'string' ? options.actor.trim() : '';
  if (!actor) throw new Error('Explicit --actor is required to decide runs.');
  const write = options.write ?? ((text) => process.stderr.write(text));
  const queue = listReviewQueue({ repo: repoRoot });
  const result = { ok: true, repo: repoRoot, waiting: queue.runs.length, accepted: [], closed: [], failed: [], left_waiting: [] };
  if (queue.runs.length === 0) {
    write('No run is waiting for a human decision.\n');
    return result;
  }

  write(`${queue.runs.length} run${queue.runs.length === 1 ? '' : 's'} waiting for a human decision in ${repoRoot}\n\n`);
  queue.runs.forEach((run, i) => {
    const request = run.request ? (run.request.length > 90 ? `${run.request.slice(0, 87)}...` : run.request) : '(request unavailable)';
    const moved = !run.tree_changed ? '' : run.changed_since === null ? '; the tree has changed since' : run.changed_since.length === 0 ? '; the tree has changed since, this run\'s files have not' : `; ${run.changed_since.length} of its files changed since`;
    write(`  ${String(i + 1).padStart(2)}. ${run.run_id}  [${run.acceptable ? `ready to decide${moved}` : `cannot be accepted: ${run.problems.map((p) => p.code).join(', ')}`}]\n`);
    write(`      ${request}\n`);
    if (run.package_path) write(`      checks: ${run.technical_status ?? 'unknown'} | package: ${run.package_path}${run.package_sha256 ? ` (sha256 ...${run.package_sha256.slice(-8)})` : ''}\n`);
  });
  const acceptable = queue.runs.map((run, i) => (run.acceptable ? i : -1)).filter((i) => i >= 0);
  const blocked = queue.runs.map((run, i) => (run.acceptable ? -1 : i)).filter((i) => i >= 0);
  if (blocked.length > 0) {
    write('\nA run that cannot be accepted has a report, contract or evidence that no longer matches what was verified. Verify it again and publish its package, or close it if later work replaced it.\n');
  }
  write('\n');

  let acceptIdx = [];
  if (acceptable.length > 0) {
    acceptIdx = parseSelection(await options.ask('Accept which runs? Numbers ("1 3", "2-4"), "all" for every run marked ready, or Enter for none: '), queue.runs.length, { all: acceptable });
    const notReady = acceptIdx.filter((i) => !queue.runs[i].acceptable);
    if (notReady.length > 0) {
      throw new Error(`REVIEW_DESK_SELECTION_INVALID: ${notReady.map((i) => queue.runs[i].run_id).join(', ')} cannot be accepted as it stands (${queue.runs[notReady[0]].problems[0].code}); nothing was recorded.`);
    }
  }
  const closeIdx = parseSelection(
    await options.ask(`Close which runs without accepting them? Numbers, ${blocked.length > 0 ? '"stale" for every run that cannot be accepted, ' : ''}or Enter for none: `),
    queue.runs.length,
    blocked.length > 0 ? { stale: blocked } : {},
  );
  const both = closeIdx.filter((i) => acceptIdx.includes(i));
  if (both.length > 0) {
    throw new Error(`REVIEW_DESK_SELECTION_INVALID: ${both.map((i) => queue.runs[i].run_id).join(', ')} was chosen both to accept and to close; nothing was recorded.`);
  }

  let rationale = typeof options.rationale === 'string' ? options.rationale.trim() : '';
  let ttyConfirmed = false;
  if (acceptIdx.length > 0) {
    if (!rationale) rationale = String(await options.ask('Rationale for accepting (recorded with each decision): ')).trim();
    if (!rationale) throw new Error('Explicit rationale is required to record a human acceptance decision; nothing was recorded.');
    if (!options.signKeyPath) {
      // One code for the set: a single run uses its own package hash, as `record` does.
      const shas = acceptIdx.map((i) => queue.runs[i].package_sha256);
      const code = (shas.length === 1 ? shas[0] : sha256Text([...shas].sort().join('\n'))).slice(-8);
      write(`\nAccepting ${acceptIdx.length} run${acceptIdx.length === 1 ? '' : 's'} as "${actor}": ${acceptIdx.map((i) => queue.runs[i].run_id).join(', ')}\nConfirmation code for ${acceptIdx.length === 1 ? 'this review package' : 'these review packages'}: ${code}\n`);
      ttyConfirmed = String(await options.ask('Type the confirmation code to confirm you reviewed them: ')).trim() === code;
      if (!ttyConfirmed) throw new Error('HUMAN_GATE_CONFIRMATION_MISMATCH: confirmation code did not match; nothing was recorded.');
    }
  }
  let closeReason = DEFAULT_CLOSE_REASON;
  if (closeIdx.length > 0) {
    closeReason = String(await options.ask(`Reason for closing (Enter for "${DEFAULT_CLOSE_REASON}"): `)).trim() || DEFAULT_CLOSE_REASON;
    write(`\nClosing ${closeIdx.length} run${closeIdx.length === 1 ? '' : 's'} without acceptance: ${closeIdx.map((i) => queue.runs[i].run_id).join(', ')}\n`);
    if (String(await options.ask('Type CLOSE to confirm: ')).trim() !== 'CLOSE') {
      throw new Error('HUMAN_GATE_CONFIRMATION_MISMATCH: closing was not confirmed; nothing was recorded.');
    }
  }

  const batchRunIds = acceptIdx.map((i) => queue.runs[i].run_id);
  for (const runId of batchRunIds) {
    try {
      const res = recordHumanDecision({
        repo: repoRoot, runId, decision: 'accept', actor, rationale, batchRunIds,
        signKeyPath: options.signKeyPath, ttyConfirmed, currentSnapshot: queue.current_snapshot,
      });
      result.accepted.push({ run_id: runId, state: res.state, verification_type: res.verification_type });
    } catch (err) {
      result.failed.push({ run_id: runId, action: 'accept', error: err.message });
    }
  }
  for (const i of closeIdx) {
    const runId = queue.runs[i].run_id;
    try {
      const res = closeRun({ repo: repoRoot, runId, reason: closeReason, actor, channel: 'interactive_terminal' });
      result.closed.push({ run_id: runId, previous_state: res.closure.previous_state });
    } catch (err) {
      result.failed.push({ run_id: runId, action: 'close', error: err.message });
    }
  }
  const decided = new Set([...result.accepted, ...result.closed].map((r) => r.run_id));
  result.left_waiting = queue.runs.filter((run) => !decided.has(run.run_id)).map((run) => run.run_id);
  result.ok = result.failed.length === 0;
  return result;
}

function printUsage() {
  process.stdout.write(
    [
      'CraftHelm Human Approval CLI (Explicit Human Acceptance Decision Record & Verification)',
      '',
      'Usage:',
      '  approval.mjs record --repo <path> --run-id <id> --decision <accept|changes-requested|reject|request-verification> --actor <name> --rationale "<text>" [--sign-key <ed25519.pem>] [--contract <path>]',
      '  approval.mjs batch  --repo <path> --actor <name> [--rationale "<text>"] [--sign-key <ed25519.pem>]',
      '  approval.mjs queue  --repo <path>',
      '  approval.mjs trial  --repo <path>   (how a standing acceptance rule would have compared with your decisions)',
      '  approval.mjs verify --repo <path> --run-id <id> [--contract <path>]',
      '  approval.mjs keygen --out <private-key-path> --actor <name>',
      '',
      'Human gate:',
      '  record refuses to run inside a detected AI agent session and requires an interactive terminal,',
      '  where the operator confirms by typing the last 8 characters of the review package SHA-256.',
      '  With --sign-key the decision is signed (ed25519) and the terminal confirmation is skipped.',
      '  A committed .crafthelm/approvers.json with "require_signed": true makes signatures from listed approvers mandatory.',
      '',
      'Several runs at once:',
      '  batch lists every run waiting for a decision, says which can be accepted as they stand, and asks which',
      '  to accept and which to close without acceptance (work that later runs replaced). One confirmation',
      '  covers the accepted set. It is held to the same human gate as record and always needs a terminal.',
      '  queue prints the same list as JSON and changes nothing.',
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
    } else if (sub === 'batch') {
      assertHumanInteractive({ action: 'Deciding runs in a batch' });
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      let res;
      try {
        res = await runReviewDesk({
          repo: args.repo,
          actor: args.actor,
          rationale: typeof args.rationale === 'string' ? args.rationale : undefined,
          signKeyPath: args['sign-key'],
          ask: (message) => rl.question(message),
        });
      } finally {
        rl.close();
      }
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      if (!res.ok) process.exit(1);
    } else if (sub === 'trial') {
      const summary = summarizeAcceptanceTrial(path.resolve(args.repo ?? '.'));
      process.stderr.write(`${summary.reading}\n`);
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else if (sub === 'queue') {
      process.stdout.write(`${JSON.stringify(listReviewQueue({ repo: args.repo }), null, 2)}\n`);
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
      throw new Error('Usage: approval.mjs <record|batch|queue|trial|verify|keygen> --repo <path> ...');
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
