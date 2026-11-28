import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { acquireWriterLock, initCheckpoint, replanRun } from '../../scripts/checkpoint.mjs';
import { addE2eCriterion, approveContractFile, checkContractReadiness } from '../../scripts/contract.mjs';
import { normalizeRequirements, runInterview } from '../../scripts/interview.mjs';
import { sha256File } from '../../scripts/lib/crypto.mjs';
import { TIMEOUT_EXIT_CODE, runShellCommand } from '../../scripts/lib/exec.mjs';
import { computeSnapshotDigest, runGit } from '../../scripts/lib/git.mjs';
import { CRAFTHELM_ROOT, getCheckpointPath, getEvidenceManifestPath, getRunDir } from '../../scripts/lib/paths.mjs';
import { describeSessionStatus } from '../../scripts/lib/scope-guard.mjs';
import { publishReviewPackage } from '../../scripts/review-package.mjs';
import { DEFAULT_CHECK_TIMEOUT_MS, resolveCheckTimeoutMs, runVerify } from '../../scripts/verify.mjs';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const SLOW = 'node -e "setTimeout(() => {}, 4000)"';
// A command stopped at its limit can leave a child holding the directory for a moment.
const remove = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-timeout-'));
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

function writeContract(repo, taskId, acceptance, extra = {}) {
  const contractPath = path.join(repo, '.crafthelm', 'contracts', `${taskId}.json`);
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(contractPath, JSON.stringify({
    schema_version: '0.3',
    task_id: taskId,
    request: 'Set val to 2',
    project_root: '.',
    host: 'generic',
    change_kind: 'refactor',
    methodology: { lifecycle: 'incremental', specification: 'lightweight', engineering: 'test_after', execution: 'full' },
    scope: { allow: ['src/**'], protect: [] },
    approval: { contract_approved: false, require_on: ['scope_change'] },
    budgets: { max_worker_retries_per_cause: 3, max_lead_escalations: 3, max_wall_minutes: 30 },
    acceptance,
    source_policy: { authority: ['git-main'], source_refs: ['README.md'] },
    ...extra,
  }, null, 2));
  return contractPath;
}

