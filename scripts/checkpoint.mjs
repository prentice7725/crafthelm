import fs from 'node:fs';
import path from 'node:path';
import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import { sha256CanonicalJson, sha256File } from './lib/crypto.mjs';
import { computeSnapshotDigest, getChangedFiles, getGitHead, isGitRepo } from './lib/git.mjs';
import { buildHandoffPacket } from './lib/handoff.mjs';
import { STANDARD_STAGES } from './lib/methodology.mjs';
import {
  getApprovalDecisionPath,
  getCheckpointPath,
  getContractPath,
  getEvidenceManifestPath,
  getReviewPackagePath,
  getRunDir,
  getSkillLockPath,
  matchesAnyGlob,
  toPosixPath,
} from './lib/paths.mjs';
import { assertValidSchema } from './lib/schema.mjs';
import { STATES, WATERFALL_GATED_STAGES, assertTransition } from './lib/state-machine.mjs';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function computeFileMapHashes(repoRoot, patterns) {
  const result = {};
  if (!patterns || patterns.length === 0) return result;
  const walk = (dir, prefix) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (rel === '.git' || rel.startsWith('.crafthelm/runs') || rel === 'node_modules') continue;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        const posixRel = toPosixPath(rel);
        if (matchesAnyGlob(posixRel, patterns)) {
          result[posixRel] = sha256File(path.join(dir, entry.name));
        }
      }
    }
  };
  walk(repoRoot, '');
  return result;
}

function resolveTaskDocsDir(repoRoot, docsDir, taskId) {
  if (docsDir && toPosixPath(docsDir) !== 'docs') {
    return toPosixPath(docsDir);
  }
  if (taskId) {
    const taskDocsRel = `docs/tasks/${taskId}`;
    if (fs.existsSync(path.join(repoRoot, taskDocsRel))) {
      return taskDocsRel;
    }
  }
  return toPosixPath(docsDir ?? 'docs');
}

function computeBaselineCraftHelmFiles(repoRoot, docsDir = 'docs', taskId = null) {
  const effectiveDocsDir = resolveTaskDocsDir(repoRoot, docsDir, taskId);
  const candidates = [
    `${effectiveDocsDir}/requirements.md`,
    `${effectiveDocsDir}/decisions.md`,
    `${effectiveDocsDir}/open_questions.md`,
    `${effectiveDocsDir}/acceptance.md`,
    '.crafthelm/config.json',
    '.crafthelm/skills.lock.json',
    'GEMINI.md',
  ];
  const contractsDir = path.join(repoRoot, '.crafthelm', 'contracts');
  if (fs.existsSync(contractsDir)) {
    for (const f of fs.readdirSync(contractsDir)) {
      if (f.endsWith('.json')) {
        candidates.push(`.crafthelm/contracts/${f}`);
      }
    }
  }
  for (const skillBase of ['.agents/skills', '.claude/skills', '.codex/skills', '.gemini/skills']) {
    const absBase = path.join(repoRoot, skillBase);
    if (fs.existsSync(absBase)) {
      const walkSkill = (dir, prefix) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = `${prefix}/${entry.name}`;
          if (entry.isDirectory()) walkSkill(path.join(dir, entry.name), rel);
          else if (entry.isFile()) candidates.push(rel);
        }
      };
      walkSkill(absBase, skillBase);
    }
  }
  const hashes = {};
  for (const rel of candidates) {
    const abs = path.join(repoRoot, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      hashes[rel] = sha256File(abs);
    }
  }
  return hashes;
}

function computeSotHashes(repoRoot, sourceRefs = []) {
  const hashes = {};
  for (const ref of sourceRefs) {
    const abs = path.join(repoRoot, ref);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      hashes[toPosixPath(ref)] = sha256File(abs);
    }
  }
  return hashes;
}

function loadContractForRun(repoRoot, taskId, explicitContractPath) {
  const contractPath = explicitContractPath ? path.resolve(explicitContractPath) : getContractPath(repoRoot, taskId);
  if (!fs.existsSync(contractPath)) {
    throw new Error(`Contract not found at ${contractPath}`);
  }
  const contract = readJson(contractPath);
  assertValidSchema('execution', contract, contractPath);
  return { contract, contractPath, contractSha256: sha256CanonicalJson(contract) };
}

