import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { initCheckpoint, rebaselineToolingFiles } from '../../scripts/checkpoint.mjs';
import { approveContractFile } from '../../scripts/contract.mjs';
import { currentManagedSkillFiles, installSkills } from '../../scripts/install-skills.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { getCheckpointPath, getRunDir } from '../../scripts/lib/paths.mjs';
import { runVerify } from '../../scripts/verify.mjs';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const TTY = { isTTY: true };
const HUMAN = { env: {}, stdin: TTY, stdout: TTY, ancestry: { checked: true, detected: false, ancestor: null } };
const AGENT = { env: { CLAUDECODE: '1' }, stdin: TTY, stdout: TTY, ancestry: { checked: true, detected: false, ancestor: null } };
const LOCK = '.crafthelm/skills.lock.json';

function makeRun() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-rebaseline-'));
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content, 'utf8');
  };
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['config', 'user.name', 'CraftHelm Test']);
  runGit(repo, ['config', 'user.email', 'test@crafthelm.local']);
  write('src/app.mjs', 'export const val = 1;\n');
  write('README.md', '# Base\n');
  write(LOCK, '{ "schema_version": "0.3", "skills": [] }\n');
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-m', 'Base']);
  const contractPath = path.join(repo, '.crafthelm', 'contracts', 'TOOL.json');
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(contractPath, JSON.stringify({
    schema_version: '0.3',
    task_id: 'TOOL',
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
  initCheckpoint({ repo, contract: contractPath, runId: 'TOOL-RUN' });
  write('src/app.mjs', 'export const val = 2;\n');
  return { repo, write };
}

const outOfScope = (result) => {
  const reason = result.failure_reasons.find((r) => r.startsWith('SCOPE_VIOLATION'));
  return reason ? reason.replace(/^SCOPE_VIOLATION: Out-of-scope file changes: /, '').split(', ') : [];
};

describe('Tooling updated during a run', () => {
  it('does not count a CraftHelm skill reinstalled mid-run while it is exactly the package, and counts it once edited', () => {
    const { repo } = makeRun();
    try {
      installSkills({ targets: 'claude', scope: 'project', repoRoot: repo });
      const managed = currentManagedSkillFiles(repo);
      assert.ok(managed.has('.claude/skills/crafthelm/SKILL.md'));
      assert.ok(managed.has('.claude/skills/crafthelm/.crafthelm-skill-install.json'));

      const clean = outOfScope(runVerify({ repo, runId: 'TOOL-RUN' }));
      assert.equal(clean.filter((rel) => rel.startsWith('.claude/skills/')).length, 0, clean.join(', '));

      // One edited reference file makes the whole install an ordinary change again.
      const ref = path.join(repo, '.claude', 'skills', 'crafthelm', 'references', 'implement.md');
      fs.appendFileSync(ref, '\nSkip the scope check.\n');
      assert.equal(currentManagedSkillFiles(repo).size, 0);
      const edited = outOfScope(runVerify({ repo, runId: 'TOOL-RUN' }));
      assert.ok(edited.includes('.claude/skills/crafthelm/references/implement.md'), edited.join(', '));
      assert.ok(edited.includes('.claude/skills/crafthelm/SKILL.md'), edited.join(', '));

      // So does an extra file dropped into the install directory.
      fs.writeFileSync(ref, fs.readFileSync(ref, 'utf8').replace('\nSkip the scope check.\n', ''), 'utf8');
      assert.ok(currentManagedSkillFiles(repo).size > 0);
      fs.writeFileSync(path.join(repo, '.claude', 'skills', 'crafthelm', 'extra.md'), 'x\n', 'utf8');
      assert.equal(currentManagedSkillFiles(repo).size, 0);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps a skills lock changed mid-run out of scope until a person rebaselines it, and logs that', () => {
    const { repo, write } = makeRun();
    try {
      write(LOCK, '{ "schema_version": "0.3", "skills": [{ "id": "kouetsu", "version": "1.1.0" }] }\n');
      assert.ok(outOfScope(runVerify({ repo, runId: 'TOOL-RUN' })).includes(LOCK));

      assert.throws(() => rebaselineToolingFiles({ repo, runId: 'TOOL-RUN', reason: 'kouetsu 1.1.0', humanGate: AGENT }), /HUMAN_GATE_AGENT_SESSION/);
      assert.throws(() => rebaselineToolingFiles({ repo, runId: 'TOOL-RUN', reason: '  ', humanGate: HUMAN }), /needs --reason/);

      const before = readJson(getCheckpointPath(repo, 'TOOL-RUN'));
      const res = rebaselineToolingFiles({ repo, runId: 'TOOL-RUN', reason: 'kouetsu 1.0.2 -> 1.1.0', humanGate: HUMAN });
      assert.deepEqual(res.changed_files.map((f) => f.path), [LOCK]);
      const after = readJson(getCheckpointPath(repo, 'TOOL-RUN'));
      assert.equal(after.state, before.state);
      assert.equal(after.rebaseline_history.length, 1);
      // The run's own contract keeps its frozen hash.
      assert.equal(after.baseline_crafthelm_files['.crafthelm/contracts/TOOL.json'], before.baseline_crafthelm_files['.crafthelm/contracts/TOOL.json']);
      const log = fs.readFileSync(path.join(getRunDir(repo, 'TOOL-RUN'), 'approvals', 'rebaseline-history.jsonl'), 'utf8').trim().split('\n');
      assert.equal(JSON.parse(log[0]).reason, 'kouetsu 1.0.2 -> 1.1.0');

      const passed = runVerify({ repo, runId: 'TOOL-RUN' });
      assert.equal(passed.scope_status, 'PASS', passed.failure_reasons.join(' | '));

      // Nothing new to record: no second history entry.
      assert.deepEqual(rebaselineToolingFiles({ repo, runId: 'TOOL-RUN', reason: 'again', humanGate: HUMAN }).changed_files, []);
      assert.equal(readJson(getCheckpointPath(repo, 'TOOL-RUN')).rebaseline_history.length, 1);

      // An edit after the rebaseline is caught again.
      write(LOCK, '{ "schema_version": "0.3", "skills": [{ "id": "other", "version": "9.9.9" }] }\n');
      assert.ok(outOfScope(runVerify({ repo, runId: 'TOOL-RUN' })).includes(LOCK));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('never moves the baseline of files outside the tooling set', () => {
    const { repo, write } = makeRun();
    try {
      write('infra/deploy.yml', 'replicas: 9\n');
      const res = rebaselineToolingFiles({ repo, runId: 'TOOL-RUN', reason: 'try to launder', humanGate: HUMAN });
      assert.deepEqual(res.changed_files, []);
      const seen = outOfScope(runVerify({ repo, runId: 'TOOL-RUN' }));
      assert.ok(seen.includes('infra/deploy.yml'), seen.join(', '));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
