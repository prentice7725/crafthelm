import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { initCheckpoint } from '../../scripts/checkpoint.mjs';
import { approveContractFile } from '../../scripts/contract.mjs';
import { sha256Buffer, sha256File } from '../../scripts/lib/crypto.mjs';
import { computeSnapshotDigest, runGit } from '../../scripts/lib/git.mjs';
import { CRAFTHELM_ROOT, cliInvocation, getCheckpointPath } from '../../scripts/lib/paths.mjs';
import { evaluateWrite } from '../../scripts/lib/scope-guard.mjs';
import { runVerify } from '../../scripts/verify.mjs';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-baseline-'));
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['config', 'user.name', 'CraftHelm Test']);
  runGit(repo, ['config', 'user.email', 'test@crafthelm.local']);
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content, 'utf8');
  };
  write('src/app.mjs', 'export const val = 1;\n');
  write('infra/deploy.yml', 'replicas: 1\n');
  write('README.md', '# Baseline\n');
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-m', 'Base']);
  return { repo, write };
}

function writeContract(repo, taskId) {
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
    acceptance: [{ id: 'AC-01', requirement: 'REQ-01', kind: 'fast', command: 'node --version', expected_exit_code: 0 }],
    source_policy: { authority: ['git-main'], source_refs: ['README.md'] },
  }, null, 2));
  approveContractFile(contractPath, 'operator');
  return contractPath;
}

describe('Baseline ref: work committed before the run was opened is still verified', () => {
  it('starts the run at an earlier commit, so scope and the diff cover what was already committed', () => {
    const { repo, write } = makeRepo();
    try {
      const base = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim();
      // The agent skipped the procedure: it committed the change, and an out-of-scope edit with it.
      write('src/app.mjs', 'export const val = 2;\n');
      write('infra/deploy.yml', 'replicas: 9\n');
      runGit(repo, ['add', '.']);
      runGit(repo, ['commit', '-m', 'Work done before any contract']);
      const head = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim();

      // Opened the usual way, the run starts after that work and sees nothing.
      const late = writeContract(repo, 'LATE');
      initCheckpoint({ repo, contract: late, runId: 'LATE-RUN' });
      assert.equal(readJson(getCheckpointPath(repo, 'LATE-RUN')).baseline_git_head, head);
      const blind = runVerify({ repo, runId: 'LATE-RUN' });
      assert.equal(blind.scope_status, 'PASS');

      // With the baseline moved back, the same tree fails on the out-of-scope file.
      const early = writeContract(repo, 'EARLY');
      initCheckpoint({ repo, contract: early, runId: 'EARLY-RUN', baselineRef: 'HEAD~1' });
      assert.equal(readJson(getCheckpointPath(repo, 'EARLY-RUN')).baseline_git_head, base);
      const seen = runVerify({ repo, runId: 'EARLY-RUN' });
      assert.equal(seen.scope_status, 'FAIL');
      assert.match(seen.failure_reasons.join('; '), /SCOPE_VIOLATION: .*infra\/deploy\.yml/);

      // The baseline moves back along the current history only.
      const bad = writeContract(repo, 'BAD');
      assert.throws(() => initCheckpoint({ repo, contract: bad, runId: 'BAD-RUN-1', baselineRef: 'no-such-ref' }), /BASELINE_REF_INVALID: "no-such-ref" is not a commit/);
      runGit(repo, ['switch', '-q', '--orphan', 'elsewhere']);
      write('other.txt', 'x\n');
      runGit(repo, ['add', 'other.txt']);
      runGit(repo, ['commit', '-m', 'Unrelated history']);
      const unrelated = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim();
      runGit(repo, ['switch', '-q', '-f', 'main']);
      assert.throws(() => initCheckpoint({ repo, contract: bad, runId: 'BAD-RUN-2', baselineRef: unrelated }), /BASELINE_REF_INVALID: .* is not an ancestor of HEAD/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('Hashing: one read per file, and commands that work from the target repository', () => {
  it('hashes in chunks to the same digest, and a shared map changes nothing but the number of reads', () => {
    const { repo, write } = makeRepo();
    try {
      // Larger than one read chunk, with a tail that is not chunk-aligned.
      const big = Buffer.alloc(9 * 1024 * 1024 + 13, 7);
      fs.writeFileSync(path.join(repo, 'big.bin'), big);
      assert.equal(sha256File(path.join(repo, 'big.bin')), sha256Buffer(big));
      write('empty.txt', '');
      assert.equal(sha256File(path.join(repo, 'empty.txt')), sha256Buffer(Buffer.alloc(0)));

      const fileHashes = new Map();
      const digest = computeSnapshotDigest(repo, { fileHashes });
      assert.equal(digest, computeSnapshotDigest(repo));
      assert.equal(fileHashes.get('big.bin'), sha256Buffer(big));
      assert.ok(fileHashes.has('src/app.mjs'));
      // The map is trusted as given: that is why callers use it only where nothing ran in between.
      fileHashes.set('big.bin', 'f'.repeat(64));
      assert.notEqual(computeSnapshotDigest(repo, { fileHashes }), digest);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('prints next commands with the absolute CLI path when called from another directory', () => {
    assert.equal(cliInvocation(CRAFTHELM_ROOT), 'node scripts/crafthelm.mjs');
    const { repo } = makeRepo();
    try {
      assert.match(cliInvocation(repo), /^node ".*\/scripts\/crafthelm\.mjs"$/);
      writeContract(repo, 'NEXT');
      const res = spawnSync(process.execPath, [path.join(CRAFTHELM_ROOT, 'scripts', 'crafthelm.mjs'), 'status', '--repo', '.', '--json'], { cwd: repo, encoding: 'utf8', windowsHide: true });
      assert.equal(res.status, 0);
      const next = JSON.parse(res.stdout).next_command;
      assert.match(next, /^node ".*\/scripts\/crafthelm\.mjs" checkpoint init /);
      assert.equal(fs.existsSync(path.join(repo, 'scripts', 'crafthelm.mjs')), false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('require_run_for_edits: a repository can refuse edits until a run is open', () => {
  it('is off by default, and when set blocks file-tool writes with no run in progress', () => {
    const { repo } = makeRepo();
    try {
      const configPath = path.join(repo, '.crafthelm', 'config.json');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ schema_version: '0.3' }), 'utf8');
      const at = (rel) => evaluateWrite({ filePath: path.join(repo, rel), isIgnored: (_root, r) => r.startsWith('scratch/') });
      assert.equal(at('src/app.mjs').code, 'NO_ACTIVE_RUN');

      fs.writeFileSync(configPath, JSON.stringify({ schema_version: '0.3', require_run_for_edits: true }), 'utf8');
      const blocked = at('src/app.mjs');
      assert.deepEqual([blocked.decision, blocked.code], ['deny', 'RUN_REQUIRED']);
      assert.match(blocked.reason, /requires an open CraftHelm run .* start "<task>" --repo /);
      assert.equal(at('scratch/notes.txt').code, 'GIT_IGNORED');
      // The switch itself is a control file, so an agent cannot turn it off with a file tool.
      assert.equal(at('.crafthelm/config.json').code, 'CONTROL_FILE');

      // With a run open, the contract scope decides as before.
      const contractPath = writeContract(repo, 'OPEN');
      initCheckpoint({ repo, contract: contractPath, runId: 'OPEN-RUN' });
      assert.equal(at('src/app.mjs').code, 'IN_SCOPE');
      assert.equal(at('infra/deploy.yml').code, 'OUT_OF_SCOPE');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
