import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline/promises';
import { listReviewQueue, recordHumanDecision } from './approval.mjs';
import { closeRun } from './checkpoint.mjs';
import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import { readConsiderations } from './lib/considerations.mjs';
import { assertHumanInteractive } from './lib/human-gate.mjs';
import { getCheckpointPath, getContractPath, getEvidenceManifestPath, getRunDir, getVerificationStampPath } from './lib/paths.mjs';

// The page is one static file: markup, styles and script. It holds no data; everything it shows is
// fetched from this server.
const REVIEW_PAGE_PATH = new URL('./lib/review-page.html', import.meta.url);

/**
 * The review page: every run waiting for a human decision on one screen, read and decided there.
 *
 * A person starts it from their own terminal (the same human gate as `approve record`). It serves
 * one page on 127.0.0.1 and records decisions only for requests that carry the token of this
 * process, come from the page itself, and name runs that are waiting. The page replaces finding and
 * opening review-package.md per run and typing a hash in a terminal; what a decision is bound to
 * (the verified snapshot, the report, the evidence) is unchanged.
 */

const DEFAULT_ACCEPT_RATIONALE = 'Reviewed in the review page; no comment.';
const DEFAULT_CLOSE_REASON = 'Replaced by later work; closed without acceptance.';
const MAX_TEXT_BYTES = 400_000;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// TR-M1B-GLOSS and TR-M1B-SCP are reviewed together as TR-M1B; a task with one segment is its own group.
function groupOf(taskId) {
  const cut = String(taskId ?? '').lastIndexOf('-');
  return cut > 0 ? taskId.slice(0, cut) : String(taskId ?? '');
}

// The saved patch runs from the baseline to the tree, so it also holds files verify does not count
// as this run's change (its own contract and task documents, a sibling task's). The page shows and
// counts the sections of the files verify did count.
function runPatch(patchPath, changedFiles) {
  if (!fs.existsSync(patchPath)) return '';
  const wanted = new Set(changedFiles);
  return fs.readFileSync(patchPath, 'utf8')
    .split(/^(?=diff --git )/m)
    .filter((section) => {
      const header = /^diff --git a\/.+? b\/(.+)$/m.exec(section);
      return header && wanted.has(header[1]);
    })
    .join('');
}

function diffStat(patchText) {
  let added = 0;
  let removed = 0;
  for (const line of patchText.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return { added, removed };
}

const NOT_VERIFIED = new Set(['UNVERIFIED']);
const FAILED = new Set(['FAIL', 'BLOCKED']);

function requirementRows(contract, checks) {
  const statements = new Map((contract.requirements ?? []).map((r) => [r.id, r.statement]));
  const ids = [...new Set([...statements.keys(), ...checks.map((c) => c.requirement).filter(Boolean)])];
  return ids.map((id) => {
    const own = checks.filter((c) => c.requirement === id && c.status !== 'NOT_APPLICABLE');
    const verdict = own.length === 0 || own.every((c) => NOT_VERIFIED.has(c.status))
      ? 'unverified'
      : own.some((c) => FAILED.has(c.status))
        ? 'failed'
        : own.some((c) => NOT_VERIFIED.has(c.status)) ? 'partly' : 'verified';
    return {
      id,
      statement: statements.get(id) ?? null,
      verdict,
      checks: own.map((c) => ({
        id: c.id, kind: c.kind, status: c.status, command: c.command ?? null, reason: c.reason ?? null,
        duration_ms: c.duration_ms ?? null, has_log: Boolean(c.stdout_file || c.stderr_file),
      })),
    };
  });
}

/**
 * What the page shows: the waiting runs with everything a decision needs, grouped by task prefix.
 * Reads only.
 * @param {{ repo?: string }} [options]
 */
export function buildReviewData(options = {}) {
  const queue = listReviewQueue({ repo: options.repo });
  const runs = queue.runs.map((entry) => {
    const runDir = getRunDir(queue.repo, entry.run_id);
    const checkpoint = readJsonSafe(getCheckpointPath(queue.repo, entry.run_id)) ?? {};
    const contract = readJsonSafe(getContractPath(queue.repo, checkpoint.task_id)) ?? {};
    const manifest = readJsonSafe(getEvidenceManifestPath(queue.repo, entry.run_id)) ?? {};
    const stamp = readJsonSafe(getVerificationStampPath(queue.repo, entry.run_id)) ?? {};
    const checks = Array.isArray(manifest.checks) ? manifest.checks : [];
    const notes = [];
    for (const item of stamp.unverified ?? []) notes.push({ kind: 'unverified', text: item });
    for (const signal of manifest.evidence_strength?.signals ?? []) notes.push({ kind: 'evidence', text: signal.human_check ? `${signal.detail} ${signal.human_check}` : signal.detail });
    if (contract.approval?.contract_approved_via === 'standing_rule') {
      notes.push({ kind: 'contract', text: `The contract was started under the project's standing rule for light contracts (${contract.approval.contract_approved_by ?? 'unknown'}); nobody approved it individually.` });
    }
    if (contract.approval?.contract_approved_via === 'agent_session') {
      notes.push({ kind: 'contract', text: `The contract was approved inside an AI agent session, recorded under the name "${contract.approval.contract_approved_by ?? 'unknown'}".` });
    }
    return {
      run_id: entry.run_id,
      task_id: entry.task_id,
      group: groupOf(entry.task_id),
      request: entry.request,
      acceptable: entry.acceptable,
      problems: entry.problems,
      zone: entry.zone,
      trial: entry.trial,
      considerations: readConsiderations(queue.repo, entry.run_id),
      tree_changed: entry.tree_changed,
      changed_since: entry.changed_since,
      technical_status: entry.technical_status,
      evidence_strength: manifest.evidence_strength?.level ?? null,
      verified_at: stamp.stamped_at ?? entry.updated_at ?? null,
      changed_files: manifest.scope?.changed_files ?? [],
      ...diffStat(runPatch(path.join(runDir, 'evidence', 'changes.patch'), manifest.scope?.changed_files ?? [])),
      requirements: requirementRows(contract, checks),
      notes,
      package_path: entry.package_path,
    };
  });
  const groups = [];
  for (const run of runs) {
    let group = groups.find((g) => g.key === run.group);
    if (!group) groups.push(group = { key: run.group, runs: [] });
    group.runs.push(run);
  }
  return { repo: queue.repo, repo_name: path.basename(queue.repo), waiting: runs.length, groups };
}

function tailText(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { text: '', truncated: false };
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const length = Math.min(size, MAX_TEXT_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return { text: buffer.toString('utf8'), truncated: size > length };
  } finally {
    fs.closeSync(fd);
  }
}

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function requireWaiting(queue, ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id)))];
  if (list.length === 0) throw new RequestError(400, 'No run was named.');
  const waiting = new Set(queue.runs.map((r) => r.run_id));
  for (const id of list) {
    if (!RUN_ID.test(id) || !waiting.has(id)) throw new RequestError(409, `Run "${id}" is not waiting for a decision. Reload the page.`);
  }
  return list;
}

