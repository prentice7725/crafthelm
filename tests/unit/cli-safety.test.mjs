import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { initCheckpoint, recordRepairRound } from '../../scripts/checkpoint.mjs';
import { approveContractFile, validateContractFile } from '../../scripts/contract.mjs';
import { DEFAULT_CLI_TIMEOUT_MS, resolveCommandTimeoutMs } from '../../scripts/crafthelm.mjs';
import { runInterview } from '../../scripts/interview.mjs';
import { runVerify } from '../../scripts/verify.mjs';
import { isHelpRequested } from '../../scripts/lib/cli.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { rebuildMemoryIndex, searchMemory } from '../../scripts/lib/memory.mjs';
import { CRAFTHELM_ROOT, getCheckpointPath } from '../../scripts/lib/paths.mjs';

const CRAFTHELM_CLI = path.join(CRAFTHELM_ROOT, 'scripts', 'crafthelm.mjs');

const ALL_SUBCOMMANDS = [
  'start',
  'status',
  'doctor',
  'init-host',
  'install-skills',
  'interview',
  'contract',
  'checkpoint',
  'impact',
  'route',
  'delegate',
  'verify',
  'feedback',
  'review-package',
  'approve',
  'memory',
  'skills',
  'benchmark',
  'calibrate',
];

function createTempRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-cli-safety-'));
  runGit(dir, ['init', '-b', 'main']);
  runGit(dir, ['config', 'user.name', 'CraftHelm Test']);
  runGit(dir, ['config', 'user.email', 'test@crafthelm.local']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'Initial test commit']);
  return dir;
}