function saveCheckpoint(repoRoot, runId, checkpoint) {
  checkpoint.updated_at = new Date().toISOString();
  assertValidSchema('checkpoint', checkpoint, `checkpoint ${runId}`);
  writeJson(getCheckpointPath(repoRoot, runId), checkpoint);
  return checkpoint;
}

/**
 * Initialize a new CraftHelm run checkpoint and freeze baseline hashes.
 */
export function initCheckpoint(options) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const contractPath = path.resolve(options.contract);
  const contract = readJson(contractPath);
  assertValidSchema('execution', contract, contractPath);

  if (!contract.approval?.contract_approved) {
    throw new Error('CONTRACT_NOT_APPROVED: Cannot initialize run checkpoint before contract approval');
  }

  const runId = options.runId ?? `${contract.task_id}-RUN-001`;
  const runDir = getRunDir(repoRoot, runId);
  fs.mkdirSync(path.join(runDir, 'evidence', 'tests'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'reports'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'approvals'), { recursive: true });

  // Persist contract copy inside .crafthelm/contracts/<task-id>.json if needed
  const canonicalContractPath = getContractPath(repoRoot, contract.task_id);
  if (path.resolve(canonicalContractPath) !== contractPath) {
    writeJson(canonicalContractPath, contract);
  }

  const baselineHead = isGitRepo(repoRoot) ? getGitHead(repoRoot) : 'NO_GIT';
  const snapshotDigest = computeSnapshotDigest(repoRoot);
  const lockPath = getSkillLockPath(repoRoot);
  const skillLockSha = fs.existsSync(lockPath) ? sha256File(lockPath) : 'none';

  const protectedPatterns = [
    ...(contract.scope?.protect ?? []),
    ...(contract.verification_policy?.protected_policy_paths ?? []),
    'REVIEW.md',
    '.crafthelm/reliability-rules.json',
  ];

  const checkpoint = {
    schema_version: '0.3',
    run_id: runId,
    task_id: contract.task_id,
    host: contract.host,
    state: STATES.READY,
    current_stage: 'tasks',
    contract_sha256: sha256CanonicalJson(contract),
    baseline_git_head: baselineHead,
    target_snapshot_digest: snapshotDigest,
    skill_lock_sha256: skillLockSha,
    protected_file_hashes: computeFileMapHashes(repoRoot, protectedPatterns),
    baseline_crafthelm_files: computeBaselineCraftHelmFiles(repoRoot, options.docsDir ?? 'docs', contract.task_id),
    sot_hashes: computeSotHashes(repoRoot, contract.source_policy?.source_refs),
    repair_rounds: {},
    stage_history: [
      {
        stage: 'interview',
        status: 'completed',
        artifact_digest: sha256CanonicalJson(contract),
        recorded_at: new Date().toISOString(),
      },
    ],
    stage_approvals: {},
    red_records: {},
    baseline_green_records: {},
    replan_history: [],
    updated_at: new Date().toISOString(),
  };

  return saveCheckpoint(repoRoot, runId, checkpoint);
}

/**
 * Enforce single-writer lock on a run directory.
 */
export function acquireWriterLock(options) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const runId = options.runId;
  const writerId = options.writer ?? `writer-${process.pid}`;
  const lockPath = path.join(getRunDir(repoRoot, runId), 'writer.lock.json');

  const payload = {
    writer_id: writerId,
    pid: process.pid,
    acquired_at: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(lockPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    return { ok: true, lock_path: lockPath, writer_id: writerId };
  } catch (err) {
    if (err.code === 'EEXIST') {
      const existing = fs.existsSync(lockPath) ? readJson(lockPath) : {};
      return {
        ok: false,
        error_code: 'CONCURRENT_WRITER_BLOCKED',
        message: `Active writer lock held by "${existing.writer_id ?? 'unknown'}"`,
        lock: existing,
      };
    }
    throw err;
  }
}

