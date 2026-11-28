import fs from 'node:fs';
import path from 'node:path';

/**
 * Trial of a standing acceptance rule.
 *
 * Every run waits for a person, whatever it changed. The aim is that a run in a light zone that
 * verified cleanly could be accepted under a rule the person set in advance, without being read one
 * by one. Before any such rule is switched on it is tried: the rule is evaluated on every run that
 * reaches review, the result is shown beside the run, and the decision the person then makes is
 * logged next to what the rule would have done. Nothing is accepted by the rule here.
 *
 * The log answers one question: when the rule says "would have been accepted", does the person
 * accept? A run the rule would have accepted and the person sent back is the case that matters.
 */

const TRIAL_LOG = path.join('.crafthelm', 'runs', '.trial', 'acceptance-trial.jsonl');

/**
 * Would a standing rule have accepted this run? Decided from the evidence alone.
 * @param {object|null} manifest evidence manifest of the run
 * @param {object|null} stamp verification stamp of the run
 * @param {Array<{ code: string }>} [problems] what stops a decision on the run as it stands
 * @returns {{ candidate: boolean, reasons: string[] }} reasons are why it is not a candidate
 */
export function assessAcceptanceTrial(manifest, stamp, problems = []) {
  const reasons = [];
  const zone = manifest?.zone?.classification ?? 'undefined';
  if (zone === 'strict') reasons.push('ZONE_STRICT');
  if (zone === 'undefined') reasons.push('ZONE_UNDEFINED');
  if (manifest?.technical_status !== 'VERIFIED') reasons.push('NOT_VERIFIED');
  if ((stamp?.unverified ?? []).length > 0) reasons.push('UNVERIFIED_ITEMS');
  if (problems.length > 0) reasons.push('NOT_ACCEPTABLE');
  return { candidate: reasons.length === 0, reasons };
}

/**
 * Log what the rule would have done beside what the person did.
 * @param {string} repoRoot
 * @param {{ run_id: string, task_id?: string, decision: string, trial: ReturnType<typeof assessAcceptanceTrial>, zone?: string }} entry
 */
export function appendTrialRecord(repoRoot, entry) {
  const file = path.join(repoRoot, TRIAL_LOG);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = {
    schema_version: '0.1',
    recorded_at: new Date().toISOString(),
    run_id: entry.run_id,
    task_id: entry.task_id ?? null,
    zone: entry.zone ?? 'undefined',
    would_accept: entry.trial.candidate,
    reasons: entry.trial.reasons,
    decision: entry.decision,
  };
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export function readTrialRecords(repoRoot) {
  const file = path.join(repoRoot, TRIAL_LOG);
  if (!fs.existsSync(file)) return [];
  const records = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* a torn line is skipped, not fatal */ }
  }
  return records;
}

// Below this many decided candidates the rate says little.
const MIN_DECIDED_CANDIDATES = 10;

/**
 * How the rule has compared with the person so far. The last record of a run counts: a run sent
 * back and accepted later is one run.
 * @param {string} repoRoot
 */
export function summarizeAcceptanceTrial(repoRoot) {
  const byRun = new Map();
  for (const record of readTrialRecords(repoRoot)) {
    const earlier = byRun.get(record.run_id);
    // A run the person ever sent back stays a disagreement, even if it was accepted afterwards.
    const sentBack = Boolean(earlier?.sent_back) || (record.would_accept && ['changes_requested', 'rejected'].includes(record.decision));
    byRun.set(record.run_id, { ...record, sent_back: sentBack });
  }
  const runs = [...byRun.values()];
  const candidates = runs.filter((r) => r.would_accept);
  const decided = candidates.filter((r) => r.decision !== 'closed' && r.decision !== 'verification_requested');
  const disagreed = decided.filter((r) => r.sent_back || r.decision !== 'accepted');
  const agreed = decided.length - disagreed.length;
  const others = runs.filter((r) => !r.would_accept);
  const byReason = {};
  for (const r of others) for (const reason of r.reasons) {
    byReason[reason] ??= { runs: 0, accepted: 0 };
    byReason[reason].runs += 1;
    if (r.decision === 'accepted') byReason[reason].accepted += 1;
  }
  const enough = decided.length >= MIN_DECIDED_CANDIDATES;
  return {
    runs: runs.length,
    would_accept: {
      runs: candidates.length,
      decided: decided.length,
      accepted_by_person: agreed,
      sent_back_by_person: disagreed.length,
      closed_or_pending: candidates.length - decided.length,
      agreement_rate: decided.length > 0 ? Math.round((agreed / decided.length) * 1000) / 1000 : null,
      disagreements: disagreed.map((r) => ({ run_id: r.run_id, decision: r.sent_back && r.decision === 'accepted' ? 'sent back before acceptance' : r.decision })),
    },
    would_not_accept: { runs: others.length, by_reason: byReason },
    enough_data: enough,
    reading: decided.length === 0
      ? 'No run the rule would have accepted has been decided yet.'
      : !enough
        ? `Only ${decided.length} such run(s) decided; at least ${MIN_DECIDED_CANDIDATES} are needed before the rate says much.`
        : disagreed.length === 0
          ? 'The person accepted every run the rule would have accepted.'
          : `The person sent back ${disagreed.length} of ${decided.length} runs the rule would have accepted; look at those before switching the rule on.`,
  };
}
