import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkContractReadiness } from '../../scripts/contract.mjs';
import { DEFAULT_CLI_TIMEOUT_MS, MIN_NODE_MAJOR, describeUnsupportedNode } from '../../scripts/crafthelm.mjs';
import { CRAFTHELM_ROOT, matchGlob, matchesAnyGlob, unsupportedGlobSyntax } from '../../scripts/lib/paths.mjs';

describe('Scope globs: the supported syntax, and a warning for the rest', () => {
  it('matches **, *, ? and a trailing slash, and treats everything else literally', () => {
    assert.equal(matchGlob('src/a/b/c.mjs', 'src/**'), true);
    assert.equal(matchGlob('src/a/b/c.mjs', 'src/**/*.mjs'), true);
    assert.equal(matchGlob('src/c.mjs', 'src/**/*.mjs'), true);
    assert.equal(matchGlob('src/a/c.mjs', 'src/*.mjs'), false);
    assert.equal(matchGlob('src/a1.mjs', 'src/a?.mjs'), true);
    assert.equal(matchGlob('src/a/1.mjs', 'src/a?1.mjs'), false);
    assert.equal(matchGlob('docs/guide/x.md', 'docs/'), true);
    assert.equal(matchGlob('docs2/x.md', 'docs/'), false);
    // A bare directory name is one path, not a prefix.
    assert.equal(matchGlob('src/a.mjs', 'src'), false);
    // Windows separators and a leading ./ are normalised on both sides.
    assert.equal(matchGlob('src\\a\\b.mjs', './src/**'), true);
    // Regex metacharacters and square brackets are literal.
    assert.equal(matchGlob('pages/[id].tsx', 'pages/[id].tsx'), true);
    assert.equal(matchGlob('pages/i.tsx', 'pages/[id].tsx'), false);
    assert.equal(matchGlob('a+b.txt', 'a+b.txt'), true);
    assert.equal(matchGlob('aab.txt', 'a+b.txt'), false);
    assert.equal(matchesAnyGlob('lib/x.mjs', ['src/**', 'lib/**']), true);
    assert.equal(matchesAnyGlob('lib/x.mjs', []), false);
  });

  it('names negation and brace alternation as unsupported, because they would match nothing', () => {
    assert.equal(matchGlob('src/a.mjs', '{src,lib}/**'), false);
    assert.match(unsupportedGlobSyntax('{src,lib}/**'), /brace/);
    assert.match(unsupportedGlobSyntax('!src/generated/**'), /negation/);
    assert.equal(unsupportedGlobSyntax('src/**/*.mjs'), null);
    assert.equal(unsupportedGlobSyntax('pages/[id].tsx'), null);
    assert.equal(unsupportedGlobSyntax('templates/{name}.txt'), null);
  });

  it('holds a contract back from approval readiness when a scope pattern is unsupported', () => {
    const contract = {
      change_kind: 'docs',
      scope: { allow: ['docs/**'], protect: ['{migrations,infra}/**'] },
      acceptance: [{ id: 'AC-01', requirement: 'REQ-01', kind: 'fast', command: 'node --version' }],
    };
    const res = checkContractReadiness(contract);
    assert.equal(res.policy_ready, false);
    assert.deepEqual(res.warnings.map((w) => w.code), ['SCOPE_GLOB_UNSUPPORTED']);
    assert.match(res.warnings[0].message, /scope\.protect .* protect nothing/);

    contract.scope.protect = ['migrations/**', 'infra/**'];
    assert.equal(checkContractReadiness(contract).policy_ready, true);
  });
});

describe('Node.js runtime check in the CLI dispatcher', () => {
  it('explains an old runtime in one line and stays silent on a supported one', () => {
    assert.equal(describeUnsupportedNode(`${MIN_NODE_MAJOR}.0.0`), null);
    assert.equal(describeUnsupportedNode('25.1.0'), null);
    assert.equal(describeUnsupportedNode(), null);
    const message = describeUnsupportedNode('22.11.0');
    assert.match(message, /needs Node\.js 24 or newer; this is 22\.11\.0/);
    assert.match(message, /nvm install 24/);
  });
});