export function releaseWriterLock(options) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const runId = options.runId;
  const lockPath = path.join(getRunDir(repoRoot, runId), 'writer.lock.json');
  if (!fs.existsSync(lockPath)) {
    return { ok: true, released: false };
  }
  const existing = readJson(lockPath);
  if (!options.force && options.writer && existing.writer_id !== options.writer) {
    return {
      ok: false,
      error_code: 'LOCK_OWNER_MISMATCH',
      message: `Lock belongs to "${existing.writer_id}", not "${options.writer}"`,
    };
  }
  fs.unlinkSync(lockPath);
  return { ok: true, released: true };
}

/**
 * Advance or record stage entry/completion while enforcing Waterfall approval gates (E05).
 */
export function recordStage(options) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const runId = options.runId;
  const stage = options.stage;
  const status = options.status ?? 'started';
  if (!STANDARD_STAGES.includes(stage)) {
    throw new Error(`Unknown stage "${stage}"`);
  }

  const checkpointPath = getCheckpointPath(repoRoot, runId);
  const checkpoint = readJson(checkpointPath);
  const { contract } = loadContractForRun(repoRoot, checkpoint.task_id, options.contract);

  if (contract.methodology.lifecycle === 'waterfall' && status === 'started') {
    const targetIdx = STANDARD_STAGES.indexOf(stage);
    const missingGate = WATERFALL_GATED_STAGES.find((gatedStage) => {
      const gatedIdx = STANDARD_STAGES.indexOf(gatedStage);
      return gatedIdx < targetIdx && !checkpoint.stage_approvals?.[gatedStage]?.approved;
    });
    if (missingGate) {
      assertTransition(checkpoint.state, STATES.APPROVAL_REQUIRED);
      checkpoint.state = STATES.APPROVAL_REQUIRED;
      checkpoint.blocked_reason = `WATERFALL_GATE_BLOCKED: Stage "${missingGate}" requires explicit approval before entering "${stage}"`;
      saveCheckpoint(repoRoot, runId, checkpoint);
      return {
        ok: false,
        error_code: 'WATERFALL_GATE_BLOCKED',
        missing_gate: missingGate,
        state: checkpoint.state,
        message: checkpoint.blocked_reason,
      };
    }
  }

  if (status === 'started') {
    assertTransition(checkpoint.state, STATES.RUNNING_STAGE);
    checkpoint.state = STATES.RUNNING_STAGE;
  }
  checkpoint.current_stage = stage;
  delete checkpoint.blocked_reason;
  checkpoint.stage_history.push({
    stage,
    status,
    artifact_digest: computeSnapshotDigest(repoRoot),
    recorded_at: new Date().toISOString(),
  });
  saveCheckpoint(repoRoot, runId, checkpoint);
  return { ok: true, state: checkpoint.state, current_stage: stage };
}

/**
 * Record explicit human approval for a Waterfall stage gate.
 */
export function approveStage(options) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const runId = options.runId;
  const stage = options.stage;
  if (!options.actor || !String(options.actor).trim()) {
    throw new Error('Explicit --actor is required to approve a stage gate.');
  }
  const checkpoint = readJson(getCheckpointPath(repoRoot, runId));
  checkpoint.stage_approvals[stage] = {
    approved: true,
    actor: String(options.actor).trim(),
    artifact_digest: computeSnapshotDigest(repoRoot),
    rationale: options.rationale ?? 'Explicit stage approval',
    approved_at: new Date().toISOString(),
  };
  if (checkpoint.state === STATES.APPROVAL_REQUIRED) {
    assertTransition(checkpoint.state, STATES.READY);
    checkpoint.state = STATES.READY;
    delete checkpoint.blocked_reason;
  }
  saveCheckpoint(repoRoot, runId, checkpoint);
  return { ok: true, stage, state: checkpoint.state, approval: checkpoint.stage_approvals[stage] };
}

/**
 * Transition checkpoint state cleanly via state-machine invariants.
 */
