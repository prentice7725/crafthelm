import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { initCheckpoint } from '../../scripts/checkpoint.mjs';
import { approveContractFile } from '../../scripts/contract.mjs';
import { runDoctor } from '../../scripts/doctor.mjs';
import { initHost } from '../../scripts/init-host.mjs';
import { installSkills } from '../../scripts/install-skills.mjs';
import { SCOPE_GUARD_MATCHER, applyClaudeScopeHook, inspectClaudeScopeHook, scopeGuardCommand } from '../../scripts/lib/claude-hooks.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { CRAFTHELM_ROOT, getCheckpointPath } from '../../scripts/lib/paths.mjs';
import { evaluateHookPayload, evaluateWrite, listActiveScopes } from '../../scripts/lib/scope-guard.mjs';

const HOOK_SCRIPT = path.join(CRAFTHELM_ROOT, 'scripts', 'hooks', 'scope-guard.mjs');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-guard-'));
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['config', 'user.name', 'CraftHelm Test']);
  runGit(repo, ['config', 'user.email', 'test@crafthelm.local']);
  const files = {
    '.gitignore': '.crafthelm/runs/\nscratch/\n',
    'src/app.mjs': 'export const val = 1;\n',
    'src/generated/schema.mjs': 'export const schema = 1;\n',
    'migrations/001.sql': 'select 1;\n',
    'README.md': '# Guard\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content, 'utf8');
  }
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-m', 'Baseline commit']);
  return repo;
}

