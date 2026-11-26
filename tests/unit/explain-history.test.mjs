import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { initCheckpoint, recordRepairRound } from '../../scripts/checkpoint.mjs';
import { approveContractFile } from '../../scripts/contract.mjs';
import { explainRun, formatExplainText } from '../../scripts/lib/explain-run.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { CRAFTHELM_ROOT, getRunDir } from '../../scripts/lib/paths.mjs';
import { formatVerifyHistoryText, readVerifyHistory, summarizeVerifyHistory } from '../../scripts/lib/verify-history.mjs';
import { getVerifyHistory, runVerify } from '../../scripts/verify.mjs';

const WRONG = 'export function greet(name) { return `hi ${name}`; }\n';
const RIGHT = 'export function greet(name) { return `hello ${name}`; }\n';
const GREET_TEST = [
  "import assert from 'node:assert/strict';",
  "import { greet } from '../src/greet.mjs';",
  "assert.equal(greet('a'), 'hello a');",
  '',
].join('\n');
const SHAPE_TEST = [
  "import assert from 'node:assert/strict';",
  "import { greet } from '../src/greet.mjs';",
  "assert.equal(typeof greet('a'), 'string');",
  '',
].join('\n');

function startRun() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-history-'));
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['config', 'user.name', 'CraftHelm Test']);
  runGit(repo, ['config', 'user.email', 'test@crafthelm.local']);
  for (const [rel, content] of Object.entries({ 'src/greet.mjs': WRONG, 'tests/greet.test.mjs': GREET_TEST, 'tests/shape.test.mjs': SHAPE_TEST })) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content, 'utf8');
  }
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-m', 'Baseline commit']);

  const contractPath = path.join(repo, '.crafthelm', 'contracts', 'HIST.json');
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(contractPath, JSON.stringify({
    schema_version: '0.3',
    task_id: 'HIST',
    request: 'Greet with hello instead of hi',
    project_root: '.',
    host: 'generic',
    change_kind: 'bugfix',
    methodology: { lifecycle: 'incremental', specification: 'sdd', engineering: 'tdd', execution: 'full' },
    scope: { allow: ['src/**', 'tests/**'], protect: [] },
    approval: { contract_approved: false, require_on: ['scope_change'] },
    budgets: { max_worker_retries_per_cause: 3, max_lead_escalations: 3, max_wall_minutes: 30 },
    acceptance: [
      { id: 'AC-01', requirement: 'Greets with hello', kind: 'unit', command: 'node tests/greet.test.mjs', expected_exit_code: 0 },
      { id: 'AC-02', requirement: 'Returns a string', kind: 'fast', command: 'node tests/shape.test.mjs', expected_exit_code: 0 },
    ],
    source_policy: { authority: ['git-main'], source_refs: ['README.md'] },
    verification_policy: { require_e2e_for_functional: false },
  }, null, 2));
  approveContractFile(contractPath, 'operator');
  initCheckpoint({ repo, contract: contractPath, runId: 'HIST-RUN' });
  return repo;
}