export function transitionCheckpoint(options) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const runId = options.runId;
  const toState = options.to;
  const checkpoint = readJson(getCheckpointPath(repoRoot, runId));
  const { contract } = loadContractForRun(repoRoot, checkpoint.task_id, options.contract);

  let humanDecision = null;
  const decisionPath = getApprovalDecisionPath(repoRoot, runId);
  if (fs.existsSync(decisionPath)) {
    humanDecision = readJson(decisionPath);
  }

  assertTransition(checkpoint.state, toState, {
    humanDecision,
    contract,
    stageApprovals: checkpoint.stage_approvals,
  });

  checkpoint.state = toState;
  if (options.reason) {
    checkpoint.blocked_reason = options.reason;
  }
  saveCheckpoint(repoRoot, runId, checkpoint);
  return { ok: true, state: checkpoint.state };
}

/**
 * Record a repair round for a failure cause; enforce 3-round escalation limit (V04 / E20).
 */
export function recordRepairRound(options) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const runId = options.runId;
  const causeId = options.cause ?? 'default_cause';
  const checkpoint = readJson(getCheckpointPath(repoRoot, runId));
  const { contract } = loadContractForRun(repoRoot, checkpoint.task_id, options.contract);

  const limit = Math.min(3, contract.budgets?.max_worker_retries_per_cause ?? 3);
  const currentCount = checkpoint.repair_rounds[causeId] ?? 0;

  if (checkpoint.state === STATES.BLOCKED_HUMAN_ATTENTION || currentCount >= limit) {
    return {
      ok: false,
      error_code: 'REPAIR_LIMIT_EXCEEDED',
      state: checkpoint.state,
      cause_id: causeId,
      rounds_attempted: currentCount,
      repair_limit: limit,
      escalation_file: checkpoint.escalation?.escalation_file ?? null,
      message: `Repair limit (${limit}) already reached for "${causeId}"; human attention required.`,
    };
  }

  const nextCount = currentCount + 1;
  checkpoint.repair_rounds[causeId] = nextCount;
  checkpoint.target_snapshot_digest = computeSnapshotDigest(repoRoot);

  const attemptsFile = path.join(getRunDir(repoRoot, runId), 'evidence', `repair-${causeId}.jsonl`);
  fs.mkdirSync(path.dirname(attemptsFile), { recursive: true });
  fs.appendFileSync(
    attemptsFile,
    `${JSON.stringify({
      round: nextCount,
      cause_id: causeId,
      check_id: options.check ?? 'unknown',
      repro_command: options.command ?? 'not_provided',
      note: options.note ?? 'repair attempt recorded',
      snapshot_digest: checkpoint.target_snapshot_digest,
      recorded_at: new Date().toISOString(),
    })}\n`,
    'utf8',
  );

  if (nextCount >= limit) {
    assertTransition(checkpoint.state, STATES.BLOCKED_HUMAN_ATTENTION);
    checkpoint.state = STATES.BLOCKED_HUMAN_ATTENTION;
    const escalationRel = 'evidence/escalation.json';
    const escalationAbs = path.join(getRunDir(repoRoot, runId), escalationRel);
    const historyLines = fs.readFileSync(attemptsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const escalationBundle = {
      schema_version: '0.3',
      run_id: runId,
      cause_id: causeId,
      failed_check_id: options.check ?? 'unknown',
      reproduction_command: options.command ?? 'not_provided',
      last_changed_files: isGitRepo(repoRoot) ? getChangedFiles(repoRoot, checkpoint.baseline_git_head) : [],
      repair_limit: limit,
      rounds_attempted: nextCount,
      attempted_repairs: historyLines,
      human_options: [
        'Inspect minimal reproduction command and apply targeted fix manually',
        'Run crafthelm checkpoint replan to revise contract/acceptance criteria',
        'Reject run via crafthelm approve record --decision reject',
      ],
      escalated_at: new Date().toISOString(),
    };
    writeJson(escalationAbs, escalationBundle);
    checkpoint.escalation = {
      cause_id: causeId,
      rounds_attempted: nextCount,
      escalation_file: escalationRel,
      escalated_at: escalationBundle.escalated_at,
    };
    checkpoint.blocked_reason = `Escalated to human attention after ${nextCount} failed repair rounds for "${causeId}"`;
    saveCheckpoint(repoRoot, runId, checkpoint);
    return {
      ok: false,
      escalated: true,
      error_code: 'BLOCKED_HUMAN_ATTENTION',
      state: checkpoint.state,
      cause_id: causeId,
      rounds_attempted: nextCount,
      repair_limit: limit,
      escalation_file: escalationRel,
    };
  }

  if (checkpoint.state !== STATES.REPAIRING) {
    assertTransition(checkpoint.state, STATES.REPAIRING);
    checkpoint.state = STATES.REPAIRING;
  }
  saveCheckpoint(repoRoot, runId, checkpoint);
  return {
    ok: true,
    escalated: false,
    state: checkpoint.state,
    cause_id: causeId,
    rounds_attempted: nextCount,
    repair_limit: limit,
  };
}

