import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { initCheckpoint } from '../../scripts/checkpoint.mjs';
import { approveContractFile, validateContractFile } from '../../scripts/contract.mjs';
import { DEFAULT_CLI_TIMEOUT_MS, resolveCommandTimeoutMs } from '../../scripts/crafthelm.mjs';
import { runInterview } from '../../scripts/interview.mjs';
import { isHelpRequested } from '../../scripts/lib/cli.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { rebuildMemoryIndex, searchMemory } from '../../scripts/lib/memory.mjs';
import { CRAFTHELM_ROOT } from '../../scripts/lib/paths.mjs';

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