describe('Why a run failed, and what each attempt changed', () => {
  it('explains the failed check from stored evidence and keeps each round after the logs are overwritten', () => {
    const repo = startRun();
    try {
      const runDir = getRunDir(repo, 'HIST-RUN');
      assert.equal(explainRun(repo, 'HIST-RUN').verified, false);
      assert.match(formatVerifyHistoryText('HIST-RUN', getVerifyHistory({ repo, runId: 'HIST-RUN' })), /기록된 verify 실행이 없습니다/);

      // Round 1: the fix is missing, the check written for it fails.
      assert.equal(runVerify({ repo, runId: 'HIST-RUN' }).technical_status, 'FAILED');
      const explained = explainRun(repo, 'HIST-RUN');
      assert.equal(explained.technical_status, 'FAILED');
      assert.deepEqual(explained.failed_checks.map((c) => [c.id, c.command, c.exit_code, c.expected_exit_code]), [['AC-01', 'node tests/greet.test.mjs', 1, 0]]);
      assert.equal(explained.failed_checks[0].stderr_file, '.crafthelm/runs/HIST-RUN/evidence/tests/AC-01.stderr.txt');
      assert.match(explained.failed_checks[0].output_tail, /hello a/);
      assert.equal(explained.current_cause, 'TEST_FAILURE');
      assert.deepEqual(explained.repair_rounds, [{ cause: 'TEST_FAILURE', used: 0, limit: 3, remaining: 3 }]);
      const text = formatExplainText(explained);
      assert.match(text, /FAIL AC-01 \(unit\) — Greets with hello/);
      assert.match(text, /실행한 명령: node tests\/greet\.test\.mjs/);
      assert.match(text, /오류 로그: \.crafthelm\/runs\/HIST-RUN\/evidence\/tests\/AC-01\.stderr\.txt/);
      assert.match(text, /복구 횟수 TEST_FAILURE \(이번 실패의 원인\): 0\/3 사용, 3회 남음/);

      // Round 2: verify again with nothing changed. Same snapshot, same outcome: still one attempt.
      runVerify({ repo, runId: 'HIST-RUN' });
      recordRepairRound({ repo, runId: 'HIST-RUN', cause: 'TEST_FAILURE', check: 'AC-01', note: 'first try' });
      assert.deepEqual(explainRun(repo, 'HIST-RUN').repair_rounds, [{ cause: 'TEST_FAILURE', used: 1, limit: 3, remaining: 2 }]);
      let history = getVerifyHistory({ repo, runId: 'HIST-RUN' });
      assert.equal(history.total_rounds, 2);
      assert.deepEqual(history.attempts.map((a) => [a.rounds, a.technical_status]), [[[1, 2], 'FAILED']]);

      // Round 3: the fix lands. The live log now shows a pass; the failing output survives in the archive.
      fs.writeFileSync(path.join(repo, 'src/greet.mjs'), RIGHT, 'utf8');
      assert.equal(runVerify({ repo, runId: 'HIST-RUN' }).technical_status, 'VERIFIED');
      history = getVerifyHistory({ repo, runId: 'HIST-RUN' });
      assert.deepEqual(history.attempts.map((a) => a.rounds), [[1, 2], [3]]);
      assert.deepEqual(history.attempts[1].changes, { snapshot_changed: true, fixed: ['AC-01'], regressed: [], still_failing: [], newly_run: [], no_longer_run: [] });
      const firstRound = readVerifyHistory(runDir)[0].checks[0];
      assert.equal(firstRound.archived_stderr, 'evidence/history/round-001/AC-01.stderr.txt');
      assert.match(fs.readFileSync(path.join(runDir, firstRound.archived_stderr), 'utf8'), /hello a/);
      assert.equal(fs.readFileSync(path.join(runDir, 'evidence/tests/AC-01.stderr.txt'), 'utf8'), '');
      // Passing output is not copied: the manifest hash already pins it.
      assert.equal(readVerifyHistory(runDir)[2].checks[0].archived_stderr, null);
      assert.equal(explainRun(repo, 'HIST-RUN').failed_checks.length, 0);
      assert.deepEqual(explainRun(repo, 'HIST-RUN').last_change.fixed, ['AC-01']);

      // Round 4: a later edit breaks a check that used to pass.
      fs.writeFileSync(path.join(repo, 'src/greet.mjs'), 'export function greet(name) { return name.length; }\n', 'utf8');
      runVerify({ repo, runId: 'HIST-RUN' });
      history = getVerifyHistory({ repo, runId: 'HIST-RUN' });
      assert.deepEqual(history.attempts[2].changes.regressed, ['AC-01', 'AC-02']);
      const historyText = formatVerifyHistoryText('HIST-RUN', history);
      assert.match(historyText, /verify 4회, 시도 3건/);
      assert.match(historyText, /1~2회차 \(같은 스냅샷에서 같은 결과로 2번 실행\)/);
      assert.match(historyText, /고쳐짐 \(FAIL → PASS\): AC-01/);
      assert.match(historyText, /새로 실패 \(PASS → FAIL\): AC-01, AC-02/);
      // A folded attempt points at its latest round's copy.
      assert.match(historyText, /당시 출력: evidence\/history\/round-002\/AC-01\.stderr\.txt/);

      // Both views are read-only CLI flags.
      const before = readVerifyHistory(runDir).length;
      const run = (script, ...args) => spawnSync(process.execPath, [path.join(CRAFTHELM_ROOT, 'scripts', script), '--repo', repo, '--run-id', 'HIST-RUN', ...args], { encoding: 'utf8', windowsHide: true });
      const statusOut = run('status.mjs', '--explain');
      assert.equal(statusOut.status, 0);
      assert.match(statusOut.stdout, /검증 결과 \(HIST-RUN\): FAILED — verify 4회 실행/);
      assert.match(statusOut.stdout, /FAIL AC-02 \(fast\)/);
      assert.equal(JSON.parse(run('status.mjs', '--explain', '--json').stdout).explain.failed_checks.length, 2);
      assert.equal(JSON.parse(run('status.mjs', '--json').stdout).explain, undefined);
      const historyOut = run('verify.mjs', '--history', '--json');
      assert.equal(historyOut.status, 0);
      assert.equal(JSON.parse(historyOut.stdout).attempts.length, 3);
      assert.equal(readVerifyHistory(runDir).length, before);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('folds only consecutive identical rounds and tolerates a truncated last line', () => {
    const round = (n, digest, statuses) => ({
      round: n,
      recorded_at: `2026-11-27T00:0${n}:00.000Z`,
      target_snapshot_digest: digest,
      technical_status: Object.values(statuses).includes('FAIL') ? 'FAILED' : 'VERIFIED',
      failure_reasons: [],
      checks: Object.entries(statuses).map(([id, status]) => ({ id, kind: 'unit', status })),
    });
    const summary = summarizeVerifyHistory([
      round(1, 'a'.repeat(64), { A: 'FAIL', B: 'SKIPPED_UNIMPACTED' }),
      // Same code, different result: a flaky check is its own attempt, flagged as not a code change.
      round(2, 'a'.repeat(64), { A: 'PASS', B: 'SKIPPED_UNIMPACTED' }),
      round(3, 'b'.repeat(64), { A: 'PASS', B: 'PASS' }),
      round(4, 'a'.repeat(64), { A: 'PASS', B: 'SKIPPED_UNIMPACTED' }),
    ]);
    assert.deepEqual(summary.attempts.map((a) => a.rounds), [[1], [2], [3], [4]]);
    assert.deepEqual([summary.attempts[1].changes.snapshot_changed, summary.attempts[1].changes.fixed], [false, ['A']]);
    assert.deepEqual(summary.attempts[2].changes.newly_run, ['B']);
    assert.deepEqual(summary.attempts[3].changes.no_longer_run, ['B']);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-history-file-'));
    try {
      fs.mkdirSync(path.join(dir, 'evidence'));
      fs.writeFileSync(path.join(dir, 'evidence', 'verify-history.jsonl'), `${JSON.stringify(round(1, 'a'.repeat(64), { A: 'PASS' }))}\n{"round":2,"chec`, 'utf8');
      assert.deepEqual(readVerifyHistory(dir).map((r) => r.round), [1]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