/**
 * Resume an interrupted run after checking writer locks, contract, SOT, protected files, and snapshot hashes.
 */
export function resumeRun(options) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const runId = options.runId;
  const runDir = getRunDir(repoRoot, runId);
  const lockPath = path.join(runDir, 'writer.lock.json');

  if (fs.existsSync(lockPath)) {
    const lock = readJson(lockPath);
    return {
      ok: false,
      error_code: 'CONCURRENT_WRITER_BLOCKED',
      message: `Cannot resume while active writer lock exists (${lock.writer_id ?? 'unknown'})`,
    };
  }

  const checkpoint = readJson(getCheckpointPath(repoRoot, runId));
  const { contract, contractSha256 } = loadContractForRun(repoRoot, checkpoint.task_id, options.contract);

  const reasons = [];
  if (contractSha256 !== checkpoint.contract_sha256) {
    reasons.push('execution contract SHA-256 changed since checkpoint');
  }

  const currentSotHashes = computeSotHashes(repoRoot, contract.source_policy?.source_refs);
  for (const [k, oldHash] of Object.entries(checkpoint.sot_hashes ?? {})) {
    if (currentSotHashes[k] !== oldHash) {
      reasons.push(`SOT source "${k}" changed since checkpoint`);
    }
  }

  const protectedPatterns = [
    ...(contract.scope?.protect ?? []),
    ...(contract.verification_policy?.protected_policy_paths ?? []),
    'REVIEW.md',
    '.crafthelm/reliability-rules.json',
  ];
  const currentProtected = computeFileMapHashes(repoRoot, protectedPatterns);
  for (const [k, oldHash] of Object.entries(checkpoint.protected_file_hashes ?? {})) {
    if (currentProtected[k] !== oldHash) {
      reasons.push(`Protected path "${k}" modified since checkpoint`);
    }
  }

  if (reasons.length > 0) {
    checkpoint.state = STATES.REPLAN_REQUIRED;
    checkpoint.blocked_reason = reasons.join('; ');
    saveCheckpoint(repoRoot, runId, checkpoint);
    return {
      ok: false,
      error_code: 'REPLAN_REQUIRED',
      state: STATES.REPLAN_REQUIRED,
      reasons,
    };
  }

  const currentSnapshot = computeSnapshotDigest(repoRoot);
  const lockPathSkill = getSkillLockPath(repoRoot);
  const currentSkillLockSha = fs.existsSync(lockPathSkill) ? sha256File(lockPathSkill) : 'none';
  if (currentSkillLockSha !== checkpoint.skill_lock_sha256) {
    return {
      ok: false,
      error_code: 'SKILL_LOCK_CHANGED',
      state: checkpoint.state,
      reasons: ['skills.lock.json changed since checkpoint'],
    };
  }

  // Never restore READY_FOR_HUMAN_REVIEW or ACCEPTED if code/evidence/report hashes changed (Section 5.3 / H03 / E14)
  if (checkpoint.state === STATES.READY_FOR_HUMAN_REVIEW || checkpoint.state === STATES.ACCEPTED) {
    const manifestPath = getEvidenceManifestPath(repoRoot, runId);
    const reportPath = getReviewPackagePath(repoRoot, runId);
    const decisionPath = getApprovalDecisionPath(repoRoot, runId);

    const staleReasons = [];
    if (currentSnapshot !== checkpoint.target_snapshot_digest) {
      staleReasons.push('target_snapshot_digest changed since review/acceptance');
    }
    if (!fs.existsSync(manifestPath) || !fs.existsSync(reportPath)) {
      staleReasons.push('missing evidence-manifest.json or review-package.md');
    } else {
      const manifest = readJson(manifestPath);
      const reportSha = sha256File(reportPath);
      if (manifest.human_review?.package_sha256 !== reportSha) {
        staleReasons.push('review-package.md digest differs from evidence manifest');
      }
      if (checkpoint.state === STATES.ACCEPTED) {
        if (!fs.existsSync(decisionPath)) {
          staleReasons.push('approvals/decision.json missing for ACCEPTED state');
        } else {
          const decision = readJson(decisionPath);
          if (
            decision.target_snapshot_digest !== currentSnapshot ||
            decision.report_sha256 !== reportSha ||
            decision.evidence_manifest_sha256 !== sha256File(manifestPath)
          ) {
            staleReasons.push('human approval decision digests no longer match current artifacts');
          }
        }
      }
    }

    if (staleReasons.length > 0) {
      checkpoint.state = STATES.VERIFYING;
      checkpoint.blocked_reason = `STALE_REVIEW_OR_APPROVAL: ${staleReasons.join('; ')}`;
      saveCheckpoint(repoRoot, runId, checkpoint);
      return {
        ok: false,
        stale: true,
        error_code: 'STALE_ARTIFACTS_CANNOT_RESTORE',
        state: checkpoint.state,
        reasons: staleReasons,
      };
    }
  }

  const headChanged = (isGitRepo(repoRoot) ? getGitHead(repoRoot) : 'NO_GIT') !== checkpoint.baseline_git_head;
  const snapshotChanged = currentSnapshot !== checkpoint.target_snapshot_digest;
  checkpoint.target_snapshot_digest = currentSnapshot;
  if (checkpoint.state === STATES.PAUSED) {
    checkpoint.state = STATES.READY;
  }
  saveCheckpoint(repoRoot, runId, checkpoint);
  const handoff = buildHandoffPacket(repoRoot, runId, { contract, docsDir: options.docsDir ?? 'docs' });

  return {
    ok: true,
    state: checkpoint.state,
    head_changed: headChanged,
    snapshot_changed: snapshotChanged,
    target_snapshot_digest: currentSnapshot,
    resumed_from_stage: checkpoint.current_stage,
    handoff_packet_file: handoff.file,
    handoff_summary: {
      tried_and_failed_count: handoff.packet.tried_and_failed.length,
      open_questions_count: handoff.packet.open_questions.length,
      active_decisions_count: handoff.packet.active_decisions.length,
      related_memory_hits_count: handoff.packet.related_memory_hits.length,
      next_recommended_action: handoff.packet.next_recommended_action,
    },
  };
}

