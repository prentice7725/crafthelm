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
import {
  SCOPE_GUARD_MATCHER,
  applyClaudeScopeHook,
  applyClaudeStatusHook,
  inspectClaudeScopeHook,
  inspectClaudeStatusHook,
  scopeGuardCommand,
  sessionStatusCommand,
} from '../../scripts/lib/claude-hooks.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { CRAFTHELM_ROOT, getCheckpointPath } from '../../scripts/lib/paths.mjs';
import { describeSessionStatus, evaluateHookPayload, evaluateWrite, findCraftHelmRepo, listActiveScopes } from '../../scripts/lib/scope-guard.mjs';

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
      assert.deepEqual(listActiveScopes(repo), [{ run_id: 'GUARD-RUN', task_id: 'GUARD', state: 'READY', allow: ['src/**'], protect: ['src/generated/**'] }]);

      assert.deepEqual([at('src/app.mjs').decision, at('src/app.mjs').code], ['allow', 'IN_SCOPE']);
      assert.deepEqual([at('src/new/feature.mjs').decision, at('src/new/feature.mjs').code], ['allow', 'IN_SCOPE']);
      // Protected wins over allowed.
      assert.deepEqual([at('src/generated/schema.mjs').decision, at('src/generated/schema.mjs').code], ['deny', 'PROTECTED_PATH']);
      const outside = at('migrations/001.sql');
      assert.deepEqual([outside.decision, outside.code], ['deny', 'OUT_OF_SCOPE']);
      assert.match(outside.reason, /migrations\/001\.sql is outside scope\.allow \(src\/\*\*\) of the active run GUARD-RUN/);
      // The contract and the Claude settings that hold the guard are closed to file tools outright.
      assert.equal(at('.crafthelm/contracts/GUARD.json').code, 'CONTROL_FILE');
      assert.equal(at('.claude/settings.json').code, 'CONTROL_FILE');
      assert.equal(at('.claude/settings.local.json').code, 'CONTROL_FILE');
      assert.equal(at('.claude/skills/crafthelm/SKILL.md').code, 'OUT_OF_SCOPE');
      for (const rel of ['.crafthelm/approvers.json', '.crafthelm/config.json', '.crafthelm/skills.lock.json']) {
        assert.equal(at(rel).code, 'CONTROL_FILE', rel);
      }
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
      const scriptOwned = [
        'approvals/decision.json', 'checkpoint.json', 'evidence-manifest.json', 'evidence/verification-stamp.json', 'evidence/tests/AC-01.stdout.txt',
        // Closed by default: delegation records, probe and impact results, reports, the writer lock.
        'delegations/D001.json', 'evidence/mutation-probe.json', 'evidence/impact-analysis.json', 'evidence/changes.patch',
        'reports/editorial-report.json', 'reports/review-package.md', 'writer.lock.json', 'anything/new.txt',
      ];
      for (const rel of scriptOwned) {
        assert.equal(at(`.crafthelm/runs/OWN-RUN/${rel}`).code, 'SCRIPT_OWNED_ARTIFACT', rel);
      }
      // The advisory reviewer writes its findings here, and hand-over files for scripts go to the inbox.
      assert.equal(at('.crafthelm/runs/OWN-RUN/evidence/review.json').code, 'RUN_WORKSPACE');
      assert.equal(at('.crafthelm/runs/OWN-RUN/inbox/worker-result.json').code, 'RUN_WORKSPACE');

      const checkpointPath = getCheckpointPath(repo, 'OWN-RUN');
      fs.writeFileSync(checkpointPath, JSON.stringify({ ...readJson(checkpointPath), state: 'ACCEPTED' }), 'utf8');
      assert.deepEqual(listActiveScopes(repo), []);
      assert.equal(at('migrations/001.sql').code, 'NO_ACTIVE_RUN');
      // Script-owned files and control files stay off limits with no run in progress: this is where
      // an agent would otherwise set contract_approved itself, or remove the hook.
      assert.equal(at('.crafthelm/runs/OWN-RUN/approvals/decision.json').decision, 'deny');
      assert.equal(at('.crafthelm/contracts/NEXT.json').code, 'CONTROL_FILE');
      assert.equal(at('.claude/settings.json').code, 'CONTROL_FILE');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('compares names the way the disk does: another letter case or a Windows alias is the same file', () => {
    const repo = makeRepo();
    try {
      startRun(repo, 'CASE', 'CASE-RUN', { allow: ['src/**'], protect: ['src/generated/**', 'REVIEW.md'] });
      fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), '{}', 'utf8');
      const folded = (rel) => evaluateWrite({ filePath: path.join(repo, rel), caseInsensitive: true }).code;
      // Names that do not exist yet have no on-disk spelling, so both sides are folded.
      assert.equal(folded('.claude/Settings.Local.json'), 'CONTROL_FILE');
      assert.equal(folded('.crafthelm/contracts/Next.JSON'), 'CONTROL_FILE');
      assert.equal(folded('review.md'), 'PROTECTED_PATH');
      assert.equal(folded('SRC/Generated/New.mjs'), 'PROTECTED_PATH');
      assert.equal(folded('SRC/New.mjs'), 'IN_SCOPE');
      assert.equal(folded('.crafthelm/runs/CASE-RUN/Approvals/decision.json'), 'SCRIPT_OWNED_ARTIFACT');
      // On a case-sensitive disk these are different files, and the scope rule still applies to them.
      const exact = (rel) => evaluateWrite({ filePath: path.join(repo, rel), caseInsensitive: false, isIgnored: () => false }).code;
      assert.equal(exact('review.md'), 'OUT_OF_SCOPE');
      assert.equal(exact('REVIEW.md'), 'PROTECTED_PATH');

      // What this machine's filesystem does, detected rather than assumed.
      const at = (rel) => evaluateWrite({ filePath: path.join(repo, rel) }).code;
      if (fs.existsSync(path.join(repo, '.CRAFTHELM'))) {
        assert.equal(at('.claude/Settings.json'), 'CONTROL_FILE');
        assert.equal(at('.CRAFTHELM/Contracts/X.json'), 'CONTROL_FILE');
        assert.equal(at('.crafthelm/Runs/CASE-RUN/approvals/decision.json'), 'SCRIPT_OWNED_ARTIFACT');
      } else {
        assert.equal(at('.claude/Settings.json'), 'OUT_OF_SCOPE');
      }
      if (process.platform === 'win32') {
        assert.equal(at('.claude/settings.json.'), 'CONTROL_FILE');
        assert.equal(at('.claude/settings.json::$DATA'), 'CONTROL_FILE');
        assert.equal(at('.claude/settings.json '), 'CONTROL_FILE');
      }

      // A link inside the scope that points at a protected file is judged by its target.
      let linked = true;
      try {
        fs.symlinkSync(path.join(repo, 'src', 'generated'), path.join(repo, 'src', 'alias'), 'junction');
      } catch {
        linked = false;
      }
      if (linked) assert.equal(at('src/alias/schema.mjs'), 'PROTECTED_PATH');
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
      assert.ok(doctorCodes().includes('CLAUDE_STATUS_HOOK_MISSING'));

      const res = initHost({ repo, host: 'claude' });
      assert.equal(res.claude_scope_hook.action, 'ADDED');
      const settings = readJson(path.join(repo, '.claude', 'settings.json'));
      assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, scopeGuardCommand());
      assert.ok(settings.permissions.deny.length > 0);
      assert.ok(!doctorCodes().some((c) => c.startsWith('CLAUDE_SCOPE_HOOK') || c.startsWith('CLAUDE_STATUS_HOOK')));
      assert.equal(res.claude_status_hook.action, 'ADDED');
      assert.equal(settings.hooks.SessionStart[0].hooks[0].command, sessionStatusCommand());
      assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, sessionStatusCommand());

      const user = installSkills({ targets: 'claude', scope: 'user', homeDir });
      assert.equal(user.results[0].claude_scope_hook, undefined);
      assert.equal(readJson(path.join(homeDir, '.claude', 'settings.json')).hooks, undefined);
      const project = installSkills({ targets: 'claude', scope: 'project', homeDir, repoRoot: repo, force: true });
      assert.equal(project.results[0].claude_scope_hook.action, 'UNCHANGED');
      assert.equal(project.results[0].claude_status_hook.action, 'UNCHANGED');
      assert.equal(user.results[0].claude_status_hook, undefined);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe('Session status hook: the open run stays in front of the agent after the skill was read', () => {
  const STATUS_HOOK = path.join(CRAFTHELM_ROOT, 'scripts', 'hooks', 'session-status.mjs');
  const runStatusHook = (payload) => spawnSync(process.execPath, [STATUS_HOOK], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', windowsHide: true });

  it('names the run, its scope and the next command on every prompt, and what to do when a person must decide', () => {
    const repo = makeRepo();
    try {
      // No CraftHelm setup yet: nothing to say, and a bare .crafthelm directory is not a setup.
      assert.equal(describeSessionStatus({ cwd: repo, event: 'SessionStart' }), '');
      fs.mkdirSync(path.join(repo, '.crafthelm'));
      assert.equal(findCraftHelmRepo(repo), findCraftHelmRepo(path.dirname(repo)));

      startRun(repo, 'TURN', 'TURN-RUN', { allow: ['src/**'], protect: ['src/generated/**'] });
      const text = describeSessionStatus({ cwd: path.join(repo, 'src'), event: 'UserPromptSubmit' });
      assert.match(text, /^CraftHelm: run TURN-RUN \(task TURN\) is READY\./);
      assert.match(text, /Write only inside scope\.allow: src\/\*\*\. Never inside scope\.protect: src\/generated\/\*\*\./);
      assert.match(text, /After editing, verify with: node ".*scripts\/crafthelm\.mjs" verify --repo ".*" --run-id TURN-RUN\n/);
      assert.match(text, /status --repo ".*" --run-id TURN-RUN --explain/);

      const viaHook = runStatusHook({ hook_event_name: 'UserPromptSubmit', cwd: repo, prompt: 'continue' });
      assert.deepEqual([viaHook.status, viaHook.stdout.trim()], [0, describeSessionStatus({ cwd: repo, event: 'UserPromptSubmit' })]);

      const checkpointPath = getCheckpointPath(repo, 'TURN-RUN');
      const setState = (state) => fs.writeFileSync(checkpointPath, JSON.stringify({ ...readJson(checkpointPath), state }), 'utf8');
      setState('READY_FOR_HUMAN_REVIEW');
      const waiting = describeSessionStatus({ cwd: repo, event: 'UserPromptSubmit' });
      assert.match(waiting, /waiting for the human acceptance decision\. Do not edit files, and never record the decision yourself\./);
      assert.doesNotMatch(waiting, /After editing/);
      setState('BLOCKED_HUMAN_ATTENTION');
      assert.match(describeSessionStatus({ cwd: repo, event: 'UserPromptSubmit' }), /repair limit is used up\. Stop and report to the user/);

      // With the run over, a new session is told to start one; later prompts are left alone.
      setState('ACCEPTED');
      assert.match(describeSessionStatus({ cwd: repo, event: 'SessionStart' }), /no run is in progress\. Before changing code, start one with: .* start "<task>" --repo ".*"\. The user approves the contract; you do not\./);
      assert.equal(describeSessionStatus({ cwd: repo, event: 'UserPromptSubmit' }), '');
      assert.deepEqual([runStatusHook({ hook_event_name: 'UserPromptSubmit', cwd: repo }).stdout, runStatusHook('not json').status], ['', 0]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('registers on both events beside the scope guard, and reports an incomplete registration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-status-hook-'));
    try {
      const settingsPath = path.join(dir, '.claude', 'settings.json');
      assert.equal(applyClaudeScopeHook({ settingsPath }).action, 'ADDED');
      assert.equal(inspectClaudeStatusHook({ repoRoot: dir }).status, 'MISSING');
      assert.equal(applyClaudeStatusHook({ settingsPath, dryRun: true }).action, 'WOULD_ADD');
      assert.equal(applyClaudeStatusHook({ settingsPath }).action, 'ADDED');
      const hooks = readJson(settingsPath).hooks;
      assert.deepEqual(Object.keys(hooks).sort(), ['PreToolUse', 'SessionStart', 'UserPromptSubmit']);
      // Prompt and session hooks take no tool matcher.
      assert.deepEqual(hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: sessionStatusCommand() }] }]);
      assert.equal(inspectClaudeStatusHook({ repoRoot: dir }).status, 'REGISTERED');
      assert.equal(inspectClaudeScopeHook({ repoRoot: dir }).status, 'REGISTERED');
      assert.equal(applyClaudeStatusHook({ settingsPath }).action, 'UNCHANGED');

      // One event removed by hand: reported as missing and put back without duplicating the other.
      const edited = readJson(settingsPath);
      delete edited.hooks.SessionStart;
      fs.writeFileSync(settingsPath, JSON.stringify(edited));
      assert.equal(inspectClaudeStatusHook({ repoRoot: dir }).status, 'MISSING');
      assert.equal(applyClaudeStatusHook({ settingsPath }).action, 'ADDED');
      assert.deepEqual([readJson(settingsPath).hooks.SessionStart.length, readJson(settingsPath).hooks.UserPromptSubmit.length], [1, 1]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
