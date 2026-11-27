import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { verifyHumanDecision } from '../../scripts/approval.mjs';
import { initCheckpoint } from '../../scripts/checkpoint.mjs';
import { approveContractFile } from '../../scripts/contract.mjs';
import { resolveCommandTimeoutMs } from '../../scripts/crafthelm.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { CRAFTHELM_ROOT, getApprovalDecisionPath, getCheckpointPath } from '../../scripts/lib/paths.mjs';
import { describeSessionStatus } from '../../scripts/lib/scope-guard.mjs';
import { buildReviewData, createReviewServer } from '../../scripts/review.mjs';
import { publishReviewPackage } from '../../scripts/review-package.mjs';
import { runVerify } from '../../scripts/verify.mjs';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const remove = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
const KOUETSU = path.join(CRAFTHELM_ROOT, 'hosts', 'codex', 'skills', 'kouetsu');
const state = (repo, runId) => readJson(getCheckpointPath(repo, runId)).state;

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-page-'));
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['config', 'user.name', 'CraftHelm Test']);
  runGit(repo, ['config', 'user.email', 'test@crafthelm.local']);
  for (const [rel, content] of Object.entries({ 'src/app.mjs': 'export const val = 1;\n', 'README.md': '# Base\n' })) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content, 'utf8');
  }
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-m', 'Base']);
  return repo;
}

function openRun(repo, taskId) {
  const contractPath = path.join(repo, '.crafthelm', 'contracts', `${taskId}.json`);
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(contractPath, JSON.stringify({
    schema_version: '0.3',
    task_id: taskId,
    request: `Change val for ${taskId}`,
    project_root: '.',
    host: 'codex',
    change_kind: 'refactor',
    methodology: { lifecycle: 'incremental', specification: 'lightweight', engineering: 'test_after', execution: 'full' },
    scope: { allow: ['src/**'], protect: [] },
    approval: { contract_approved: false, require_on: ['scope_change'] },
    budgets: { max_worker_retries_per_cause: 3, max_lead_escalations: 3, max_wall_minutes: 30 },
    requirements: [{ id: 'REQ-01', statement: 'val changes' }, { id: 'REQ-02', statement: 'a person checks the output by eye' }],
    acceptance: [
      { id: 'AC-01', requirement: 'REQ-01', kind: 'e2e', command: 'node --version', expected_exit_code: 0 },
      { id: 'AC-02', requirement: 'REQ-02', kind: 'manual', manual_method: 'Open the output and look' },
    ],
    source_policy: { authority: ['git-main'], source_refs: ['README.md'] },
  }, null, 2));
  approveContractFile(contractPath, 'operator');
  initCheckpoint({ repo, contract: contractPath, runId: `${taskId}-RUN` });
  return `${taskId}-RUN`;
}

function toReview(repo, runId) {
  runVerify({ repo, runId });
  publishReviewPackage({ repo, runId, kouetsuRoot: KOUETSU });
  assert.equal(state(repo, runId), 'READY_FOR_HUMAN_REVIEW');
}