/**
 * Explicitly generate a structured handoff packet for the current run.
 */
export function createHandoff(options) {
  const repoRoot = path.resolve(options.repo ?? '.');
  return buildHandoffPacket(repoRoot, options.runId, { docsDir: options.docsDir ?? 'docs' });
}

/**
 * Replan without overwriting prior decision history; invalidate affected stages and tests.
 */
export function replanRun(options) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const runId = options.runId;
  const checkpoint = readJson(getCheckpointPath(repoRoot, runId));
  const { contract, contractSha256 } = loadContractForRun(repoRoot, checkpoint.task_id, options.contract);

  if (!contract.approval?.contract_approved) {
    throw new Error('CONTRACT_NOT_APPROVED: Updated contract must be approved before replanning.');
  }

  const invalidatedStages = ['tasks', 'implementation', 'integration', 'technical_verification', 'review_package', 'human_acceptance'];
  const historyEntry = {
    previous_contract_sha256: checkpoint.contract_sha256,
    new_contract_sha256: contractSha256,
    reason: options.reason ?? 'Approved requirement/scope replan',
    invalidated_stages: invalidatedStages,
    recorded_at: new Date().toISOString(),
  };

  const replanLogPath = path.join(getRunDir(repoRoot, runId), 'approvals', 'replan-history.jsonl');
  fs.mkdirSync(path.dirname(replanLogPath), { recursive: true });
  fs.appendFileSync(replanLogPath, `${JSON.stringify(historyEntry)}\n`, 'utf8');

  checkpoint.replan_history = checkpoint.replan_history ?? [];
  checkpoint.replan_history.push(historyEntry);
  checkpoint.contract_sha256 = contractSha256;
  checkpoint.sot_hashes = computeSotHashes(repoRoot, contract.source_policy?.source_refs);
  checkpoint.baseline_crafthelm_files = computeBaselineCraftHelmFiles(repoRoot, options.docsDir ?? 'docs', checkpoint.task_id);
  checkpoint.target_snapshot_digest = computeSnapshotDigest(repoRoot);
  for (const s of invalidatedStages) {
    checkpoint.stage_history.push({
      stage: s,
      status: 'invalidated',
      reason: historyEntry.reason,
      recorded_at: historyEntry.recorded_at,
    });
  }
  checkpoint.state = STATES.READY;
  checkpoint.current_stage = 'tasks';
  delete checkpoint.blocked_reason;
  saveCheckpoint(repoRoot, runId, checkpoint);

  return { ok: true, state: checkpoint.state, contract_sha256: contractSha256, invalidated_stages: invalidatedStages };
}

