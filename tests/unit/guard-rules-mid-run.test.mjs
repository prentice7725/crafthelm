import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { initCheckpoint } from '../../scripts/checkpoint.mjs';
import { approveContractFile } from '../../scripts/contract.mjs';
import { initHost } from '../../scripts/init-host.mjs';
import { isOnlyClaudeGuardAddition, scopeGuardCommand, SCOPE_GUARD_MATCHER } from '../../scripts/lib/claude-hooks.mjs';
import { getClaudeGuardRules } from '../../scripts/lib/claude-permissions.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { runVerify } from '../../scripts/verify.mjs';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const remove = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
const CLOSE_RULE = 'Bash(*crafthelm checkpoint close*)';
const BATCH_RULE = 'Bash(*crafthelm approve batch*)';

describe('Claude settings: guards a reinstall added are told apart from an edit', () => {
  const guards = getClaudeGuardRules();
  const older = {
    model: 'opus',
    permissions: { allow: ['Read'], ask: guards.ask.filter((r) => r !== CLOSE_RULE), deny: ['Bash(git push*)', ...guards.deny.filter((r) => r !== BATCH_RULE)] },
  };
  const newer = structuredClone(older);
  newer.permissions.ask.push(CLOSE_RULE);
  newer.permissions.deny.push(BATCH_RULE);

  it('accepts added guard rules and hooks, and nothing else', () => {
    assert.equal(isOnlyClaudeGuardAddition(older, newer), true);
    // Settings that had no guards at all, and gain rules and the scope hook.
    const hook = { matcher: SCOPE_GUARD_MATCHER, hooks: [{ type: 'command', command: scopeGuardCommand() }] };
    assert.equal(isOnlyClaudeGuardAddition({ model: 'opus' }, { model: 'opus', permissions: { deny: [BATCH_RULE] }, hooks: { PreToolUse: [hook] } }), true);

    const changed = (edit) => { const s = structuredClone(newer); edit(s); return isOnlyClaudeGuardAddition(older, s); };
    assert.equal(isOnlyClaudeGuardAddition(older, older), false, 'no change is not an addition');
    assert.equal(changed((s) => { s.permissions.allow.push('Bash(rm -rf*)'); }), false, 'a new allow rule');
    assert.equal(changed((s) => { s.permissions.deny = s.permissions.deny.filter((r) => r !== 'Bash(git push*)'); }), false, 'a deny rule of the user removed');
    assert.equal(changed((s) => { s.permissions.deny = s.permissions.deny.filter((r) => r !== guards.deny[0]); }), false, 'a guard the baseline had removed');
    assert.equal(changed((s) => { s.model = 'haiku'; }), false, 'another key changed');
    assert.equal(changed((s) => { s.permissions.ask.push('Bash(*not a guard*)'); }), false, 'a rule that is not a guard');
    // A hook that only mentions the guard script, or the guard under a matcher that never fires.
    assert.equal(changed((s) => { s.hooks = { PreToolUse: [{ matcher: SCOPE_GUARD_MATCHER, hooks: [{ type: 'command', command: `node evil.mjs # ${scopeGuardCommand()}` }] }] }; }), false);
    assert.equal(changed((s) => { s.hooks = { PreToolUse: [{ matcher: 'Nothing', hooks: [{ type: 'command', command: scopeGuardCommand() }] }] }; }), false);
    assert.equal(changed((s) => { s.hooks = { PreToolUse: [{ matcher: SCOPE_GUARD_MATCHER, hooks: [{ type: 'command', command: scopeGuardCommand() }, { type: 'command', command: 'node other.mjs' }] }] }; }), false);
    assert.equal(isOnlyClaudeGuardAddition(null, newer), false);
  });
});