// A raw request, so the Host and Origin headers are whatever the test says.
function call(port, method, pathname, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathname, agent: false,
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* the page itself is HTML */ }
        resolve({ status: res.statusCode, type: res.headers['content-type'], text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('Review page: the waiting runs read and decided on one page', () => {
  it('serves the runs with what a decision needs, records decisions made on the page, and refuses anything else', async () => {
    const repo = makeRepo();
    let server;
    try {
      // One run reviewed on an older tree, three on the current one.
      const [old, one, two, three] = ['M1-OLD', 'M1B-ONE', 'M1B-TWO', 'M1B-THREE'].map((id) => openRun(repo, id));
      fs.writeFileSync(path.join(repo, 'src', 'app.mjs'), 'export const val = 2;\n', 'utf8');
      toReview(repo, old);
      fs.writeFileSync(path.join(repo, 'src', 'app.mjs'), 'export const val = 3;\nexport const extra = true;\n', 'utf8');
      for (const id of [one, two, three]) toReview(repo, id);

      // What the page shows.
      const data = buildReviewData({ repo });
      assert.deepEqual(data.groups.map((g) => [g.key, g.runs.map((r) => r.run_id)]), [['M1', [old]], ['M1B', [one, two, three]]]);
      const shown = data.groups[1].runs[0];
      assert.deepEqual([shown.request, shown.acceptable, shown.technical_status, shown.changed_files, shown.added, shown.removed], ['Change val for M1B-ONE', true, 'PARTIAL', ['src/app.mjs'], 2, 1]);
      assert.deepEqual(shown.requirements.map((q) => [q.id, q.statement, q.verdict, q.checks.map((c) => [c.id, c.status])]), [
        ['REQ-01', 'val changes', 'verified', [['AC-01', 'PASS']]],
        ['REQ-02', 'a person checks the output by eye', 'unverified', [['AC-02', 'UNVERIFIED']]],
      ]);
      assert.ok(shown.notes.some((n) => n.kind === 'unverified' && /AC-02/.test(n.text)));
      assert.deepEqual([data.groups[0].runs[0].acceptable, data.groups[0].runs[0].problems.map((p) => p.code)], [false, ['STALE_SNAPSHOT']]);

      const made = createReviewServer({ repo, actor: 'seung', token: 't'.repeat(48) });
      server = made.server;
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      const base = `/${made.token}`;
      const origin = { Origin: `http://127.0.0.1:${port}` };
      const post = (action, body, headers = origin) => call(port, 'POST', `${base}/api/${action}`, { body, headers });

      // Reading: the page, the queue, a diff, a check log. Nothing without the token or under another host name.
      const page = await call(port, 'GET', `${base}/`);
      assert.deepEqual([page.status, page.type], [200, 'text/html; charset=utf-8']);
      assert.match(page.text, /<title>CraftHelm 검토<\/title>/);
      const queue = await call(port, 'GET', `${base}/api/queue`);
      assert.deepEqual([queue.status, queue.json.actor, queue.json.waiting], [200, 'seung', 4]);
      const diff = await call(port, 'GET', `${base}/api/run/${one}/diff`);
      assert.match(diff.json.text, /\+export const extra = true;/);
      const log = await call(port, 'GET', `${base}/api/run/${one}/log/AC-01`);
      assert.deepEqual([log.json.command, log.json.exit_code], ['node --version', 0]);
      assert.match(log.json.stdout.text, /^v\d+\./);
      assert.equal((await call(port, 'GET', '/')).status, 404);
      assert.equal((await call(port, 'GET', `/${'x'.repeat(48)}/api/queue`)).status, 404);
      assert.equal((await call(port, 'GET', `${base}/api/queue`, { headers: { Host: 'evil.test' } })).status, 403);
      assert.equal((await call(port, 'GET', `${base}/api/run/..%2F..%2Fetc/diff`)).status, 404);

      // Deciding: only from the page itself, only for waiting runs, and all or nothing.
      assert.equal((await post('accept', { run_ids: [one] }, {})).status, 403);
      assert.equal((await post('accept', { run_ids: [one] }, { Origin: 'http://evil.test' })).status, 403);
      const stale = await post('accept', { run_ids: [one, old] });
      assert.deepEqual([stale.status, stale.json.error], [409, 'Run "M1-OLD-RUN" cannot be accepted as it stands (STALE_SNAPSHOT).']);
      assert.equal((await post('accept', { run_ids: ['NOPE'] })).status, 409);
      assert.equal((await post('changes', { run_id: three, note: '  ' })).status, 400);
      assert.equal((await post('rewrite', {})).status, 404);
      assert.deepEqual([old, one, two, three].map((id) => state(repo, id)), Array(4).fill('READY_FOR_HUMAN_REVIEW'));

      // Two runs accepted together.
      const accepted = await post('accept', { run_ids: [one, two], note: 'Read both' });
      assert.deepEqual([accepted.status, accepted.json.results], [200, [{ run_id: one, state: 'ACCEPTED' }, { run_id: two, state: 'ACCEPTED' }]]);
      for (const id of [one, two]) {
        const decision = readJson(getApprovalDecisionPath(repo, id));
        assert.deepEqual(
          [decision.decision, decision.actor, decision.rationale, decision.verification_type, decision.batch],
          ['accepted', 'seung', 'Read both', 'local_review_page_not_identity_verified', { run_ids: [one, two] }],
        );
        assert.equal(verifyHumanDecision({ repo, runId: id }).valid, true);
      }

      // A change request: the reviewer's words reach the next turn of the session.
      const changes = await post('changes', { run_id: three, note: 'val should be 4, and drop "extra"' });
      assert.deepEqual(changes.json.results, [{ run_id: three, state: 'CHANGES_REQUESTED' }]);
      assert.ok(describeSessionStatus({ cwd: repo, event: 'UserPromptSubmit' }).includes('The reviewer (seung) asked for changes: "val should be 4, and drop \\"extra\\"". Make them inside the scope, then verify again.'));

      // The replaced run is closed without a decision record.
      const closed = await post('close', { run_ids: [old] });
      assert.deepEqual(closed.json.results, [{ run_id: old, state: 'ABORTED' }]);
      assert.equal(readJson(getCheckpointPath(repo, old)).closure.actor, 'seung');
      assert.equal(fs.existsSync(getApprovalDecisionPath(repo, old)), false);
      assert.equal((await call(port, 'GET', `${base}/api/queue`)).json.waiting, 0);
      // A decided run cannot be decided again from a stale page.
      assert.equal((await post('accept', { run_ids: [one] })).status, 409);
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      remove(repo);
    }
  });

  it('does not start without a terminal, needs a name, and is not cut off by the CLI time limit', () => {
    const repo = makeRepo();
    try {
      const res = spawnSync(process.execPath, [path.join(CRAFTHELM_ROOT, 'scripts', 'crafthelm.mjs'), 'review', '--repo', repo, '--actor', 'seung', '--no-open'], { cwd: repo, encoding: 'utf8', input: '' });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /HUMAN_GATE_/);
      assert.throws(() => createReviewServer({ repo, actor: '  ' }), /Explicit --actor is required/);
      assert.equal(resolveCommandTimeoutMs('review', {}), 0);
    } finally {
      remove(repo);
    }
  });
});
