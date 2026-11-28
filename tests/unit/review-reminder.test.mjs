import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { describeSessionStatus } from '../../scripts/lib/scope-guard.mjs';

// The reminder reads a run's state from its checkpoint and its scope from the contract; nothing else.
function repoWithRuns(runs) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-reminder-'));
  for (const [taskId, state] of runs) {
    const contracts = path.join(repo, '.crafthelm', 'contracts');
    const runDir = path.join(repo, '.crafthelm', 'runs', `${taskId}-RUN`);
    fs.mkdirSync(contracts, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(contracts, `${taskId}.json`), JSON.stringify({ task_id: taskId, scope: { allow: ['src/**'], protect: [] } }));
    fs.writeFileSync(path.join(runDir, 'checkpoint.json'), JSON.stringify({ run_id: `${taskId}-RUN`, task_id: taskId, state }));
  }
  return repo;
}

describe('Session reminder: a run waiting for review comes with the command that opens the review page', () => {
  it('gives the command for one waiting run and for several, and not for a run that is blocked', () => {
    const one = repoWithRuns([['REGION', 'READY_FOR_HUMAN_REVIEW']]);
    const mixed = repoWithRuns([['A', 'READY_FOR_HUMAN_REVIEW'], ['B', 'BLOCKED_HUMAN_ATTENTION'], ['C', 'READY']]);
    const blocked = repoWithRuns([['B', 'BLOCKED_HUMAN_ATTENTION']]);
    try {
      const command = (repo) => new RegExp(`Give them this command to run in their own terminal \\(the terminal panel of this app works\\), as it is and in a code block: node ".*crafthelm\\.mjs" review --repo "${repo.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\. Do not run it yourself, and do not just tell them to do it outside the session\\.`);

      const single = describeSessionStatus({ cwd: one, event: 'UserPromptSubmit' });
      assert.match(single, /^CraftHelm: run REGION-RUN \(task REGION\) is READY_FOR_HUMAN_REVIEW\./);
      assert.match(single, /never record the decision yourself\./);
      assert.match(single, command(one));
      // The sentence that sent people away without a command is gone.
      assert.doesNotMatch(single, /from a terminal outside this session/);

      const several = describeSessionStatus({ cwd: mixed, event: 'UserPromptSubmit' });
      assert.match(several, /2 other runs wait on a person's decision/);
      assert.match(several, command(mixed));

      assert.doesNotMatch(describeSessionStatus({ cwd: blocked, event: 'UserPromptSubmit' }), / review --repo /);
    } finally {
      for (const repo of [one, mixed, blocked]) fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
