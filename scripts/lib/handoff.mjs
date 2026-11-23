import fs from 'node:fs';
import path from 'node:path';
import { hasMemorySources, listDecisions, searchMemory } from './memory.mjs';
import {
  getCheckpointPath,
  getContractPath,
  getHandoffPacketPath,
  getRunDir,
  toPosixPath,
} from './paths.mjs';
import { assertValidSchema } from './schema.mjs';
import { STATES } from './state-machine.mjs';

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Collect chronological `tried_and_failed` records from `repair-*.jsonl` and `escalation.json`.
 * @param {string} repoRoot
 * @param {string} runId
 */
export function collectTriedAndFailed(repoRoot, runId) {
  const evDir = path.join(getRunDir(repoRoot, runId), 'evidence');
  if (!fs.existsSync(evDir)) return [];

  const records = [];
  const seen = new Set();

  const pushRec = (rec) => {
    if (!rec || typeof rec !== 'object') return;
    const round = Math.max(1, Number(rec.round ?? 1));
    const causeId = String(rec.cause_id ?? 'TEST_FAILURE');
    const key = `${causeId}::${round}`;
    if (seen.has(key)) return;
    seen.add(key);
    records.push({
      round,
      cause_id: causeId,
      ...(rec.check_id ? { check_id: String(rec.check_id) } : {}),
      ...(rec.repro_command ? { repro_command: String(rec.repro_command) } : {}),
      ...(rec.note ? { note: String(rec.note) } : {}),
      ...(rec.snapshot_digest ? { snapshot_digest: String(rec.snapshot_digest) } : {}),
      ...(rec.recorded_at ? { recorded_at: String(rec.recorded_at) } : {}),
    });
  };

  for (const name of fs.readdirSync(evDir).sort()) {
    if (name.startsWith('repair-') && name.endsWith('.jsonl')) {
      const text = fs.readFileSync(path.join(evDir, name), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          pushRec(JSON.parse(line));
        } catch {
          // Ignore malformed jsonl entry
        }
      }
    }
  }

  const esc = readJsonSafe(path.join(evDir, 'escalation.json'));
  if (esc && Array.isArray(esc.attempted_repairs)) {
    for (const item of esc.attempted_repairs) {
      pushRec(item);
    }
  }

  records.sort((a, b) => a.round - b.round || a.cause_id.localeCompare(b.cause_id));
  return records;
}

/**
 * Extract open questions from task-scoped `docs/tasks/<taskId>/open_questions.md` or `docs/open_questions.md`.
 * @param {string} repoRoot
 * @param {string} [docsDir]
 * @param {string|null} [taskId]
 * @returns {string[]}
 */
export function collectOpenQuestions(repoRoot, docsDir = 'docs', taskId = null) {
  let effectiveDocsDir = docsDir;
  if (taskId && (!docsDir || docsDir === 'docs')) {
    const taskSpecificPath = path.join(repoRoot, 'docs', 'tasks', taskId, 'open_questions.md');
    if (fs.existsSync(taskSpecificPath)) {
      effectiveDocsDir = path.join('docs', 'tasks', taskId);
    }
  }
  const openQPath = path.join(repoRoot, effectiveDocsDir, 'open_questions.md');
  if (!fs.existsSync(openQPath)) return [];
  const questions = [];
  for (const rawLine of fs.readFileSync(openQPath, 'utf8').split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith('- ')) continue;
    const item = trimmed.slice(2).trim();
    if (!item || item === 'No deferred questions recorded.') continue;
    questions.push(item);
  }
  return questions;
}

/**
 * Derive a deterministic next recommended action string for cross-session / cross-host handoff.
 */
export function inferNextRecommendedAction(checkpoint, triedAndFailed = []) {
  if (checkpoint.state === STATES.BLOCKED_HUMAN_ATTENTION) {
    return 'Inspect evidence/escalation.json and decide between manual fix, checkpoint replan, or reject.';
  }
  if (checkpoint.state === STATES.REPLAN_REQUIRED) {
    return 'Reconcile changed contract or SOT hashes and run checkpoint replan.';
  }
  if (checkpoint.state === STATES.READY_FOR_HUMAN_REVIEW) {
    return 'Await explicit human decision via crafthelm approve record.';
  }
  if (checkpoint.state === STATES.REPAIRING) {
    return `Resolve remaining failure without repeating ${triedAndFailed.length} prior failed attempt(s), then re-run verify.`;
  }
  if (checkpoint.state === STATES.VERIFYING) {
    return 'Run review-package or complete required verification checks.';
  }
  return 'Continue scoped implementation inside scope.allow and run deterministic verify.';
}

