import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { beginUnderStandingRule } from '../../scripts/contract.mjs';
import { getClaudeGuardRules } from '../../scripts/lib/claude-permissions.mjs';
import { readApprovalRecord } from '../../scripts/lib/contract-approval.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { CRAFTHELM_ROOT, getCheckpointPath } from '../../scripts/lib/paths.mjs';
import { assessStandingStart, loadZonesPolicy, scopeMayTouchStrict, setLightContracts, writeZones } from '../../scripts/lib/zones.mjs';
import { buildReviewData } from '../../scripts/review.mjs';
import { publishReviewPackage } from '../../scripts/review-package.mjs';
import { runVerify } from '../../scripts/verify.mjs';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const remove = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
const write = (repo, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text, 'utf8');
};
const commit = (repo, message) => { runGit(repo, ['add', '-A']); runGit(repo, ['commit', '-m', message]); };

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-standing-'));
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['config', 'user.name', 'CraftHelm Test']);
  runGit(repo, ['config', 'user.email', 'test@crafthelm.local']);
  write(repo, 'README.md', '# Base\n');
  write(repo, 'docs/guide.md', 'guide\n');
  write(repo, 'src/app.mjs', 'export const val = 1;\n');
  write(repo, 'src/schemas/book.schema.json', '{"type":"object"}\n');
  write(repo, 'tests/e2e.mjs', 'process.exit(0);\n');
  commit(repo, 'Base');
  return repo;
}

function writeContract(repo, taskId, allow) {
  const contractPath = path.join(repo, '.crafthelm', 'contracts', `${taskId}.json`);
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(contractPath, JSON.stringify({
    schema_version: '0.3', task_id: taskId, request: `Work for ${taskId}`, project_root: '.', host: 'codex', change_kind: 'refactor',
    methodology: { lifecycle: 'incremental', specification: 'lightweight', engineering: 'test_after', execution: 'full' },
    scope: { allow, protect: [] },
    approval: { contract_approved: false, require_on: ['scope_change'] },
    budgets: { max_worker_retries_per_cause: 3, max_lead_escalations: 3, max_wall_minutes: 30 },
    acceptance: [{ id: 'AC-01', requirement: 'REQ-01', kind: 'e2e', command: 'node tests/e2e.mjs', expected_exit_code: 0 }],
    source_policy: { authority: ['git-main'], source_refs: ['README.md'] },
  }, null, 2));
  return contractPath;
}

describe('Standing start: whether a scope can reach a strict zone', () => {
  const strict = [{ path: 'src/schemas/**', reason: 'r' }, { path: 'target/', reason: 'r' }, { path: 'pricing.json', reason: 'r' }];
  it('keeps two patterns apart only when their fixed beginnings diverge', () => {
    assert.deepEqual(scopeMayTouchStrict(['docs/**', 'tests/**'], strict), []);
    assert.deepEqual(scopeMayTouchStrict(['src/app.mjs', 'src/ui/**'], strict), []);
    // A scope that contains a strict zone, sits inside one, or names the same file.
    assert.deepEqual(scopeMayTouchStrict(['src/**'], strict), [{ allow: 'src/**', strict: 'src/schemas/**' }]);
    assert.deepEqual(scopeMayTouchStrict(['src/schemas/book.schema.json'], strict), [{ allow: 'src/schemas/book.schema.json', strict: 'src/schemas/**' }]);
    assert.deepEqual(scopeMayTouchStrict(['target/book.pdf', 'pricing.json'], strict).map((p) => p.strict), ['target/', 'pricing.json']);
    // A pattern that begins with a wildcard has no fixed beginning: it reaches every zone.
    assert.equal(scopeMayTouchStrict(['**/*.md'], strict).length, 3);
    assert.equal(scopeMayTouchStrict(['*'], strict).length, 3);
    // Unsure counts as reachable: a longer name that only shares a beginning.
    assert.equal(scopeMayTouchStrict(['pricing.json.bak'], strict).length, 1);
    assert.deepEqual(scopeMayTouchStrict(['docs/**'], []), []);
  });
});