describe('Check time limit: a command that ran out of time is not a command that failed', () => {
  it('reports a shell command stopped at its limit as a timeout with exit code 124 and says so in stderr', () => {
    const res = runShellCommand(SLOW, { timeoutMs: 500 });
    assert.deepEqual([res.timedOut, res.exitCode, res.timeoutMs], [true, TIMEOUT_EXIT_CODE, 500]);
    assert.match(res.stderr, /\[crafthelm\] Stopped after 500 ms: the command did not finish within its time limit\./);

    const quick = runShellCommand('node --version', { timeoutMs: 30_000 });
    assert.deepEqual([quick.timedOut, quick.exitCode, quick.stderr], [false, 0, '']);
  });

  it('takes the limit from the acceptance item, then the contract, then a ten-minute default', () => {
    assert.equal(DEFAULT_CHECK_TIMEOUT_MS, 600_000);
    assert.equal(resolveCheckTimeoutMs({ timeout_ms: 5000 }, { verification_policy: { check_timeout_ms: 9000 } }), 5000);
    assert.equal(resolveCheckTimeoutMs({}, { verification_policy: { check_timeout_ms: 9000 } }), 9000);
    assert.equal(resolveCheckTimeoutMs({}, {}), DEFAULT_CHECK_TIMEOUT_MS);
  });

  it('records the timeout in the manifest, the log and the feedback packet, under its own repair cause', () => {
    const repo = makeRepo();
    try {
      const contractPath = writeContract(repo, 'SLOW', [
        { id: 'AC-01', requirement: 'REQ-01', kind: 'fast', command: 'node --version', expected_exit_code: 0 },
        { id: 'AC-02', requirement: 'REQ-01', kind: 'e2e', command: SLOW, expected_exit_code: 0, timeout_ms: 1000 },
      ]);
      approveContractFile(contractPath, 'operator');
      initCheckpoint({ repo, contract: contractPath, runId: 'SLOW-RUN' });

      const v = runVerify({ repo, runId: 'SLOW-RUN' });
      assert.equal(v.technical_status, 'FAILED');
      const manifest = readJson(getEvidenceManifestPath(repo, 'SLOW-RUN'));
      const [fast, slow] = manifest.checks;
      assert.deepEqual([fast.status, fast.timed_out, fast.timeout_ms], ['PASS', undefined, DEFAULT_CHECK_TIMEOUT_MS]);
      assert.deepEqual([slow.status, slow.timed_out, slow.timeout_ms, slow.exit_code], ['FAIL', true, 1000, TIMEOUT_EXIT_CODE]);
      assert.match(slow.reason, /^Timed out: stopped after 1000 ms without finishing\. Raise timeout_ms on this acceptance item/);
      assert.ok(manifest.failure_reasons.some((r) => r.startsWith('AC_TIMEOUT:AC-02: Timed out')));
      assert.ok(!manifest.failure_reasons.some((r) => r.startsWith('AC_FAILED')));

      const runDir = getRunDir(repo, 'SLOW-RUN');
      assert.match(fs.readFileSync(path.join(runDir, slow.stderr_file), 'utf8'), /Stopped after 1000 ms/);
      const packet = readJson(path.join(runDir, 'evidence', 'feedback-packet.json'));
      assert.equal(packet.root_cause_category, 'CHECK_TIMEOUT');
      assert.match(packet.failed_checks[0].reason, /Timed out/);
    } finally {
      remove(repo);
    }
  });

  it('lets add-e2e set the limit on the check it adds', () => {
    const repo = makeRepo();
    try {
      const contractPath = writeContract(repo, 'ADD', [{ id: 'AC-01', requirement: 'REQ-01', kind: 'fast', command: 'node --version', expected_exit_code: 0 }]);
      addE2eCriterion(contractPath, 'node smoke.mjs', { timeoutMs: 900_000 });
      assert.deepEqual(readJson(contractPath).acceptance[1], { id: 'AC-02', requirement: 'REQ-01', kind: 'e2e', command: 'node smoke.mjs', expected_exit_code: 0, timeout_ms: 900_000 });

      const cli = spawnSync(process.execPath, [path.join(CRAFTHELM_ROOT, 'scripts', 'contract.mjs'), 'add-e2e', contractPath, '--e2e-cmd', 'node other.mjs', '--timeout-ms', 'soon'], { encoding: 'utf8', windowsHide: true });
      assert.equal(cli.status, 1);
      assert.match(cli.stderr, /--timeout-ms must be a whole number of milliseconds, at least 1000 \(got "soon"\)/);
    } finally {
      remove(repo);
    }
  });
});