/**
 * Apply one action from the page. Exported so the behaviour is testable without HTTP.
 * @param {{ repo: string, actor: string }} context
 * @param {'accept'|'changes'|'close'} action
 * @param {object} body
 */
export function applyReviewAction(context, action, body = {}) {
  const repoRoot = path.resolve(context.repo);
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  const results = [];
  if (!['accept', 'changes', 'close'].includes(action)) throw new RequestError(404, 'Unknown action.');
  // Read once per action: the tree is hashed here and the result reused below.
  const queue = listReviewQueue({ repo: repoRoot });
  if (action === 'accept') {
    const ids = requireWaiting(queue, body.run_ids);
    // Nothing is recorded unless every chosen run can be accepted as it stands.
    for (const id of ids) {
      const entry = queue.runs.find((r) => r.run_id === id);
      if (!entry.acceptable) throw new RequestError(409, `Run "${id}" cannot be accepted as it stands (${entry.problems[0].code}).`);
    }
    for (const id of ids) {
      const res = recordHumanDecision({
        repo: repoRoot, runId: id, decision: 'accept', actor: context.actor,
        rationale: note || DEFAULT_ACCEPT_RATIONALE, batchRunIds: ids, reviewPageConfirmed: true,
        currentSnapshot: queue.current_snapshot,
      });
      results.push({ run_id: id, state: res.state });
    }
  } else if (action === 'changes') {
    const [id] = requireWaiting(queue, [body.run_id]);
    if (!note) throw new RequestError(400, 'Say what should change.');
    const res = recordHumanDecision({ repo: repoRoot, runId: id, decision: 'changes-requested', actor: context.actor, rationale: note, reviewPageConfirmed: true, currentSnapshot: queue.current_snapshot });
    results.push({ run_id: id, state: res.state });
  } else {
    const ids = requireWaiting(queue, body.run_ids);
    for (const id of ids) closeRun({ repo: repoRoot, runId: id, reason: note || DEFAULT_CLOSE_REASON, dryRun: true });
    for (const id of ids) {
      const res = closeRun({ repo: repoRoot, runId: id, reason: note || DEFAULT_CLOSE_REASON, actor: context.actor, channel: 'interactive_terminal' });
      results.push({ run_id: id, state: res.state });
    }
  }
  return { ok: true, results };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64_000) { reject(new RequestError(413, 'Request too large.')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new RequestError(400, 'Body is not JSON.')); }
    });
    req.on('error', reject);
  });
}