describe('Batch 1 CLI Safety, Task Isolation, E2E Readiness & Timeout Separation', () => {
  it('verifies two uncommitted tasks independently and still reports edits to sibling documents', () => {
    const repo = createTempRepo({ 'README.md': '# Concurrent tasks\n' });
    try {
      const first = runInterview({ repo, request: 'First task', e2eCommand: 'node --version', approveContract: true });
      initCheckpoint({ repo, contract: first.contract_path, runId: 'ONE' });
      const second = runInterview({ repo, request: 'Second task', e2eCommand: 'node --version', docsDir: 'docs/second' });
      assert.deepEqual(runVerify({ repo, runId: 'ONE' }).failure_reasons, []);
      approveContractFile(second.contract_path, 'operator');
      initCheckpoint({ repo, contract: second.contract_path, docsDir: second.docs_dir, runId: 'TWO' });
      for (const runId of ['ONE', 'TWO']) {
        assert.deepEqual(runVerify({ repo, runId }).failure_reasons, []);
      }
      // A run created before generation receipts existed has only its frozen baseline.
      fs.unlinkSync(path.join(repo, '.crafthelm', 'runs', '.interviews', first.task_id + '.json'));
      assert.deepEqual(runVerify({ repo, runId: 'TWO' }).failure_reasons, []);
      fs.appendFileSync(path.join(repo, second.docs_dir, 'requirements.md'), 'Manual edit\n');
      const edited = runVerify({ repo, runId: 'ONE' });
      assert.ok(edited.failure_reasons.some(r => r.includes('SCOPE_VIOLATION') && r.includes('docs/second/requirements.md')));
      fs.writeFileSync(path.join(repo, second.docs_dir, 'extra.md'), 'Unexpected file\n');
      const manuallyEdited = JSON.parse(fs.readFileSync(second.contract_path, 'utf8'));
      manuallyEdited.title = 'Operator edit';
      fs.writeFileSync(second.contract_path, JSON.stringify(manuallyEdited), 'utf8');
      approveContractFile(second.contract_path, 'operator');
      const reasons = runVerify({ repo, runId: 'ONE' }).failure_reasons;
      assert.ok(reasons.some(r => r.includes('docs/second/extra.md')));
      assert.ok(reasons.some(r => r.includes(`.crafthelm/contracts/${second.task_id}.json`)));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('refuses repeated initialization through both CLIs without changing the contract or repair history', () => {
    const repo = createTempRepo({ 'README.md': '# Retry\n' });
    try {
      const iv = runInterview({ repo, request: 'Retry task', e2eCommand: 'node --version', approveContract: true });
      const cp = initCheckpoint({ repo, contract: iv.contract_path });
      recordRepairRound({ repo, runId: cp.run_id, cause: 'test', check: 'AC-01', command: 'node --version' });
      const cpFile = getCheckpointPath(repo, cp.run_id);
      const before = fs.readFileSync(cpFile, 'utf8');
      assert.equal(JSON.parse(before).repair_rounds.test, 1);
      const contract = fs.readFileSync(iv.contract_path, 'utf8');
      for (const args of [
        ['checkpoint', 'init', '--contract', iv.contract_path],
        ['contract', 'approve', iv.contract_path, '--actor', 'tester', '--init-run'],
      ]) {
        const cli = spawnSync(process.execPath, [CRAFTHELM_CLI, ...args, '--repo', repo], { encoding: 'utf8' });
        assert.equal(cli.status, 1);
        assert.match(cli.stderr, /RUN_EXISTS.*checkpoint resume/);
        assert.equal(fs.readFileSync(cpFile, 'utf8'), before);
        assert.equal(fs.readFileSync(iv.contract_path, 'utf8'), contract);
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects a non-applicable E2E at strict approval and amends only acceptance and approval', () => {
    const repo = createTempRepo({ 'README.md': '# E2E amendment\n' });
    try {
      const iv = runInterview({
        repo, request: 'Fix calculation', changeKind: 'bugfix', docsDir: 'notes/task',
        inputData: {
          scope: { allow: ['src/calc.mjs'], protect: ['README.md'] },
          acceptance: [{ id: 'AC-01', requirement: 'REQ-02', kind: 'e2e', applicable: false, not_applicable_reason: 'Unavailable' }],
        },
      });
      assert.equal(validateContractFile(iv.contract_path).policy_ready, false);
      assert.throws(() => approveContractFile(iv.contract_path, 'tester', { strictReadiness: true }), /E2E_MISSING/);
      const before = JSON.parse(fs.readFileSync(iv.contract_path, 'utf8'));
      approveContractFile(iv.contract_path, 'tester');
      const acDoc = path.join(repo, iv.docs_dir, 'acceptance.md');
      fs.appendFileSync(acDoc, '\nOperator note\n');
      for (let i = 0; i < 2; i++) {
        const cli = spawnSync(process.execPath, [CRAFTHELM_CLI, 'contract', 'add-e2e', iv.contract_path, '--e2e-cmd', 'node --version'], { encoding: 'utf8' });
        assert.equal(cli.status, 0, cli.stderr);
        assert.equal(JSON.parse(cli.stdout).policy_ready, true);
      }
      const after = JSON.parse(fs.readFileSync(iv.contract_path, 'utf8'));
      const added = after.acceptance.pop();
      assert.equal(added.id, 'AC-02');
      assert.equal(added.requirement, 'REQ-02');
      assert.equal(added.command, 'node --version');
      assert.deepEqual(after, before);
      const doc = fs.readFileSync(acDoc, 'utf8');
      assert.match(doc, /Operator note/);
      assert.equal(doc.split('| AC-02 |').length, 2);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('handles --help and -h without creating any files across top-level and all 15 subcommands', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-help-home-'));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-help-cwd-'));
    const env = {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
    };

    try {
      assert.equal(isHelpRequested(['--help']), true);
      assert.equal(isHelpRequested(['search', '-h']), true);
      assert.equal(isHelpRequested(['--', '--help']), false);

      for (const flag of ['--help', '-h']) {
        const top = spawnSync(process.execPath, [CRAFTHELM_CLI, flag], {
          cwd: workDir,
          env,
          encoding: 'utf8',
          windowsHide: true,
        });
        assert.equal(top.status, 0, `top-level ${flag} failed: ${top.stderr}`);
        assert.match(top.stdout, /Usage:/);
      }

      for (const sub of ALL_SUBCOMMANDS) {
        for (const flag of ['--help', '-h']) {
          const res = spawnSync(process.execPath, [CRAFTHELM_CLI, sub, flag], {
            cwd: workDir,
            env,
            encoding: 'utf8',
            windowsHide: true,
          });
          assert.equal(res.status, 0, `${sub} ${flag} exited with ${res.status}: ${res.stderr}`);
          assert.match(res.stdout, /Usage:/i, `${sub} ${flag} missing Usage text`);
        }
      }

      // Specific subcommand-with-args --help check (install-skills --targets claude --help & memory search --help)
      const nestedHelp = spawnSync(process.execPath, [CRAFTHELM_CLI, 'install-skills', '--targets', 'claude', '--help'], {
        cwd: workDir,
        env,
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(nestedHelp.status, 0);
      assert.match(nestedHelp.stdout, /Usage:/i);

      const memNested = spawnSync(process.execPath, [CRAFTHELM_CLI, 'memory', 'search', '-h'], {
        cwd: workDir,
        env,
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(memNested.status, 0);
      assert.match(memNested.stdout, /Usage:/i);

      assert.deepEqual(fs.readdirSync(homeDir), []);
      assert.deepEqual(fs.readdirSync(workDir), []);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('prevents second interview from overwriting prior task contract or docs and indexes both tasks', () => {
    const repo = createTempRepo({
      'README.md': '# Multi Task Repo\n',
      'package.json': JSON.stringify({ name: 'multi-task-demo', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2),
    });

    try {
      const iv1 = runInterview({
        repo,
        request: 'First feature request: implement login audit',
        host: 'generic',
      });
      assert.equal(iv1.ok, true);
      assert.equal(iv1.task_id, 'CH-T001');
      assert.equal(iv1.docs_dir, 'docs/tasks/CH-T001');

      const iv2 = runInterview({
        repo,
        request: 'Second feature request: add rate limiter',
        host: 'generic',
      });
      assert.equal(iv2.ok, true);
      assert.equal(iv2.task_id, 'CH-T002');
      assert.equal(iv2.docs_dir, 'docs/tasks/CH-T002');

      const c1 = JSON.parse(fs.readFileSync(iv1.contract_path, 'utf8'));
      const c2 = JSON.parse(fs.readFileSync(iv2.contract_path, 'utf8'));
      assert.equal(c1.request, 'First feature request: implement login audit');
      assert.equal(c2.request, 'Second feature request: add rate limiter');

      const req1 = fs.readFileSync(path.join(repo, 'docs', 'tasks', 'CH-T001', 'requirements.md'), 'utf8');
      const req2 = fs.readFileSync(path.join(repo, 'docs', 'tasks', 'CH-T002', 'requirements.md'), 'utf8');
      assert.match(req1, /login audit/);
      assert.doesNotMatch(req1, /rate limiter/);
      assert.match(req2, /rate limiter/);

      // Explicit collision without --overwrite must be blocked
      const collision = runInterview({
        repo,
        taskId: 'CH-T001',
        request: 'Accidental overwrite attempt',
        host: 'generic',
      });
      assert.equal(collision.ok, false);
      assert.equal(collision.status, 'TASK_EXISTS');
      assert.equal(
        JSON.parse(fs.readFileSync(iv1.contract_path, 'utf8')).request,
        'First feature request: implement login audit',
      );

      // Explicit --overwrite updates the specified task contract
      const updated = runInterview({
        repo,
        taskId: 'CH-T001',
        request: 'Updated login audit specification',
        host: 'generic',
        overwrite: true,
      });
      assert.equal(updated.ok, true);
      assert.equal(
        JSON.parse(fs.readFileSync(iv1.contract_path, 'utf8')).request,
        'Updated login audit specification',
      );

      // Memory index scans both task-scoped doc folders
      rebuildMemoryIndex({ repo });
      const search1 = searchMemory({ repo, query: 'Updated login audit' });
      const search2 = searchMemory({ repo, query: 'rate limiter' });
      assert.ok(search1.hits.some((h) => h.source_path === 'docs/tasks/CH-T001/requirements.md'));
      assert.ok(search2.hits.some((h) => h.source_path === 'docs/tasks/CH-T002/requirements.md'));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('surfaces E2E_MISSING warning early in interview/contract validate and clears when --e2e-cmd is provided', () => {
    const repo = createTempRepo({
      'README.md': '# E2E Readiness Demo\n',
      'tests/e2e.test.mjs': 'process.exit(0);\n',
    });

    try {
      const ivNoE2e = runInterview({
        repo,
        request: 'Build user profile page',
        host: 'generic',
      });
      assert.equal(ivNoE2e.ok, true);
      assert.equal(ivNoE2e.policy_ready, false);
      assert.equal(ivNoE2e.warnings[0].code, 'E2E_MISSING');
      assert.equal(ivNoE2e.next_questions.length, 1);

      const v1 = validateContractFile(ivNoE2e.contract_path);
      assert.equal(v1.valid, true);
      assert.equal(v1.policy_ready, false);
      assert.equal(v1.warnings[0].code, 'E2E_MISSING');

      assert.throws(
        () => approveContractFile(ivNoE2e.contract_path, 'operator', { strictReadiness: true }),
        /CONTRACT_POLICY_NOT_READY/,
      );

      const ivWithE2e = runInterview({
        repo,
        request: 'Build user profile page with smoke test',
        host: 'generic',
        e2eCommand: 'node tests/e2e.test.mjs',
      });
      assert.equal(ivWithE2e.ok, true);
      assert.equal(ivWithE2e.task_id, 'CH-T002');
      assert.equal(ivWithE2e.policy_ready, true);
      assert.deepEqual(ivWithE2e.warnings, []);
      assert.deepEqual(ivWithE2e.next_questions, []);

      const v2 = validateContractFile(ivWithE2e.contract_path);
      assert.equal(v2.valid, true);
      assert.equal(v2.policy_ready, true);
      const c2 = JSON.parse(fs.readFileSync(ivWithE2e.contract_path, 'utf8'));
      assert.ok(c2.acceptance.some((a) => a.kind === 'e2e' && a.command === 'node tests/e2e.test.mjs'));

      const approved = approveContractFile(ivWithE2e.contract_path, 'operator', { strictReadiness: true });
      assert.equal(approved.ok, true);
      assert.equal(approved.policy_ready, true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('separates long-running CLI timeouts and streams verify progress on stderr without breaking stdout JSON', () => {
    assert.equal(resolveCommandTimeoutMs('verify', {}), 0);
    assert.equal(resolveCommandTimeoutMs('feedback', {}), 0);
    assert.equal(resolveCommandTimeoutMs('benchmark', {}), 0);
    assert.equal(resolveCommandTimeoutMs('interview', {}), DEFAULT_CLI_TIMEOUT_MS);
    assert.equal(resolveCommandTimeoutMs('interview', { CRAFTHELM_CLI_TIMEOUT_MS: '45000' }), 45000);
    assert.equal(resolveCommandTimeoutMs('verify', { CRAFTHELM_CLI_TIMEOUT_MS: '90000' }), 90000);

    const repo = createTempRepo({
      'README.md': '# Verify Streaming Demo\n',
      'src/app.mjs': 'export const value = 1;\n',
      'tests/unit.test.mjs': 'process.exit(0);\n',
      'tests/e2e.test.mjs': 'process.exit(0);\n',
    });

    try {
      const iv = runInterview({
        repo,
        request: 'Verify stderr streaming progress output',
        host: 'generic',
        inputData: {
          scope: { allow: ['src/**'], protect: ['README.md'] },
          acceptance: [
            { id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node tests/unit.test.mjs' },
            { id: 'AC-02', requirement: 'REQ-01', kind: 'e2e', command: 'node tests/e2e.test.mjs' },
          ],
        },
      });
      approveContractFile(iv.contract_path, 'operator');
      initCheckpoint({ repo, contract: iv.contract_path, runId: 'RUN-STREAM' });

      const res = spawnSync(process.execPath, [CRAFTHELM_CLI, 'verify', '--repo', repo, '--run-id', 'RUN-STREAM'], {
        cwd: repo,
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(res.status, 0, `verify CLI failed: ${res.stderr}`);
      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.technical_status, 'VERIFIED');
      assert.match(res.stderr, /\[verify\] Running AC-01 \(unit\): node tests\/unit\.test\.mjs/);
      assert.match(res.stderr, /\[verify\] AC-02 -> PASS/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