describe('Contract approval and re-plan leave the records consistent', () => {
  it('writes nothing when the same actor approves an approved contract again, so an open run keeps its contract hash', () => {
    const repo = makeRepo();
    try {
      const contractPath = writeContract(repo, 'TWICE', [{ id: 'AC-01', requirement: 'REQ-01', kind: 'fast', command: 'node --version', expected_exit_code: 0 }]);
      const first = approveContractFile(contractPath, 'operator');
      assert.equal(first.already_approved, undefined);
      initCheckpoint({ repo, contract: contractPath, runId: 'TWICE-RUN' });
      const bytes = fs.readFileSync(contractPath, 'utf8');

      const again = approveContractFile(contractPath, 'operator');
      assert.deepEqual([again.already_approved, again.approved_at, again.contract_sha256], [true, first.approved_at, first.contract_sha256]);
      assert.match(again.note, /already approved and is the same as the approved copy; nothing was written\. A changed request is not in it/);
      assert.equal(fs.readFileSync(contractPath, 'utf8'), bytes);
      assert.equal(readJson(getCheckpointPath(repo, 'TWICE-RUN')).contract_sha256, again.contract_sha256);

      // Another approver is a new record.
      const other = approveContractFile(contractPath, 'reviewer');
      assert.deepEqual([other.already_approved, other.approved_by], [undefined, 'reviewer']);

      // An interview for a task that exists changes nothing, and says so.
      const existing = runInterview({ repo, taskId: 'TWICE', request: 'Also set val to 3' });
      assert.equal(existing.status, 'TASK_EXISTS');
      assert.match(existing.message, /already exists and was left as it is: nothing from this request or input file was applied\. Pass --overwrite/);
    } finally {
      remove(repo);
    }
  });

  it('re-plans with the log and the checkpoint agreeing, and writes neither when it cannot finish', () => {
    const repo = makeRepo();
    try {
      const contractPath = writeContract(repo, 'PLAN', [{ id: 'AC-01', requirement: 'REQ-01', kind: 'fast', command: 'node --version', expected_exit_code: 0 }]);
      approveContractFile(contractPath, 'operator');
      initCheckpoint({ repo, contract: contractPath, runId: 'PLAN-RUN' });
      const logPath = path.join(getRunDir(repo, 'PLAN-RUN'), 'approvals', 'replan-history.jsonl');

      // The amended contract is not approved yet: the re-plan stops before any record is written.
      addE2eCriterion(contractPath, 'node --version');
      assert.throws(() => replanRun({ repo, runId: 'PLAN-RUN', reason: 'Add smoke' }), /CONTRACT_NOT_APPROVED/);
      assert.equal(fs.existsSync(logPath), false);
      assert.deepEqual(readJson(getCheckpointPath(repo, 'PLAN-RUN')).replan_history, []);

      approveContractFile(contractPath, 'operator');
      fs.writeFileSync(path.join(repo, 'README.md'), '# Base, revised\n', 'utf8');
      const res = replanRun({ repo, runId: 'PLAN-RUN', reason: 'Add smoke' });
      const checkpoint = readJson(getCheckpointPath(repo, 'PLAN-RUN'));
      const logged = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(logged, checkpoint.replan_history);
      assert.deepEqual([logged.length, logged[0].new_contract_sha256, checkpoint.contract_sha256], [1, res.contract_sha256, res.contract_sha256]);
      // The source hashes come from the same read as the snapshot.
      assert.deepEqual(checkpoint.sot_hashes, { 'README.md': sha256File(path.join(repo, 'README.md')) });
      assert.equal(checkpoint.baseline_crafthelm_files['.crafthelm/contracts/PLAN.json'], sha256File(contractPath));
    } finally {
      remove(repo);
    }
  });
});

