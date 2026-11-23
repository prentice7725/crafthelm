import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { recordHumanDecision, verifyHumanDecision } from '../../scripts/approval.mjs';
import { initCheckpoint } from '../../scripts/checkpoint.mjs';
import { approveContractFile } from '../../scripts/contract.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import {
  AGENT_SESSION_ENV_VARS,
  APPROVERS_POLICY_PATH,
  assertHumanInteractive,
  classifyApprovalChannel,
  detectAgentSession,
  generateApproverKeyPair,
  loadApproversPolicy,
} from '../../scripts/lib/human-gate.mjs';
import { CRAFTHELM_ROOT, getApprovalDecisionPath, getCheckpointPath } from '../../scripts/lib/paths.mjs';
import { publishReviewPackage } from '../../scripts/review-package.mjs';
import { runVerify } from '../../scripts/verify.mjs';

const APPROVAL_CLI = path.join(CRAFTHELM_ROOT, 'scripts', 'approval.mjs');
const TTY = { isTTY: true };
const NO_TTY = { isTTY: false };

function envWithoutAgentSignals(extra = {}) {
  const env = { ...process.env };
  for (const name of AGENT_SESSION_ENV_VARS) delete env[name];
  return { ...env, ...extra };
}

function makeReviewReadyRepo(taskId, runId, extraFiles = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-gate-'));
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['config', 'user.name', 'CraftHelm Test']);
  runGit(repo, ['config', 'user.email', 'test@crafthelm.local']);
  const files = {
    'README.md': '# Human Gate Demo\n',
    'src/app.mjs': 'export const val = 1;\n',
    'tests/unit.mjs': "import assert from 'node:assert/strict'; import { val } from '../src/app.mjs'; assert.equal(val, 2);\n",
    'tests/e2e.mjs': "import assert from 'node:assert/strict'; import { val } from '../src/app.mjs'; assert.equal(val, 2);\n",
    ...extraFiles,
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-m', 'Baseline commit']);

  const contractPath = path.join(repo, '.crafthelm', 'contracts', `${taskId}.json`);
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(contractPath, JSON.stringify({
    schema_version: '0.3',
    task_id: taskId,
    request: 'Set val to 2',
    project_root: '.',
    host: 'generic',
    change_kind: 'feature',
    methodology: { lifecycle: 'incremental', specification: 'sdd', engineering: 'tdd', execution: 'full' },
    scope: { allow: ['src/**'], protect: [APPROVERS_POLICY_PATH] },
    approval: { contract_approved: false, require_on: ['scope_change'] },
    budgets: { max_worker_retries_per_cause: 3, max_lead_escalations: 3, max_wall_minutes: 30 },
    acceptance: [
      { id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node tests/unit.mjs', expected_exit_code: 0 },
      { id: 'AC-02', requirement: 'REQ-01', kind: 'e2e', command: 'node tests/e2e.mjs', expected_exit_code: 0 },
    ],
    source_policy: { authority: ['git-main'], source_refs: ['README.md'] },
  }, null, 2));
  approveContractFile(contractPath, 'operator');
  initCheckpoint({ repo, contract: contractPath, runId });
  fs.writeFileSync(path.join(repo, 'src/app.mjs'), 'export const val = 2;\n', 'utf8');
  assert.equal(runVerify({ repo, runId }).ok, true);
  assert.equal(publishReviewPackage({ repo, runId }).state, 'READY_FOR_HUMAN_REVIEW');
  return repo;
}

function writeKeyFile(dir, name) {
  const pair = generateApproverKeyPair();
  const keyPath = path.join(dir, name);
  fs.writeFileSync(keyPath, pair.private_key_pem, 'utf8');
  return { keyPath, fingerprint: pair.public_key_fingerprint };
}

describe('Human Gate: agent-session block, TTY confirmation tier, signed approvals', () => {
  it('detects agent sessions and classifies approval channels without guessing', () => {
    assert.deepEqual(detectAgentSession({}), { detected: false, signals: [] });
    assert.deepEqual(detectAgentSession({ CLAUDECODE: '1' }).signals, ['CLAUDECODE']);
    assert.equal(detectAgentSession({ CRAFTHELM_AGENT_SESSION: '0' }).detected, false);

    assert.throws(
      () => assertHumanInteractive({ env: { GEMINI_CLI: '1' }, stdin: TTY, stdout: TTY }),
      /HUMAN_GATE_AGENT_SESSION/,
    );
    assert.throws(() => assertHumanInteractive({ env: {}, stdin: NO_TTY, stdout: TTY }), /HUMAN_GATE_NO_TTY/);
    assert.doesNotThrow(() => assertHumanInteractive({ env: {}, stdin: TTY, stdout: TTY }));
    assert.doesNotThrow(() => assertHumanInteractive({ env: {}, stdin: NO_TTY, stdout: NO_TTY, allowNonTty: true }));
    // A signature never excuses an agent session.
    assert.throws(
      () => assertHumanInteractive({ env: { CLAUDECODE: '1' }, stdin: NO_TTY, stdout: NO_TTY, allowNonTty: true }),
      /HUMAN_GATE_AGENT_SESSION/,
    );

    assert.equal(classifyApprovalChannel({ env: { AI_AGENT: 'x' }, stdin: TTY, stdout: TTY }), 'agent_session');
    assert.equal(classifyApprovalChannel({ env: {}, stdin: TTY, stdout: TTY }), 'interactive_terminal');
    assert.equal(classifyApprovalChannel({ env: {}, stdin: NO_TTY, stdout: TTY }), 'non_interactive');
  });

  it('refuses `approval.mjs record` from an agent session or a non-interactive shell and writes nothing', () => {
    const repo = makeReviewReadyRepo('GATE-CLI', 'GATE-CLI-RUN');
    try {
      const cliArgs = [
        APPROVAL_CLI, 'record', '--repo', repo, '--run-id', 'GATE-CLI-RUN',
        '--decision', 'accept', '--actor', 'agent', '--rationale', 'self approval attempt',
      ];
      const fromAgent = spawnSync(process.execPath, cliArgs, {
        env: envWithoutAgentSignals({ CRAFTHELM_AGENT_SESSION: '1' }),
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(fromAgent.status, 1);
      assert.match(fromAgent.stderr, /HUMAN_GATE_AGENT_SESSION/);

      const piped = spawnSync(process.execPath, cliArgs, {
        env: envWithoutAgentSignals(),
        input: '',
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(piped.status, 1);
      assert.match(piped.stderr, /HUMAN_GATE_NO_TTY/);

      assert.equal(fs.existsSync(getApprovalDecisionPath(repo, 'GATE-CLI-RUN')), false);
      const checkpoint = JSON.parse(fs.readFileSync(getCheckpointPath(repo, 'GATE-CLI-RUN'), 'utf8'));
      assert.equal(checkpoint.state, 'READY_FOR_HUMAN_REVIEW');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('enforces the protected approvers policy: unsigned and untrusted decisions are rejected, trusted signatures verify', () => {
    const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-gate-keys-'));
    const trusted = writeKeyFile(keyDir, 'approver.pem');
    const stranger = writeKeyFile(keyDir, 'stranger.pem');
    const repo = makeReviewReadyRepo('GATE-SIG', 'GATE-SIG-RUN', {
      [APPROVERS_POLICY_PATH]: `${JSON.stringify({
        require_signed: true,
        approvers: [{ actor: 'release-owner', public_key_fingerprint: trusted.fingerprint }],
      }, null, 2)}\n`,
    });
    const base = { repo, runId: 'GATE-SIG-RUN', decision: 'accept', rationale: 'Checked diff and E2E evidence' };

    try {
      // The policy is read from the committed base ref.
      const checkpoint = JSON.parse(fs.readFileSync(getCheckpointPath(repo, 'GATE-SIG-RUN'), 'utf8'));
      const policy = loadApproversPolicy(repo, checkpoint.baseline_git_head);
      assert.equal(policy.present, true);
      assert.equal(policy.require_signed, true);

      // Programmatic or agent-driven unsigned approval cannot reach ACCEPTED.
      assert.throws(() => recordHumanDecision({ ...base, actor: 'release-owner' }), /SIGNATURE_REQUIRED/);
      // A valid key that the policy does not list is rejected.
      assert.throws(
        () => recordHumanDecision({ ...base, actor: 'release-owner', signKeyPath: stranger.keyPath }),
        /APPROVER_NOT_TRUSTED/,
      );
      // A listed key under a different actor name is rejected.
      assert.throws(
        () => recordHumanDecision({ ...base, actor: 'someone-else', signKeyPath: trusted.keyPath }),
        /APPROVER_NOT_TRUSTED/,
      );
      // Rejected attempts leave no record and no state change.
      assert.equal(fs.existsSync(getApprovalDecisionPath(repo, 'GATE-SIG-RUN')), false);
      assert.equal(
        JSON.parse(fs.readFileSync(getCheckpointPath(repo, 'GATE-SIG-RUN'), 'utf8')).state,
        'READY_FOR_HUMAN_REVIEW',
      );

      const dec = recordHumanDecision({ ...base, actor: 'release-owner', signKeyPath: trusted.keyPath });
      assert.equal(dec.state, 'ACCEPTED');
      assert.equal(dec.verification_type, 'signed_ed25519');
      assert.equal(dec.identity, 'SIGNATURE_TRUSTED');

      const verified = verifyHumanDecision({ repo, runId: 'GATE-SIG-RUN' });
      assert.equal(verified.valid, true);
      assert.equal(verified.identity, 'SIGNATURE_TRUSTED');

      // Editing any signed field breaks the signature.
      const decisionPath = getApprovalDecisionPath(repo, 'GATE-SIG-RUN');
      const record = JSON.parse(fs.readFileSync(decisionPath, 'utf8'));
      fs.writeFileSync(decisionPath, `${JSON.stringify({ ...record, rationale: 'rewritten later' }, null, 2)}\n`, 'utf8');
      const tampered = verifyHumanDecision({ repo, runId: 'GATE-SIG-RUN' });
      assert.equal(tampered.valid, false);
      assert.equal(tampered.identity, 'SIGNATURE_INVALID');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(keyDir, { recursive: true, force: true });
    }
  });

  it('labels identity tiers honestly when no approvers policy exists', () => {
    const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-gate-keys-'));
    const key = writeKeyFile(keyDir, 'solo.pem');
    const repoPlain = makeReviewReadyRepo('GATE-PLAIN', 'GATE-PLAIN-RUN');
    const repoTty = makeReviewReadyRepo('GATE-TTY', 'GATE-TTY-RUN');
    const repoSigned = makeReviewReadyRepo('GATE-SOLO', 'GATE-SOLO-RUN');
    const common = { decision: 'accept', actor: 'reviewer', rationale: 'Checked diff' };

    try {
      const plain = recordHumanDecision({ ...common, repo: repoPlain, runId: 'GATE-PLAIN-RUN' });
      assert.equal(plain.verification_type, 'local_explicit_input_not_identity_verified');
      assert.equal(plain.identity, 'UNSIGNED');

      const tty = recordHumanDecision({ ...common, repo: repoTty, runId: 'GATE-TTY-RUN', ttyConfirmed: true });
      assert.equal(tty.verification_type, 'local_tty_confirmed_not_identity_verified');

      // Signed without a protected policy: signature is valid but trust is not claimed.
      const signed = recordHumanDecision({ ...common, repo: repoSigned, runId: 'GATE-SOLO-RUN', signKeyPath: key.keyPath });
      assert.equal(signed.verification_type, 'signed_ed25519');
      assert.equal(signed.identity, 'SIGNATURE_VALID_UNTRUSTED_KEY');
      assert.equal(verifyHumanDecision({ repo: repoSigned, runId: 'GATE-SOLO-RUN' }).valid, true);
    } finally {
      for (const dir of [repoPlain, repoTty, repoSigned, keyDir]) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ships Claude permissions that deny agent self-approval and prompt before contract approval', () => {
    const settings = JSON.parse(
      fs.readFileSync(path.join(CRAFTHELM_ROOT, 'hosts', 'claude', 'settings.example.json'), 'utf8'),
    );
    const { ask, deny } = settings.permissions;
    assert.ok(deny.includes('Bash(*approval.mjs record*)'));
    assert.ok(deny.includes('Bash(*crafthelm.mjs approve record*)'));
    assert.ok(ask.includes('Bash(*crafthelm.mjs contract approve*)'));
    assert.ok(ask.includes('Bash(*--approve-contract*)'));
  });
});