describe('Standing start: a light contract starts without the user only where the project said so', () => {
  it('refuses until zones are committed, the rule is switched on and committed, and the scope stays clear of strict zones', () => {
    const repo = makeRepo();
    try {
      const light = writeContract(repo, 'LIGHT', ['docs/**']);
      const refused = (file, pattern) => assert.throws(() => beginUnderStandingRule(file), pattern);

      refused(light, /STANDING_START_REFUSED: contract LIGHT is not started without the user\.\n {2}- ZONES_UNDEFINED: this project has not decided and committed its strict zones\n.*contract approve <contractPath> --actor <name> --init-run\./s);
      assert.throws(() => setLightContracts(repo, { mode: 'standing', actor: 'seung' }), /ZONES_UNDEFINED: this project has not decided its strict zones/);

      writeZones(repo, { strict: [{ path: 'src/schemas/**', reason: 'other tools read these' }], actor: 'seung' });
      commit(repo, 'Decide zones');
      // Zones alone change nothing: asking the user is the default.
      refused(light, /LIGHT_CONTRACTS_ASK: this project has its contracts approved by the user/);
      assert.equal(loadZonesPolicy(repo, 'HEAD').light_contracts, 'ask');

      assert.throws(() => setLightContracts(repo, { mode: 'always', actor: 'seung' }), /needs --mode ask or --mode standing/);
      assert.throws(() => setLightContracts(repo, { mode: 'standing', actor: ' ' }), /needs --actor/);
      setLightContracts(repo, { mode: 'standing', actor: 'seung', channel: 'interactive_terminal' });
      // Switched on in the working copy only: the committed zones still decide.
      refused(light, /LIGHT_CONTRACTS_ASK/);
      commit(repo, 'Standing rule for light contracts');
      assert.deepEqual([loadZonesPolicy(repo, 'HEAD').light_contracts, loadZonesPolicy(repo, 'HEAD').light_contracts_decided_by], ['standing', 'seung']);

      // A scope that can reach a strict zone still goes to the user, and says which pattern reaches what.
      const wide = writeContract(repo, 'WIDE', ['src/**']);
      refused(wide, /SCOPE_MAY_TOUCH_STRICT: the contract's scope can reach a strict zone \(src\/\*\* reaches src\/schemas\/\*\*\)/);
      assert.equal(readJson(wide).approval.contract_approved, false);
      assert.deepEqual(assessStandingStart(repo, readJson(wide)).reasons, ['SCOPE_MAY_TOUCH_STRICT']);

      // The light contract starts, and is recorded as started by the rule, not approved by a person.
      const started = beginUnderStandingRule(light);
      const approval = readJson(light).approval;
      assert.deepEqual([approval.contract_approved, approval.contract_approved_by, approval.contract_approved_via], [true, 'standing rule (set by seung)', 'standing_rule']);
      assert.deepEqual([started.standing_rule.set_by, started.approved_via], ['seung', 'standing_rule']);
      assert.match(started.note, /no person approved this contract\. Final human acceptance remains PENDING\./);
      assert.equal(readApprovalRecord(repo, 'LIGHT').approved_via, 'standing_rule');
      assert.throws(() => beginUnderStandingRule(light), /CONTRACT_ALREADY_APPROVED/);

      // Redefining the zones is a new decision: the rule goes back to asking.
      writeZones(repo, { strict: [{ path: 'src/schemas/**', reason: 'other tools read these' }, { path: 'docs/legal/**', reason: 'reviewed by counsel' }], actor: 'seung' });
      commit(repo, 'More zones');
      assert.equal(loadZonesPolicy(repo, 'HEAD').light_contracts, 'ask');
      refused(writeContract(repo, 'AFTER', ['docs/**']), /LIGHT_CONTRACTS_ASK/);
    } finally {
      remove(repo);
    }
  });

  it('opens the run from the command line without an approval prompt, and the reviewer sees how the contract was started', () => {
    const repo = makeRepo();
    try {
      writeZones(repo, { strict: [{ path: 'src/schemas/**', reason: 'other tools read these' }], actor: 'seung' });
      setLightContracts(repo, { mode: 'standing', actor: 'seung' });
      commit(repo, 'Zones with a standing rule');
      const cli = (...args) => spawnSync(process.execPath, [path.join(CRAFTHELM_ROOT, 'scripts', 'crafthelm.mjs'), ...args], { cwd: repo, encoding: 'utf8' });

      const wide = writeContract(repo, 'WIDE', ['src/**']);
      const refused = cli('contract', 'begin', wide, '--repo', repo, '--run-id', 'WIDE-RUN');
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /STANDING_START_REFUSED[\s\S]*SCOPE_MAY_TOUCH_STRICT/);
      assert.equal(fs.existsSync(getCheckpointPath(repo, 'WIDE-RUN')), false);
      // This hand-written contract has no interview receipt, so left in the tree it would count as a
      // stray file in the next run.
      fs.rmSync(wide);

      const light = writeContract(repo, 'LIGHT', ['docs/**']);
      const begun = cli('contract', 'begin', light, '--repo', repo, '--run-id', 'LIGHT-RUN');
      assert.equal(begun.status, 0, begun.stderr);
      const out = JSON.parse(begun.stdout);
      assert.deepEqual([out.run.run_id, out.run.state, out.approved_via], ['LIGHT-RUN', 'READY', 'standing_rule']);
      assert.match(begun.stderr, /was started under the project's standing rule \(set by seung\); nobody approved it individually/);
      // The command is not one Claude Code asks about: that prompt is what the rule replaces.
      const guards = getClaudeGuardRules();
      assert.ok(![...guards.ask, ...guards.deny].some((rule) => /begin/.test(rule)));
      assert.ok(guards.ask.some((rule) => 'crafthelm zones set-light'.includes(rule.replace(/^Bash\(\*|\*\)$/g, ''))), 'switching the rule on is asked about');

      // The work, verification and review go on as for any run; the page says how it started.
      write(repo, 'docs/guide.md', 'guide, revised\n');
      assert.equal(runVerify({ repo, runId: 'LIGHT-RUN' }).technical_status, 'VERIFIED');
      publishReviewPackage({ repo, runId: 'LIGHT-RUN', noKouetsu: true });
      const shown = buildReviewData({ repo }).groups[0].runs[0];
      assert.ok(shown.notes.some((n) => n.kind === 'contract' && /started under the project's standing rule for light contracts \(standing rule \(set by seung\)\); nobody approved it individually/.test(n.text)));
      assert.equal(shown.zone.classification, 'light');
      assert.equal(readJson(getCheckpointPath(repo, 'LIGHT-RUN')).state, 'READY_FOR_HUMAN_REVIEW');

      // A run started by the rule that then touches a strict zone is stopped by its own scope.
      commit(repo, 'Light work');
      const sneak = writeContract(repo, 'SNEAK', ['docs/**']);
      assert.equal(cli('contract', 'begin', sneak, '--repo', repo, '--run-id', 'SNEAK-RUN').status, 0);
      write(repo, 'src/schemas/book.schema.json', '{"type":"array"}\n');
      const v = runVerify({ repo, runId: 'SNEAK-RUN' });
      assert.equal(v.scope_status, 'FAIL');
      assert.ok(v.failure_reasons.some((r) => r.startsWith('SCOPE_VIOLATION') && r.includes('src/schemas/book.schema.json')));
    } finally {
      remove(repo);
    }
  });
});