describe('Session status: short on every turn, and consistent', () => {
  const putRun = (repo, taskId, runId, state, allow) => {
    fs.mkdirSync(path.join(repo, '.crafthelm', 'contracts'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.crafthelm', 'contracts', `${taskId}.json`), JSON.stringify({ task_id: taskId, scope: { allow, protect: [] } }), 'utf8');
    fs.mkdirSync(getRunDir(repo, runId), { recursive: true });
    fs.writeFileSync(getCheckpointPath(repo, runId), JSON.stringify({ run_id: runId, task_id: taskId, state }), 'utf8');
  };

  it('spells out the open run, folds the runs waiting on a person into one line, and carries the writer id', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-status-'));
    try {
      putRun(repo, 'M1B', 'M1B-RUN', 'READY', ['src/**']);
      for (const id of ['M0A', 'M0B', 'M0C']) putRun(repo, id, `${id}-RUN`, 'READY_FOR_HUMAN_REVIEW', ['docs/**']);
      putRun(repo, 'M1', 'M1-RUN', 'BLOCKED_HUMAN_ATTENTION', ['lib/**']);

      const text = describeSessionStatus({ cwd: repo, event: 'UserPromptSubmit' });
      const lines = text.split('\n');
      assert.equal(lines.length, 8);
      // Several runs wait for acceptance: the reminder names the one command that decides them together.
      assert.match(lines[7], /^  The decision is the user's, made on a review page in their browser\. Give them this command to run in their own terminal \(the terminal panel of this app works\), as it is and in a code block: node ".*crafthelm\.mjs" review --repo ".*"\. Do not run it yourself, and do not just tell them to do it outside the session\.$/);
      assert.match(lines[0], /^CraftHelm: run M1B-RUN \(task M1B\) is READY\.$/);
      assert.match(lines[2], /verify --repo ".*" --run-id M1B-RUN --selective$/);
      assert.equal(lines[4], "CraftHelm: 4 other runs wait on a person's decision: M0A-RUN (READY_FOR_HUMAN_REVIEW), M0B-RUN (READY_FOR_HUMAN_REVIEW), M0C-RUN (READY_FOR_HUMAN_REVIEW), M1-RUN (BLOCKED_HUMAN_ATTENTION).");
      assert.match(lines[5], /never record their decision yourself\. This does not restrict the open run above\.$/);
      // The instruction that contradicted the open run is gone, and so is the scope of each waiting run.
      assert.doesNotMatch(text, /Do not edit files|docs\/\*\*|lib\/\*\*/);

      // With the lock held, the command the agent is told to run is one that will not be refused.
      acquireWriterLock({ repo, runId: 'M1B-RUN', writer: 'lead-1' });
      const locked = describeSessionStatus({ cwd: repo, event: 'UserPromptSubmit' });
      assert.match(locked, /verify --repo ".*" --run-id M1B-RUN --selective --writer lead-1\n/);
      assert.match(locked, /Writer lock held by "lead-1": verify, feedback and checkpoint commands on this run need --writer lead-1\./);

      // Nothing open: the waiting runs still share one line, and the next step is the user's.
      fs.rmSync(getRunDir(repo, 'M1B-RUN'), { recursive: true, force: true });
      const onlyWaiting = describeSessionStatus({ cwd: repo, event: 'UserPromptSubmit' });
      assert.match(onlyWaiting, /^CraftHelm: 4 runs wait on a person's decision: /);
      assert.match(onlyWaiting, /Do not edit files for them or re-verify them, and never record their decision yourself\. Report to the user/);
      assert.equal(onlyWaiting.split('\n').length, 4);
    } finally {
      remove(repo);
    }
  });

  it('has doctor check the hooks of the repository it is run in, without --repo', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-doctor-cwd-'));
    try {
      fs.mkdirSync(path.join(repo, '.crafthelm'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.crafthelm', 'config.json'), '{}\n', 'utf8');
      const res = spawnSync(process.execPath, [path.join(CRAFTHELM_ROOT, 'scripts', 'doctor.mjs'), '--host', 'claude', '--json'], { cwd: path.join(repo, '.crafthelm'), encoding: 'utf8', windowsHide: true });
      const codes = JSON.parse(res.stdout).warnings.map((w) => w.code);
      assert.ok(codes.includes('CLAUDE_SCOPE_HOOK_MISSING') && codes.includes('CLAUDE_STATUS_HOOK_MISSING'), codes.join(', '));
    } finally {
      remove(repo);
    }
  });
});

describe('Interview input: a requirement that cannot be read is refused, not printed as "undefined"', () => {
  it('rejects an item without id or statement, fills the optional fields, and puts the wording in the contract', () => {
    const defaults = { source: 'user_interview', approvedBy: 'pending_contract_approval' };
    assert.throws(() => normalizeRequirements([{ id: 'REQ-01', text: 'Convert tables' }], defaults),
      /INTERVIEW_INPUT_INVALID: requirements\[0\] needs a non-empty "statement" \(it has: id, text\)\. Expected \{ "id": "REQ-01", "statement": "what must be true" \}/);
    assert.throws(() => normalizeRequirements(['Convert tables'], defaults), /requirements\[0\] must be an object/);
    assert.throws(() => normalizeRequirements({ id: 'REQ-01' }, defaults), /"requirements" must be an array/);
    assert.throws(() => normalizeRequirements([{ id: 'A', statement: 'x' }, { id: 'A', statement: 'y' }], defaults), /requirements\[1\] repeats the id "A"/);
    assert.equal(normalizeRequirements(undefined, defaults), null);
    assert.deepEqual(normalizeRequirements([{ id: 'REQ-01', statement: 'Convert\n  tables' }], defaults), [
      { id: 'REQ-01', statement: 'Convert tables', source: 'user_interview', status: 'approved', assumption: 'none', approved_by: 'pending_contract_approval' },
    ]);

    const repo = makeRepo();
    try {
      const base = { request: 'Convert tables', acceptance: [{ id: 'AC-01', requirement: 'REQ-01', kind: 'test', command: 'node --version', expected_exit_code: 0 }] };
      const inputPath = path.join(repo, 'input.json');
      fs.writeFileSync(inputPath, JSON.stringify({ ...base, requirements: [{ id: 'REQ-01', text: 'Convert tables' }] }), 'utf8');
      const cli = spawnSync(process.execPath, [path.join(CRAFTHELM_ROOT, 'scripts', 'interview.mjs'), '--repo', repo, '--task-id', 'REQS', '--input', inputPath], { encoding: 'utf8', windowsHide: true });
      assert.equal(cli.status, 1);
      assert.match(cli.stderr, /^INTERVIEW_INPUT_INVALID: requirements\[0\] needs a non-empty "statement"/);
      assert.doesNotMatch(cli.stderr, /\n\s+at /);
      assert.equal(fs.existsSync(path.join(repo, '.crafthelm', 'contracts', 'REQS.json')), false);

      const res = runInterview({ repo, taskId: 'REQS', inputData: { ...base, requirements: [{ id: 'REQ-01', statement: 'Tables keep their | separators' }, { id: 'REQ-02', statement: 'Figures keep captions', source: 'spec.md' }] } });
      assert.equal(res.ok, true);
      assert.deepEqual(readJson(path.join(repo, '.crafthelm', 'contracts', 'REQS.json')).requirements, [
        { id: 'REQ-01', statement: 'Tables keep their | separators' },
        { id: 'REQ-02', statement: 'Figures keep captions' },
      ]);
      const doc = fs.readFileSync(path.join(repo, 'docs', 'tasks', 'REQS', 'requirements.md'), 'utf8');
      assert.doesNotMatch(doc, /undefined/);
      assert.match(doc, /\| REQ-01 \| Tables keep their \\\| separators \| user_interview \| approved \| none \| pending_contract_approval \|/);
      assert.match(doc, /\| REQ-02 \| Figures keep captions \| spec\.md \| approved \| none \| pending_contract_approval \|/);

      // With no requirements given, the request itself is the one requirement, in the contract too.
      const plain = runInterview({ repo, taskId: 'PLAINREQ', inputData: base });
      assert.deepEqual(readJson(plain.contract_path).requirements, [{ id: 'REQ-01', statement: 'Convert tables' }]);
    } finally {
      remove(repo);
    }
  });
});

describe('Requirement coverage: a requirement nothing checks is not reported as verified', () => {
  it('warns before approval, verifies as PARTIAL, and gives the requirement its own row in the review package', () => {
    const repo = makeRepo();
    try {
      const contractPath = writeContract(repo, 'COVER', [
        { id: 'AC-01', requirement: 'REQ-01', kind: 'e2e', command: 'node --version', expected_exit_code: 0 },
      ], {
        host: 'codex',
        requirements: [{ id: 'REQ-01', statement: 'Tables keep their | separators' }, { id: 'REQ-02', statement: 'Figures keep captions' }],
      });
      const contract = readJson(contractPath);
      const warning = checkContractReadiness(contract).warnings.find((w) => w.code === 'REQUIREMENT_WITHOUT_ACCEPTANCE');
      assert.match(warning.message, /^No acceptance check refers to REQ-02; verify will report it as unverified and the run will be PARTIAL, not VERIFIED\.$/);
      // A contract written before requirements were recorded has nothing to report.
      assert.ok(!checkContractReadiness({ ...contract, requirements: undefined }).warnings.some((w) => w.code === 'REQUIREMENT_WITHOUT_ACCEPTANCE'));

      approveContractFile(contractPath, 'operator');
      initCheckpoint({ repo, contract: contractPath, runId: 'COVER-RUN' });
      fs.writeFileSync(path.join(repo, 'src', 'app.mjs'), 'export const val = 2;\n', 'utf8');
      const v = runVerify({ repo, runId: 'COVER-RUN' });
      assert.equal(v.technical_status, 'PARTIAL');
      const stamp = readJson(path.join(getRunDir(repo, 'COVER-RUN'), 'evidence', 'verification-stamp.json'));
      assert.deepEqual(stamp.unverified, ['REQ-02 has no acceptance check (Figures keep captions)']);

      // The stages are timed, and the lite size limits say that they are not applied here.
      assert.deepEqual(Object.keys(v.stage_times_ms), ['snapshot of the working tree', 'scope and diff', 'impact analysis', 'acceptance checks', 'reliability rules and review', 'evidence records']);
      assert.ok(Object.values(v.stage_times_ms).every((ms) => Number.isInteger(ms) && ms >= 0));
      assert.deepEqual([v.process_profile.profile, v.process_profile.limits_enforced], ['full', false]);

      const pkg = publishReviewPackage({ repo, runId: 'COVER-RUN', kouetsuRoot: path.join(CRAFTHELM_ROOT, 'hosts', 'codex', 'skills', 'kouetsu') });
      const report = fs.readFileSync(path.join(getRunDir(repo, 'COVER-RUN'), 'reports', 'review-package.md'), 'utf8');
      assert.match(report, /\| `AC-01` \| `REQ-01` Tables keep their &#124; separators \| e2e \| PASS \|/);
      assert.match(report, /\| `REQ-02` \| Figures keep captions \| 수용 기준 없음 \| UNVERIFIED \| `none` \|/);
      assert.match(report, /\| 승인하면 달라지는 것 \| Set val to 2 \(이 중 `REQ-02`은 수용 기준이 없어 검증되지 않았습니다\) \|/);
      // The command a person copies runs from the target repository, not only from the CraftHelm checkout.
      const cliPath = path.join(CRAFTHELM_ROOT, 'scripts', 'crafthelm.mjs').replace(/\\/g, '/');
      assert.ok(report.includes(`node "${cliPath}" approve record --repo "${repo.replace(/\\/g, '/')}" --run-id COVER-RUN --decision accept`), pkg.status);
      assert.doesNotMatch(report, /node scripts\/approval\.mjs record/);
    } finally {
      remove(repo);
    }
  });
});

describe('Snapshot: the tree git sees', () => {
  it('follows tracked and untracked files, leaves ignored ones out, and still walks a directory that is not a repository', () => {
    const repo = makeRepo();
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-plain-'));
    try {
      const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text, 'utf8'); };
      write('.gitignore', 'output/\n');
      const hashed = new Map();
      const base = computeSnapshotDigest(repo, { fileHashes: hashed });

      // Build output under an ignored directory neither changes the snapshot nor is read.
      write('output/page-0001.json', '{}');
      const again = new Map();
      assert.equal(computeSnapshotDigest(repo, { fileHashes: again }), base);
      assert.deepEqual([...again.keys()].sort(), ['.gitignore', 'README.md', 'src/app.mjs']);

      // An untracked file that is not ignored counts, under its real name, and so does an edit or a deletion.
      write('src/새 파일.mjs', 'export {};\n');
      const withNew = new Map();
      const afterNew = computeSnapshotDigest(repo, { fileHashes: withNew });
      assert.notEqual(afterNew, base);
      assert.ok(withNew.has('src/새 파일.mjs'));
      write('src/app.mjs', 'export const val = 2;\n');
      const afterEdit = computeSnapshotDigest(repo);
      assert.notEqual(afterEdit, afterNew);
      fs.rmSync(path.join(repo, 'README.md'));
      assert.notEqual(computeSnapshotDigest(repo), afterEdit);

      // Not a repository: nothing says what to ignore, so every file is taken.
      fs.writeFileSync(path.join(plain, 'a.txt'), 'a', 'utf8');
      const first = computeSnapshotDigest(plain);
      fs.mkdirSync(path.join(plain, 'output'));
      fs.writeFileSync(path.join(plain, 'output', 'b.txt'), 'b', 'utf8');
      assert.notEqual(computeSnapshotDigest(plain), first);
    } finally {
      remove(repo);
      remove(plain);
    }
  });
});