function startRun(repo, taskId, runId, scope) {
  const contractPath = path.join(repo, '.crafthelm', 'contracts', `${taskId}.json`);
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(contractPath, JSON.stringify({
    schema_version: '0.3',
    task_id: taskId,
    request: 'Set val to 2',
    project_root: '.',
    host: 'claude',
    change_kind: 'bugfix',
    methodology: { lifecycle: 'incremental', specification: 'lightweight', engineering: 'tdd', execution: 'full' },
    scope,
    approval: { contract_approved: false, require_on: ['scope_change'] },
    budgets: { max_worker_retries_per_cause: 3, max_lead_escalations: 3, max_wall_minutes: 30 },
    acceptance: [{ id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node --version', expected_exit_code: 0 }],
    source_policy: { authority: ['git-main'], source_refs: ['README.md'] },
    verification_policy: { require_e2e_for_functional: false },
  }, null, 2));
  approveContractFile(contractPath, 'operator');
  initCheckpoint({ repo, contract: contractPath, runId });
}

function runHook(payload) {
  return spawnSync(process.execPath, [HOOK_SCRIPT], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', windowsHide: true });
}

describe('Scope guard: the contract scope applied before the write', () => {
  it('allows everything while no run is active, then holds writes to the active contract scope', () => {
    const repo = makeRepo();
    try {
      const at = (rel) => evaluateWrite({ filePath: path.join(repo, rel) });
      assert.equal(at('README.md').code, 'NOT_A_CRAFTHELM_REPO');

      startRun(repo, 'GUARD', 'GUARD-RUN', { allow: ['src/**'], protect: ['src/generated/**'] });
      assert.deepEqual(listActiveScopes(repo), [{ run_id: 'GUARD-RUN', task_id: 'GUARD', allow: ['src/**'], protect: ['src/generated/**'] }]);

      assert.deepEqual([at('src/app.mjs').decision, at('src/app.mjs').code], ['allow', 'IN_SCOPE']);
      assert.deepEqual([at('src/new/feature.mjs').decision, at('src/new/feature.mjs').code], ['allow', 'IN_SCOPE']);
      // Protected wins over allowed.
      assert.deepEqual([at('src/generated/schema.mjs').decision, at('src/generated/schema.mjs').code], ['deny', 'PROTECTED_PATH']);
      const outside = at('migrations/001.sql');
      assert.deepEqual([outside.decision, outside.code], ['deny', 'OUT_OF_SCOPE']);
      assert.match(outside.reason, /migrations\/001\.sql is outside scope\.allow \(src\/\*\*\) of the active run GUARD-RUN/);
      // The contract itself and the Claude settings that register the guard are outside the scope too.
      assert.equal(at('.crafthelm/contracts/GUARD.json').code, 'OUT_OF_SCOPE');
      assert.equal(at('.claude/settings.json').code, 'OUT_OF_SCOPE');
      // git does not track it, so verify would not see it either.
      assert.equal(at('scratch/notes.txt').code, 'GIT_IGNORED');
      // Relative paths resolve against the session directory; a path outside any CraftHelm repo is not ours.
      assert.equal(evaluateWrite({ filePath: 'migrations/002.sql', cwd: repo }).code, 'OUT_OF_SCOPE');
      assert.equal(evaluateWrite({ filePath: path.join(os.tmpdir(), 'elsewhere.txt') }).decision, 'allow');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('never lets a file tool write evidence or an approval record, and releases the scope when the run ends', () => {
    const repo = makeRepo();
    try {
      startRun(repo, 'OWN', 'OWN-RUN', { allow: ['src/**'], protect: [] });
      const at = (rel) => evaluateWrite({ filePath: path.join(repo, rel) });
      for (const rel of ['approvals/decision.json', 'checkpoint.json', 'evidence-manifest.json', 'evidence/verification-stamp.json', 'evidence/tests/AC-01.stdout.txt']) {
        assert.equal(at(`.crafthelm/runs/OWN-RUN/${rel}`).code, 'SCRIPT_OWNED_ARTIFACT', rel);
      }
      // The advisory reviewer writes its findings here.
      assert.equal(at('.crafthelm/runs/OWN-RUN/evidence/review.json').code, 'RUN_WORKSPACE');

      const checkpointPath = getCheckpointPath(repo, 'OWN-RUN');
      fs.writeFileSync(checkpointPath, JSON.stringify({ ...readJson(checkpointPath), state: 'ACCEPTED' }), 'utf8');
      assert.deepEqual(listActiveScopes(repo), []);
      assert.equal(at('migrations/001.sql').code, 'NO_ACTIVE_RUN');
      // Script-owned files stay off limits after the run has ended.
      assert.equal(at('.crafthelm/runs/OWN-RUN/approvals/decision.json').decision, 'deny');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('as a hook process: exit 2 with a reason blocks, exit 0 allows, and a bad payload fails open', () => {
    const repo = makeRepo();
    try {
      startRun(repo, 'HOOK', 'HOOK-RUN', { allow: ['src/**'], protect: [] });
      const blocked = runHook({ tool_name: 'Write', tool_input: { file_path: path.join(repo, 'migrations', '002.sql') }, cwd: repo });
      assert.equal(blocked.status, 2);
      assert.match(blocked.stderr, /CraftHelm scope guard blocked this write \(OUT_OF_SCOPE\): migrations\/002\.sql/);

      const allowed = runHook({ tool_name: 'Edit', tool_input: { file_path: 'src/app.mjs' }, cwd: repo });
      assert.deepEqual([allowed.status, allowed.stderr], [0, '']);
      assert.equal(runHook({ tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(repo, 'analysis.ipynb') }, cwd: repo }).status, 2);

      assert.equal(evaluateHookPayload({ tool_name: 'Bash', tool_input: { command: 'ls' } }).code, 'NO_FILE_PATH');
      const garbled = runHook('not json');
      assert.equal(garbled.status, 0);
      assert.match(garbled.stderr, /scope guard skipped/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('Scope guard registration in Claude project settings', () => {
  it('adds one hook group beside existing hooks, is idempotent, and repoints an entry from another checkout', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-hook-'));
    try {
      const settingsPath = path.join(dir, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const own = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] };
      fs.writeFileSync(settingsPath, JSON.stringify({ model: 'opus', hooks: { PreToolUse: [own], Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } }));
      const command = scopeGuardCommand();
      assert.match(command, /^node ".*\/scripts\/hooks\/scope-guard\.mjs"$/);
      assert.equal(inspectClaudeScopeHook({ repoRoot: dir }).status, 'MISSING');

      assert.equal(applyClaudeScopeHook({ settingsPath, dryRun: true }).action, 'WOULD_ADD');
      assert.equal(readJson(settingsPath).hooks.PreToolUse.length, 1);

      assert.equal(applyClaudeScopeHook({ settingsPath }).action, 'ADDED');
      const after = readJson(settingsPath);
      assert.equal(after.model, 'opus');
      assert.deepEqual(after.hooks.PreToolUse, [own, { matcher: SCOPE_GUARD_MATCHER, hooks: [{ type: 'command', command }] }]);
      assert.equal(after.hooks.Stop.length, 1);
      assert.equal(inspectClaudeScopeHook({ repoRoot: dir }).status, 'REGISTERED');
      assert.equal(applyClaudeScopeHook({ settingsPath }).action, 'UNCHANGED');

      // The same settings seen from a CraftHelm checkout at another path.
      const moved = path.join(dir, 'moved-crafthelm');
      assert.equal(inspectClaudeScopeHook({ repoRoot: dir, crafthelmRoot: moved }).status, 'STALE');
      assert.equal(applyClaudeScopeHook({ settingsPath, crafthelmRoot: moved }).action, 'UPDATED');
      const repointed = readJson(settingsPath).hooks.PreToolUse;
      assert.equal(repointed.length, 2);
      assert.equal(repointed[1].hooks[0].command, scopeGuardCommand(moved));

      const broken = path.join(dir, 'broken.json');
      fs.writeFileSync(broken, '{ "hooks": [] }');
      assert.equal(applyClaudeScopeHook({ settingsPath: broken }).action, 'SKIPPED_INVALID');
      assert.equal(fs.readFileSync(broken, 'utf8'), '{ "hooks": [] }');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('init-host and project-scope install register it, user-scope install does not, and doctor reports a missing one', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-hook-init-'));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-hook-home-'));
    const runner = (cmd, args) => {
      if (cmd === 'git') return { exitCode: 0, stdout: 'git version 2.54.0', stderr: '' };
      if (args[0] === '--version') return { exitCode: 0, stdout: '2.1.311 (Claude Code)\n', stderr: '' };
      return { exitCode: 0, stdout: '--agents --output-format --print --model --permission-mode', stderr: '' };
    };
    const resolve = (cmd) => ({ found: cmd === 'claude' || cmd === 'git', path: cmd, kind: 'exe' });
    const doctorCodes = () => runDoctor({ host: 'claude', repo, homeDir, runner, resolve }).warnings.map((w) => w.code);
    try {
      assert.equal(initHost({ repo, host: 'claude', skipClaudeHooks: true }).claude_scope_hook, undefined);
      assert.ok(doctorCodes().includes('CLAUDE_SCOPE_HOOK_MISSING'));

      const res = initHost({ repo, host: 'claude' });
      assert.equal(res.claude_scope_hook.action, 'ADDED');
      const settings = readJson(path.join(repo, '.claude', 'settings.json'));
      assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, scopeGuardCommand());
      assert.ok(settings.permissions.deny.length > 0);
      assert.ok(!doctorCodes().some((c) => c.startsWith('CLAUDE_SCOPE_HOOK')));

      const user = installSkills({ targets: 'claude', scope: 'user', homeDir });
      assert.equal(user.results[0].claude_scope_hook, undefined);
      assert.equal(readJson(path.join(homeDir, '.claude', 'settings.json')).hooks, undefined);
      const project = installSkills({ targets: 'claude', scope: 'project', homeDir, repoRoot: repo, force: true });
      assert.equal(project.results[0].claude_scope_hook.action, 'UNCHANGED');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