function sameToken(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The HTTP server behind the page. It listens on 127.0.0.1 only; every path starts with the token.
 * @param {{ repo: string, actor: string, token?: string }} options
 * @returns {{ server: http.Server, token: string, url: (port: number) => string }}
 */
export function createReviewServer(options) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const actor = String(options.actor ?? '').trim();
  if (!actor) throw new Error('Explicit --actor is required to decide runs.');
  const token = options.token ?? crypto.randomBytes(24).toString('hex');
  const context = { repo: repoRoot, actor };

  const server = http.createServer(async (req, res) => {
    const send = (status, type, body) => {
      // One connection per request: a decision is handled synchronously, and a kept-alive socket can
      // time out during it and be reset under the next request.
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', Connection: 'close', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(body);
    };
    const json = (status, value) => send(status, 'application/json; charset=utf-8', JSON.stringify(value));
    try {
      const port = server.address().port;
      const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
      // A page on another site cannot reach this server by name, and cannot post to it.
      if (!origins.some((o) => o === `http://${req.headers.host}`)) throw new RequestError(403, 'Unexpected host.');
      const url = new URL(req.url, origins[0]);
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (parts.length === 0 || !sameToken(parts[0], token)) throw new RequestError(404, 'Not found.');
      const rest = parts.slice(1);

      if (req.method === 'GET' && rest.length === 0) {
        return send(200, 'text/html; charset=utf-8', fs.readFileSync(REVIEW_PAGE_PATH, 'utf8'));
      }
      if (req.method === 'GET' && rest.join('/') === 'api/queue') {
        return json(200, { actor, ...buildReviewData({ repo: repoRoot }) });
      }
      if (req.method === 'GET' && rest[0] === 'api' && rest[1] === 'run' && RUN_ID.test(rest[2] ?? '')) {
        const runDir = getRunDir(repoRoot, rest[2]);
        if (!fs.existsSync(getCheckpointPath(repoRoot, rest[2]))) throw new RequestError(404, 'No such run.');
        if (rest[3] === 'diff' && rest.length === 4) {
          const files = readJsonSafe(getEvidenceManifestPath(repoRoot, rest[2]))?.scope?.changed_files ?? [];
          const text = runPatch(path.join(runDir, 'evidence', 'changes.patch'), files);
          return json(200, { text: text.slice(0, MAX_TEXT_BYTES), truncated: text.length > MAX_TEXT_BYTES });
        }
        if (rest[3] === 'log' && rest.length === 5) {
          const check = (readJsonSafe(getEvidenceManifestPath(repoRoot, rest[2]))?.checks ?? []).find((c) => c.id === rest[4]);
          if (!check) throw new RequestError(404, 'No such check.');
          // The file names come from the manifest CraftHelm wrote, and must stay inside the run.
          const inside = (rel) => {
            if (typeof rel !== 'string') return { text: '', truncated: false };
            const abs = path.resolve(runDir, rel);
            return abs.startsWith(path.resolve(runDir) + path.sep) ? tailText(abs) : { text: '', truncated: false };
          };
          return json(200, { command: check.command ?? null, exit_code: check.exit_code ?? null, stdout: inside(check.stdout_file), stderr: inside(check.stderr_file) });
        }
      }
      if (req.method === 'POST' && rest[0] === 'api' && rest.length === 2) {
        if (!origins.includes(req.headers.origin)) throw new RequestError(403, 'Unexpected origin.');
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new RequestError(415, 'Expected JSON.');
        return json(200, applyReviewAction(context, rest[1], await readBody(req)));
      }
      throw new RequestError(404, 'Not found.');
    } catch (err) {
      json(err instanceof RequestError ? err.status : 500, { ok: false, error: err.message });
    }
  });
  return { server, token, url: (port) => `http://127.0.0.1:${port}/${token}/` };
}

function openInBrowser(url) {
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' });
      child.on('error', () => resolve(false));
      child.on('spawn', () => { child.unref(); resolve(true); });
    } catch {
      resolve(false);
    }
  });
}

function printUsage() {
  process.stdout.write([
    'CraftHelm Review Page (read and decide the runs waiting for a human decision)',
    '',
    'Usage:',
    '  review.mjs --repo <path> [--actor <name>] [--port <n>] [--no-open]',
    '',
    'Opens one page in your browser with every run in READY_FOR_HUMAN_REVIEW: what was asked, what',
    'changed, which check covers which requirement, and what was not verified. Accept, ask for',
    'changes, or close runs there. The page is served on 127.0.0.1 by this process and stops with',
    'Ctrl+C. Like `approve record`, it refuses to start inside an AI agent session.',
    '',
  ].join('\n'));
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (isHelpRequested(argv)) {
    printUsage();
    process.exit(0);
  }
  const args = parseArgs(argv);
  try {
    assertHumanInteractive({ action: 'Opening the review page' });
    let actor = typeof args.actor === 'string' ? args.actor.trim() : '';
    if (!actor) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      try { actor = (await rl.question('Your name, as it will be recorded with each decision: ')).trim(); } finally { rl.close(); }
    }
    const { server, url } = createReviewServer({ repo: args.repo ?? '.', actor });
    const port = Number.isInteger(Number(args.port)) && Number(args.port) > 0 ? Number(args.port) : 0;
    server.listen(port, '127.0.0.1', async () => {
      const address = url(server.address().port);
      const opened = args['no-open'] ? false : await openInBrowser(address);
      // The address carries the token that lets a request record a decision, so it is shown only
      // when the browser could not be opened for you.
      process.stderr.write(opened
        ? `Review page opened in your browser (deciding as "${actor}"). Press Ctrl+C here when you are done.\n`
        : `Open this address in your browser (deciding as "${actor}"), and press Ctrl+C here when you are done:\n${address}\n`);
    });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