describe('CLI: a wrong call says what was expected, and a stopped command does not look finished', () => {
  const CLI = path.join(CRAFTHELM_ROOT, 'scripts', 'crafthelm.mjs');
  const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });

  it('answers help and help <command>, and names the missing argument instead of an internal error', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-cli-args-'));
    try {
      const help = run(['help']);
      assert.deepEqual([help.status, help.stdout], [0, run(['--help']).stdout]);
      assert.match(help.stdout, /crafthelm help \[command\]/);
      assert.deepEqual([run(['help', 'contract']).status, run(['help', 'contract']).stdout], [0, run(['contract', '--help']).stdout]);
      assert.equal(run(['help', 'nope']).status, 1);

      // The form the skill used to suggest by omission: flags only, no contract path.
      const noPath = run(['contract', 'approve', '--repo', repo, '--actor', 'x']);
      assert.equal(noPath.status, 1);
      assert.match(noPath.stderr, /contract approve needs the contract file: contract approve <contractPath> --actor <name>/);
      assert.doesNotMatch(noPath.stderr, /paths\[0\]/);
      const byTask = run(['contract', 'approve', '--repo', repo, '--task-id', 'CH-T009', '--actor', 'x']);
      assert.equal(byTask.status, 1);
      assert.match(byTask.stderr, /Contract not found at .*CH-T009\.json/);
      assert.match(run(['checkpoint', 'init', '--repo', repo]).stderr, /checkpoint init needs the contract: checkpoint init --repo <path> --contract <contractPath>/);
      assert.match(run(['checkpoint', 'resume', '--repo', repo]).stderr, /checkpoint resume needs --run-id <id>/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('exits 124 and says the command did not finish when the time limit stops it', () => {
    assert.equal(DEFAULT_CLI_TIMEOUT_MS, 300_000);
    const stopped = run(['doctor', '--host', 'generic', '--json'], { CRAFTHELM_CLI_TIMEOUT_MS: '1' });
    assert.equal(stopped.status, 124);
    assert.match(stopped.stderr, /timed out after 1ms and was stopped; it did not finish \(exit code 124\)/);
    assert.equal(stopped.stdout, '');
  });

  it('says on stderr when a contract approval ran inside an agent session', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-cli-approve-'));
    try {
      const contractPath = path.join(repo, '.crafthelm', 'contracts', 'WHO.json');
      fs.mkdirSync(path.dirname(contractPath), { recursive: true });
      fs.writeFileSync(contractPath, JSON.stringify({
        schema_version: '0.3', task_id: 'WHO', request: 'Update the notes', project_root: '.', host: 'generic', change_kind: 'docs',
        methodology: { lifecycle: 'incremental', specification: 'lightweight', engineering: 'test_after', execution: 'full' },
        scope: { allow: ['docs/**'], protect: [] },
        approval: { contract_approved: false, require_on: ['scope_change'] },
        budgets: { max_worker_retries_per_cause: 3, max_lead_escalations: 3, max_wall_minutes: 30 },
        acceptance: [{ id: 'AC-01', requirement: 'REQ-01', kind: 'fast', command: 'node --version' }],
        source_policy: { authority: ['git-main'], source_refs: ['README.md'] },
      }));
      const approved = run(['contract', 'approve', '--repo', repo, '--task-id', 'WHO', '--actor', 'seung'], { CRAFTHELM_AGENT_SESSION: '1' });
      assert.equal(approved.status, 0);
      assert.match(approved.stderr, /\[notice\] This approval ran inside an AI agent session\. It is recorded as contract_approved_via "agent_session" with actor "seung"/);
      assert.equal(JSON.parse(fs.readFileSync(contractPath, 'utf8')).approval.contract_approved_via, 'agent_session');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