/**
 * Inspect checkpoint status and detect stale snapshots.
 */
export function statusCheckpoint(options) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const runId = options.runId;
  const checkpoint = readJson(getCheckpointPath(repoRoot, runId));
  const currentSnapshot = computeSnapshotDigest(repoRoot);
  return {
    run_id: checkpoint.run_id,
    task_id: checkpoint.task_id,
    host: checkpoint.host,
    state: checkpoint.state,
    current_stage: checkpoint.current_stage,
    snapshot_stale: currentSnapshot !== checkpoint.target_snapshot_digest,
    checkpoint_snapshot: checkpoint.target_snapshot_digest,
    current_snapshot: currentSnapshot,
    repair_rounds: checkpoint.repair_rounds,
    blocked_reason: checkpoint.blocked_reason ?? null,
  };
}

function printUsage() {
  process.stdout.write(
    [
      'CraftHelm Checkpoint CLI (Run Lifecycle State, Single-Writer Lock, Handoff & Replan)',
      '',
      'Usage: checkpoint.mjs <init|acquire-lock|release-lock|stage|approve-stage|transition|record-repair|resume|handoff|replan|status|audit> --repo <path> --run-id <id> [options]',
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
    if (sub === 'init') out = initCheckpoint({ repo: args.repo, contract: args.contract, runId: args['run-id'], docsDir: args['docs-dir'] });
    else if (sub === 'acquire-lock') out = acquireWriterLock({ repo: args.repo, runId: args['run-id'], writer: args.writer });
    else if (sub === 'release-lock') out = releaseWriterLock({ repo: args.repo, runId: args['run-id'], writer: args.writer, force: Boolean(args.force) });
    else if (sub === 'stage') out = recordStage({ repo: args.repo, runId: args['run-id'], stage: args.stage ?? args._[1], status: args.status, contract: args.contract });
    else if (sub === 'approve-stage') out = approveStage({ repo: args.repo, runId: args['run-id'], stage: args.stage ?? args._[1], actor: args.actor, rationale: args.rationale });
    else if (sub === 'transition') out = transitionCheckpoint({ repo: args.repo, runId: args['run-id'], to: args.to, reason: args.reason, contract: args.contract });
    else if (sub === 'record-repair') out = recordRepairRound({ repo: args.repo, runId: args['run-id'], cause: args.cause, check: args.check, command: args.command, note: args.note, contract: args.contract });
    else if (sub === 'resume') out = resumeRun({ repo: args.repo, runId: args['run-id'], contract: args.contract, docsDir: args['docs-dir'] });
    else if (sub === 'handoff') out = createHandoff({ repo: args.repo, runId: args['run-id'], docsDir: args['docs-dir'] });
    else if (sub === 'replan') out = replanRun({ repo: args.repo, runId: args['run-id'], contract: args.contract, reason: args.reason });
    else if (sub === 'status' || sub === 'audit') out = statusCheckpoint({ repo: args.repo, runId: args['run-id'] });
    else throw new Error('Usage: checkpoint.mjs <init|acquire-lock|release-lock|stage|approve-stage|transition|record-repair|resume|handoff|replan|status|audit> ...');

    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (out && out.ok === false) process.exit(1);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
