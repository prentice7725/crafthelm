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
import { getClaudeGuardRules } from '../../scripts/lib/claude-permissions.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { CRAFTHELM_ROOT, getEvidenceManifestPath } from '../../scripts/lib/paths.mjs';
import { describeSessionStatus, evaluateWrite } from '../../scripts/lib/scope-guard.mjs';
import { classifyZone, inspectZones, loadZonesPolicy, writeZones } from '../../scripts/lib/zones.mjs';
import { runVerify } from '../../scripts/verify.mjs';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const remove = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
const write = (repo, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text, 'utf8');
};

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-zones-'));
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['config', 'user.name', 'CraftHelm Test']);
  runGit(repo, ['config', 'user.email', 'test@crafthelm.local']);
  write(repo, 'README.md', '# Base\n');
  write(repo, 'src/app.mjs', 'export const val = 1;\n');
  write(repo, 'schemas/book.schema.json', '{"type":"object"}\n');
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-m', 'Base']);
  return repo;
}
const commit = (repo, message) => { runGit(repo, ['add', '-A']); runGit(repo, ['commit', '-m', message]); };

function openRun(repo, taskId) {
  const contractPath = path.join(repo, '.crafthelm', 'contracts', `${taskId}.json`);
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(contractPath, JSON.stringify({
    schema_version: '0.3', task_id: taskId, request: `Change for ${taskId}`, project_root: '.', host: 'generic', change_kind: 'refactor',
    methodology: { lifecycle: 'incremental', specification: 'lightweight', engineering: 'test_after', execution: 'full' },
    scope: { allow: ['src/**', 'schemas/**'], protect: [] },
    approval: { contract_approved: false, require_on: ['scope_change'] },
    budgets: { max_worker_retries_per_cause: 3, max_lead_escalations: 3, max_wall_minutes: 30 },
    acceptance: [{ id: 'AC-01', requirement: 'REQ-01', kind: 'e2e', command: 'node --version', expected_exit_code: 0 }],
    source_policy: { authority: ['git-main'], source_refs: ['README.md'] },
  }, null, 2));
  approveContractFile(contractPath, 'operator');
  initCheckpoint({ repo, contract: contractPath, runId: `${taskId}-RUN` });
  return `${taskId}-RUN`;
}
const zoneOf = (repo, runId) => readJson(getEvidenceManifestPath(repo, runId)).zone;