/**
 * Build and persist `.crafthelm/runs/<runId>/evidence/handoff-packet.json` for cross-session / cross-agent handoff.
 * @param {string} repoRoot
 * @param {string} runId
 * @param {{ contract?: object, docsDir?: string }} [options]
 */
export function buildHandoffPacket(repoRoot, runId, options = {}) {
  const absRepo = path.resolve(repoRoot ?? '.');
  const checkpoint = readJsonSafe(getCheckpointPath(absRepo, runId));
  if (!checkpoint) {
    throw new Error(`Checkpoint not found for run "${runId}"`);
  }
  const contract = options.contract ?? readJsonSafe(getContractPath(absRepo, checkpoint.task_id));
  const taskId = contract?.task_id ?? checkpoint.task_id;
  const triedAndFailed = collectTriedAndFailed(absRepo, runId);
  const openQuestions = collectOpenQuestions(absRepo, options.docsDir ?? 'docs', taskId);
  const activeDecisions = listDecisions({ repo: absRepo, includeSuperseded: false }).map((d) => ({
    id: d.id,
    title: d.title,
    status: d.status,
    supersedes: d.supersedes ?? null,
    source_path: d.source_path,
  }));

  const queryParts = [
    contract?.request ?? '',
    ...triedAndFailed.map((t) => `${t.cause_id} ${t.check_id ?? ''} ${t.note ?? ''}`),
  ]
    .join(' ')
    .trim();

  let relatedHits = [];
  if (queryParts && hasMemorySources(absRepo)) {
    const searchRes = searchMemory({
      repo: absRepo,
      query: queryParts,
      limit: 5,
      docsDir: options.docsDir ?? 'docs',
    });
    relatedHits = searchRes.hits.map((h) => ({
      id: h.id,
      kind: h.kind,
      title: h.title,
      status: h.status,
      ...(h.superseded_by !== undefined ? { superseded_by: h.superseded_by } : {}),
      source_path: h.source_path,
      score: h.score,
      excerpt: h.excerpt,
      decayed: h.decayed,
    }));
  }

  const runDir = getRunDir(absRepo, runId);
  const candidateRefs = [
    'checkpoint.json',
    'evidence-manifest.json',
    'evidence/verification-stamp.json',
    'evidence/feedback-packet.json',
    'evidence/impact-analysis.json',
    'evidence/escalation.json',
    'reports/review-package.md',
  ];
  const evDir = path.join(runDir, 'evidence');
  if (fs.existsSync(evDir)) {
    for (const f of fs.readdirSync(evDir).sort()) {
      if (f.startsWith('repair-') && f.endsWith('.jsonl')) {
        candidateRefs.push(`evidence/${f}`);
      }
    }
  }
  const artifactRefs = [...new Set(candidateRefs)].filter((rel) => fs.existsSync(path.join(runDir, rel)));

  const packet = {
    schema_version: '0.3',
    run_id: checkpoint.run_id,
    task_id: checkpoint.task_id,
    host: checkpoint.host,
    state: checkpoint.state,
    current_stage: checkpoint.current_stage,
    target_snapshot_digest: checkpoint.target_snapshot_digest,
    baseline_git_head: checkpoint.baseline_git_head,
    blocked_reason: checkpoint.blocked_reason ?? null,
    tried_and_failed: triedAndFailed,
    open_questions: openQuestions,
    active_decisions: activeDecisions,
    related_memory_hits: relatedHits,
    next_recommended_action: inferNextRecommendedAction(checkpoint, triedAndFailed),
    artifact_refs: artifactRefs,
    generated_at: new Date().toISOString(),
  };

  assertValidSchema('handoff-packet', packet, `handoff-packet ${runId}`);
  const outAbs = getHandoffPacketPath(absRepo, runId);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, `${JSON.stringify(packet, null, 2)}\n`, 'utf8');

  return {
    ok: true,
    file: 'evidence/handoff-packet.json',
    path: toPosixPath(outAbs),
    packet,
  };
}
