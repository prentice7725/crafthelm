import fs from 'node:fs';
import path from 'node:path';
import { getCheckpointPath, getRunDir } from './paths.mjs';

/**
 * Considerations: what looked needed during a run and was deliberately not built.
 *
 * An agent that notices "two people could edit this at once" or "the old value is lost" has, without
 * a place to put the thought, two ways to settle it: build the answer, or ask for the contract to be
 * widened. Both make the change bigger than what was asked. A consideration is the third way: one
 * line, left for the person who reviews the run, who decides whether it becomes a task.
 *
 * They are the agent's remarks, not evidence. Nothing verifies them and no hash binds them; the
 * review page shows them as such. They live in the run's `inbox/`, which an agent may write.
 */

const FILE = path.join('inbox', 'considerations.jsonl');
const MAX_NOTE = 300;
const MAX_WHY = 300;
const MAX_ENTRIES = 30;

const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * Record one consideration for a run.
 * @param {string} repoRoot
 * @param {string} runId
 * @param {{ note: string, why?: string }} entry
 */
export function addConsideration(repoRoot, runId, entry) {
  if (!fs.existsSync(getCheckpointPath(repoRoot, runId))) {
    throw new Error(`RUN_NOT_FOUND: no run "${runId}" in ${repoRoot}. Run "status --repo <path>" to list runs.`);
  }
  const note = oneLine(entry.note);
  if (!note) throw new Error('checkpoint consider needs --note "<one line: what looked needed and was not built>".');
  if (note.length > MAX_NOTE) throw new Error(`CONSIDERATION_TOO_LONG: the note is ${note.length} characters; keep it to one line of at most ${MAX_NOTE}. A consideration names the concern, it does not design the answer.`);
  const why = oneLine(entry.why);
  if (why.length > MAX_WHY) throw new Error(`CONSIDERATION_TOO_LONG: --why is ${why.length} characters; keep it to at most ${MAX_WHY}.`);
  const existing = readConsiderations(repoRoot, runId);
  if (existing.some((c) => c.note === note)) return { ok: true, already_recorded: true, count: existing.length };
  if (existing.length >= MAX_ENTRIES) {
    throw new Error(`CONSIDERATION_LIMIT: this run already has ${MAX_ENTRIES} considerations. That many open concerns is a question for the user about the task, not more notes.`);
  }
  const file = path.join(getRunDir(repoRoot, runId), FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = { recorded_at: new Date().toISOString(), note, ...(why ? { why } : {}) };
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return { ok: true, count: existing.length + 1, consideration: record };
}

/**
 * The considerations of a run. The file may also be written by hand or by a file tool, so anything
 * that is not a line with a note is skipped and long text is cut rather than trusted.
 * @returns {Array<{ recorded_at: string|null, note: string, why?: string }>}
 */
export function readConsiderations(repoRoot, runId) {
  const file = path.join(getRunDir(repoRoot, runId), FILE);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    const note = oneLine(parsed?.note);
    if (!note) continue;
    const why = oneLine(parsed?.why);
    out.push({
      recorded_at: typeof parsed.recorded_at === 'string' ? parsed.recorded_at : null,
      note: note.slice(0, MAX_NOTE),
      ...(why ? { why: why.slice(0, MAX_WHY) } : {}),
    });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}