describe('Project zones: the definition, without a list of paths', () => {
  it('has three states and classifies changed files by the zones a project recorded', () => {
    const absent = { present: false, source: 'none', strict: [], digest: null };
    assert.deepEqual(classifyZone(absent, ['schemas/a.json']), { classification: 'undefined', strict_files: [], policy_source: 'none', policy_digest: null });
    const policy = { present: true, source: 'test', digest: 'd', strict: [{ path: 'schemas/**', reason: 'other tools read these' }, { path: 'billing/', reason: 'money moves' }] };
    assert.equal(classifyZone(policy, ['src/app.mjs', 'docs/x.md']).classification, 'light');
    assert.deepEqual(classifyZone(policy, ['src/app.mjs', 'schemas/a.json', 'billing/charge.mjs']).strict_files, [
      { path: 'schemas/a.json', pattern: 'schemas/**', reason: 'other tools read these' },
      { path: 'billing/charge.mjs', pattern: 'billing/', reason: 'money moves' },
    ]);
    // A project may decide it has no strict zone. That is decided, not undefined.
    assert.equal(classifyZone({ present: true, source: 'test', digest: 'd', strict: [] }, ['schemas/a.json']).classification, 'light');
  });

  it('records the decision with who made it and why each path is strict, and tells committed from not', () => {
    const repo = makeRepo();
    try {
      assert.equal(inspectZones(repo).status, 'UNDEFINED');
      assert.throws(() => writeZones(repo, { strict: [{ path: 'schemas/**', reason: 'x' }], actor: ' ' }), /zones set needs --actor/);
      assert.throws(() => writeZones(repo, { strict: [{ path: 'schemas/**', reason: '' }], actor: 'seung' }), /ZONE_REASON_REQUIRED: strict zone "schemas\/\*\*" needs the reason/);
      assert.throws(() => writeZones(repo, { strict: [{ path: 'a/**', reason: 'x' }, { path: 'a/**', reason: 'y' }], actor: 'seung' }), /ZONE_DUPLICATE/);
      assert.throws(() => writeZones(repo, { strict: [{ path: '{a,b}/**', reason: 'x' }], actor: 'seung' }), /ZONE_PATTERN_UNSUPPORTED/);
      assert.equal(inspectZones(repo).status, 'UNDEFINED');

      const zones = writeZones(repo, { strict: [{ path: 'schemas/**', reason: 'other tools read these' }], actor: 'seung', basis: 'design review', channel: 'interactive_terminal' });
      assert.deepEqual([zones.decided_by, zones.decided_via, zones.basis, zones.strict], ['seung', 'interactive_terminal', 'design review', [{ path: 'schemas/**', reason: 'other tools read these' }]]);
      assert.equal(inspectZones(repo).status, 'NOT_COMMITTED');
      assert.equal(loadZonesPolicy(repo, 'HEAD').present, false);
      commit(repo, 'Decide zones');
      assert.equal(inspectZones(repo).status, 'COMMITTED');
      assert.deepEqual(loadZonesPolicy(repo, 'HEAD').strict, [{ path: 'schemas/**', reason: 'other tools read these' }]);
      writeZones(repo, { strict: [], actor: 'seung' });
      assert.equal(inspectZones(repo).status, 'DIFFERS_FROM_HEAD');

      // The file is closed to file tools; the supported way in is the command, which Claude Code asks about.
      assert.equal(evaluateWrite({ filePath: path.join(repo, '.crafthelm', 'zones.json'), cwd: repo }).code, 'CONTROL_FILE');
      for (const rule of ['Bash(*zones.mjs set*)', 'Bash(*crafthelm.mjs zones set*)', 'Bash(*crafthelm zones set*)']) assert.ok(getClaudeGuardRules().ask.includes(rule), rule);
    } finally {
      remove(repo);
    }
  });

  it('zones set and show work from the command line', () => {
    const repo = makeRepo();
    try {
      const cli = (...args) => spawnSync(process.execPath, [path.join(CRAFTHELM_ROOT, 'scripts', 'crafthelm.mjs'), 'zones', ...args, '--repo', repo], { cwd: repo, encoding: 'utf8' });
      assert.equal(JSON.parse(cli('show').stdout).status, 'UNDEFINED');
      const missing = cli('set', '--actor', 'seung');
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /needs at least one --strict "<path>::<reason>", or --none/);
      const set = cli('set', '--actor', 'seung', '--strict', 'schemas/**::other tools read these', '--strict', 'target/::source PDFs, not regenerable', '--basis', 'project kickoff');
      assert.equal(set.status, 0, set.stderr);
      assert.deepEqual(JSON.parse(set.stdout).zones.strict, [
        { path: 'schemas/**', reason: 'other tools read these' },
        { path: 'target/', reason: 'source PDFs, not regenerable' },
      ]);
      assert.match(set.stderr, /exists but is not committed\. Runs are judged by the committed file, so commit it\./);
      commit(repo, 'Decide zones');
      assert.equal(JSON.parse(cli('show').stdout).status, 'COMMITTED');
      assert.equal(JSON.parse(cli('check', '--files', 'src/a.mjs,target/book.pdf').stdout).classification, 'strict');
      const none = cli('set', '--actor', 'seung', '--none');
      assert.deepEqual(JSON.parse(none.stdout).zones.strict, []);
    } finally {
      remove(repo);
    }
  });
});