describe('verify: a CraftHelm reinstall during a run is not the run\'s change', () => {
  function setup() {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-guards-'));
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.name', 'CraftHelm Test']);
    runGit(repo, ['config', 'user.email', 'test@crafthelm.local']);
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'app.mjs'), 'export const val = 1;\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'README.md'), '# Base\n', 'utf8');
    // Set up by an older CraftHelm: the settings lack the rules of the newer commands.
    initHost({ repo, host: 'claude' });
    const settingsPath = path.join(repo, '.claude', 'settings.json');
    const settings = readJson(settingsPath);
    settings.permissions.ask = settings.permissions.ask.filter((r) => !/checkpoint(\.mjs)? close/.test(r));
    settings.permissions.deny = settings.permissions.deny.filter((r) => !/ batch/.test(r));
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '-m', 'Base']);

    const contractPath = path.join(repo, '.crafthelm', 'contracts', 'GUARD.json');
    fs.mkdirSync(path.dirname(contractPath), { recursive: true });
    fs.writeFileSync(contractPath, JSON.stringify({
      schema_version: '0.3', task_id: 'GUARD', request: 'Set val to 2', project_root: '.', host: 'claude', change_kind: 'refactor',
      methodology: { lifecycle: 'incremental', specification: 'lightweight', engineering: 'test_after', execution: 'full' },
      scope: { allow: ['src/**'], protect: [] },
      approval: { contract_approved: false, require_on: ['scope_change'] },
      budgets: { max_worker_retries_per_cause: 3, max_lead_escalations: 3, max_wall_minutes: 30 },
      acceptance: [{ id: 'AC-01', requirement: 'REQ-01', kind: 'e2e', command: 'node --version', expected_exit_code: 0 }],
      source_policy: { authority: ['git-main'], source_refs: ['README.md'] },
    }, null, 2));
    approveContractFile(contractPath, 'operator');
    initCheckpoint({ repo, contract: contractPath, runId: 'GUARD-RUN' });
    fs.writeFileSync(path.join(repo, 'src', 'app.mjs'), 'export const val = 2;\n', 'utf8');
    return { repo, settingsPath };
  }

  it('passes scope when the reinstall only added guard rules, and fails when the settings were edited', () => {
    const { repo, settingsPath } = setup();
    try {
      // The newer checkout is installed mid-run: its guard rules are merged in.
      const reinstall = initHost({ repo, host: 'claude' });
      assert.equal(reinstall.claude_permissions.action, 'ADDED');
      const v = runVerify({ repo, runId: 'GUARD-RUN' });
      assert.equal(v.scope_status, 'PASS', v.failure_reasons.join('\n'));
      assert.deepEqual(readJson(path.join(repo, '.crafthelm', 'runs', 'GUARD-RUN', 'evidence-manifest.json')).scope.changed_files, ['src/app.mjs']);

      // An edit on top of it is a change like any other. Only tooling changed, so the reason says how a person settles it.
      const settings = readJson(settingsPath);
      settings.permissions.allow = [...(settings.permissions.allow ?? []), 'Bash(*)'];
      fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      const edited = runVerify({ repo, runId: 'GUARD-RUN' });
      assert.equal(edited.scope_status, 'FAIL');
      assert.ok(edited.failure_reasons.includes('SCOPE_VIOLATION: Out-of-scope file changes: .claude/settings.json'));
      assert.ok(edited.failure_reasons.includes('SCOPE_NOTE: Only CraftHelm and host tooling files changed, not the task\'s own. If you updated the tooling during this run, a person re-freezes their baseline outside the AI session: checkpoint rebaseline --repo <path> --run-id GUARD-RUN --reason "<what was updated>"'));
    } finally {
      remove(repo);
    }
  });

  it('still reports the settings when a guard the baseline had was removed', () => {
    const { repo, settingsPath } = setup();
    try {
      const settings = readJson(settingsPath);
      settings.permissions.deny = settings.permissions.deny.filter((r) => !/approve record/.test(r));
      fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      initHost({ repo, host: 'claude', skipClaudePermissions: true });
      assert.equal(runVerify({ repo, runId: 'GUARD-RUN' }).scope_status, 'FAIL');
    } finally {
      remove(repo);
    }
  });
});