describe('Project zones: a run says which zone its change touches', () => {
  it('classifies by the zones committed at the run baseline, and a mid-run edit of the file changes nothing but is reported', () => {
    const repo = makeRepo();
    try {
      // Before the project has decided: undefined, not light.
      const early = openRun(repo, 'EARLY');
      write(repo, 'src/app.mjs', 'export const val = 2;\n');
      runVerify({ repo, runId: early });
      assert.deepEqual([zoneOf(repo, early).classification, zoneOf(repo, early).policy_source], ['undefined', 'none']);
      commit(repo, 'Early work');

      writeZones(repo, { strict: [{ path: 'schemas/**', reason: 'other tools read these' }], actor: 'seung' });
      commit(repo, 'Decide zones');

      const light = openRun(repo, 'LIGHT');
      write(repo, 'src/app.mjs', 'export const val = 3;\n');
      runVerify({ repo, runId: light });
      assert.deepEqual([zoneOf(repo, light).classification, zoneOf(repo, light).strict_files], ['light', []]);
      commit(repo, 'Light work');

      const strict = openRun(repo, 'STRICT');
      write(repo, 'schemas/book.schema.json', '{"type":"array"}\n');
      const before = runVerify({ repo, runId: strict });
      assert.equal(before.scope_status, 'PASS');
      assert.deepEqual(zoneOf(repo, strict).strict_files, [{ path: 'schemas/book.schema.json', pattern: 'schemas/**', reason: 'other tools read these' }]);
      assert.match(zoneOf(repo, strict).policy_source, /^base_ref_git_show:/);

      // The run rewrites the zones to make its own change light. The baseline version still decides,
      // and the edit shows up as a change outside the run's scope.
      fs.writeFileSync(path.join(repo, '.crafthelm', 'zones.json'), JSON.stringify({ schema_version: '0.1', strict: [], decided_by: 'agent', decided_at: 'now', decided_via: 'programmatic' }));
      const after = runVerify({ repo, runId: strict });
      assert.equal(zoneOf(repo, strict).classification, 'strict');
      assert.equal(after.scope_status, 'FAIL');
      assert.ok(after.failure_reasons.some((r) => r.startsWith('SCOPE_VIOLATION') && r.includes('.crafthelm/zones.json')));
    } finally {
      remove(repo);
    }
  });
});

describe('Project zones: a project that has not decided is told so', () => {
  it('says it at init-host, at session start and in doctor, and stops once the zones are committed', () => {
    const repo = makeRepo();
    try {
      const init = initHost({ repo, host: 'generic' });
      assert.equal(init.zones, 'UNDEFINED');
      assert.match(init.next_step, /Decide this project's strict zones with the user, from its design/);
      const reminder = () => describeSessionStatus({ cwd: repo, event: 'SessionStart' });
      assert.match(reminder(), /This project has not decided its strict zones \(the paths where a mistake is expensive\)\. Before the first task, work them out with the user from the project's design and record them: node ".*crafthelm\.mjs" zones set --repo ".*" --actor <name> --strict "<path>::<reason>" \(or --none\)\./);
      const doctor = () => runDoctor({ host: 'generic', repo });
      assert.deepEqual([doctor().zones, doctor().warnings.filter((w) => w.code.startsWith('ZONES')).map((w) => w.code)], [{ status: 'UNDEFINED', strict: [] }, ['ZONES_UNDEFINED']]);

      writeZones(repo, { strict: [{ path: 'schemas/**', reason: 'other tools read these' }], actor: 'seung' });
      assert.doesNotMatch(reminder(), /has not decided its strict zones/);
      assert.deepEqual(doctor().warnings.filter((w) => w.code.startsWith('ZONES')).map((w) => w.code), ['ZONES_NOT_COMMITTED']);
      commit(repo, 'Decide zones');
      assert.deepEqual([doctor().zones, doctor().warnings.filter((w) => w.code.startsWith('ZONES'))], [{ status: 'COMMITTED', strict: ['schemas/**'] }, []]);
      assert.equal(initHost({ repo, host: 'generic' }).zones, undefined);
    } finally {
      remove(repo);
    }
  });
});
