import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { recordHumanDecision, verifyHumanDecision } from '../../scripts/approval.mjs';
import {
  acquireWriterLock,
  approveStage,
  initCheckpoint,
  recordRepairRound,
  recordStage,
  releaseWriterLock,
  replanRun,
  resumeRun,
} from '../../scripts/checkpoint.mjs';
import { approveContractFile } from '../../scripts/contract.mjs';
import { runFeedbackLoop } from '../../scripts/feedback-loop.mjs';
import { initHost } from '../../scripts/init-host.mjs';
import { runInterview } from '../../scripts/interview.mjs';
import { runGit } from '../../scripts/lib/git.mjs';
import { getApprovalDecisionPath, getCheckpointPath, getRunDir } from '../../scripts/lib/paths.mjs';
import { publishReviewPackage } from '../../scripts/review-package.mjs';
import { lockApprovedSkills, verifySkillLock } from '../../scripts/skills.mjs';
import { recordBaselineGreen, recordRedEvidence, runVerify } from '../../scripts/verify.mjs';

function createTempRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-e2e-'));
  runGit(dir, ['init', '-b', 'main']);
  runGit(dir, ['config', 'user.name', 'CraftHelm E2E']);
  runGit(dir, ['config', 'user.email', 'e2e@crafthelm.local']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'Initial baseline']);
  return dir;
}

describe('CraftHelm M0 Vertical Slice E2E Tests (Flows A-N)', () => {
  it('Flow A: Claude-only TDD feature -> RED -> GREEN -> E2E -> Kouetsu -> READY_FOR_HUMAN_REVIEW -> ACCEPT (E01/E02/H06)', () => {
    const claudeKouetsuExists = fs.existsSync(
      path.join(os.homedir(), '.claude', 'plugins', 'cache', 'prentice7725', 'kouetsu', '1.1.0', 'skills', 'kouetsu', 'SKILL.md'),
    );
    const repo = createTempRepo({
      'README.md': '# Auth Demo\n',
      'src/auth.mjs': 'export function authenticate() { return false; }\n',
      'tests/unit.test.mjs': "import assert from 'node:assert/strict'; import { authenticate } from '../src/auth.mjs'; assert.equal(authenticate('alice', 's3cr3t'), true);\n",
      'tests/e2e.test.mjs': "import assert from 'node:assert/strict'; import { authenticate } from '../src/auth.mjs'; assert.equal(authenticate('alice', 's3cr3t'), true); assert.equal(authenticate('alice', 'bad'), false);\n",
    });

    try {
      const iv = runInterview({
        repo,
        taskId: 'CH-FLOW-A',
        request: 'Implement credential verification',
        host: 'claude',
        inputData: {
          change_kind: 'feature',
          scope: { allow: ['src/**', 'tests/**'], protect: ['README.md'] },
          acceptance: [
            { id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node tests/unit.test.mjs', expected_exit_code: 0, require_red_first: true },
            { id: 'AC-02', requirement: 'REQ-01', kind: 'e2e', command: 'node tests/e2e.test.mjs', expected_exit_code: 0 },
          ],
        },
      });
      assert.equal(iv.ok, true);
      approveContractFile(iv.contract_path, 'lead-operator');

      if (claudeKouetsuExists) {
        const lockRes = lockApprovedSkills({ repo, host: 'claude' });
        assert.equal(lockRes.ok, true);
        assert.equal(verifySkillLock({ repo }).ok, true);
      }

      const cp = initCheckpoint({ repo, contract: iv.contract_path, runId: 'RUN-A' });
      assert.equal(cp.state, 'READY');

      // RED-First failure before fix
      const redRes = recordRedEvidence({ repo, runId: 'RUN-A', acId: 'AC-01' });
      assert.equal(redRes.ok, true);
      assert.notEqual(redRes.red_exit_code, 0);

      // Implement feature (GREEN)
      fs.writeFileSync(
        path.join(repo, 'src/auth.mjs'),
        "export function authenticate(user, pass) { return user === 'alice' && pass === 's3cr3t'; }\n",
        'utf8',
      );

      const v = runVerify({ repo, runId: 'RUN-A' });
      assert.equal(v.ok, true);
      assert.equal(v.technical_status, 'VERIFIED');

      const pkg = publishReviewPackage({
        repo,
        runId: 'RUN-A',
        ...(claudeKouetsuExists ? {} : { kouetsuRoot: path.resolve('hosts/codex/skills/kouetsu') }),
      });
      if (claudeKouetsuExists) {
        assert.equal(pkg.ok, true);
        assert.equal(pkg.state, 'READY_FOR_HUMAN_REVIEW');
        assert.equal(pkg.editorial_status, 'PASS');
        assert.equal(fs.existsSync(getApprovalDecisionPath(repo, 'RUN-A')), false);

        const accepted = recordHumanDecision({
          repo,
          runId: 'RUN-A',
          decision: 'accept',
          actor: 'chang',
          rationale: 'All checks and E2E passed',
        });
        assert.equal(accepted.ok, true);
        assert.equal(accepted.state, 'ACCEPTED');
        assert.equal(verifyHumanDecision({ repo, runId: 'RUN-A' }).valid, true);
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('Flow B: Codex-only Preserve refactor -> CHANGES_REQUESTED -> rework -> re-verify -> updated Review Package -> ACCEPT (H02/E03/E12)', () => {
    const repo = createTempRepo({
      'README.md': '# Refactor Demo\n',
      'src/sum.mjs': 'export function sum(arr) { let total = 0; for (const n of arr) total += n; return total; }\n',
      'tests/preserve.test.mjs': "import assert from 'node:assert/strict'; import { sum } from '../src/sum.mjs'; assert.equal(sum([1, 2, 3]), 6);\n",
      'tests/e2e.test.mjs': "import assert from 'node:assert/strict'; import { sum } from '../src/sum.mjs'; assert.equal(sum([10, 20]), 30);\n",
    });

    try {
      const iv = runInterview({
        repo,
        taskId: 'CH-FLOW-B',
        request: 'Refactor sum helper preserving behavior',
        host: 'codex',
        inputData: {
          change_kind: 'refactor',
          methodology: { lifecycle: 'incremental', specification: 'existing', engineering: 'characterization_first', execution: 'full' },
          scope: { allow: ['src/**'], protect: ['tests/preserve.test.mjs'] },
          acceptance: [
            { id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node tests/preserve.test.mjs', expected_exit_code: 0 },
            { id: 'AC-02', requirement: 'REQ-01', kind: 'e2e', command: 'node tests/e2e.test.mjs', expected_exit_code: 0 },
          ],
        },
      });
      approveContractFile(iv.contract_path, 'operator');
      lockApprovedSkills({ repo, host: 'codex' });
      initCheckpoint({ repo, contract: iv.contract_path, runId: 'RUN-B' });

      const baseGreen = recordBaselineGreen({ repo, runId: 'RUN-B', acId: 'AC-01' });
      assert.equal(baseGreen.ok, true);

      // Refactor code
      fs.writeFileSync(path.join(repo, 'src/sum.mjs'), 'export function sum(arr) { return arr.reduce((a, b) => a + b, 0); }\n', 'utf8');
      const v1 = runVerify({ repo, runId: 'RUN-B' });
      assert.equal(v1.ok, true);

      const pkg1 = publishReviewPackage({ repo, runId: 'RUN-B' });
      assert.equal(pkg1.ok, true);
      assert.equal(pkg1.state, 'READY_FOR_HUMAN_REVIEW');

      // Human requests changes (H02 / E12)
      const reqChanges = recordHumanDecision({
        repo,
        runId: 'RUN-B',
        decision: 'changes-requested',
        actor: 'reviewer',
        rationale: 'Handle empty array safely with explicit default',
        relatedRequirements: ['REQ-01'],
        reproConditions: 'sum([])',
      });
      assert.equal(reqChanges.state, 'CHANGES_REQUESTED');

      // Rework & re-verify
      fs.writeFileSync(path.join(repo, 'src/sum.mjs'), 'export function sum(arr = []) { return arr.reduce((a, b) => a + b, 0); }\n', 'utf8');
      const v2 = runVerify({ repo, runId: 'RUN-B' });
      assert.equal(v2.ok, true);
      const pkg2 = publishReviewPackage({ repo, runId: 'RUN-B' });
      assert.equal(pkg2.ok, true);
      assert.notEqual(pkg2.report_sha256, pkg1.report_sha256);

      const finalAccept = recordHumanDecision({
        repo,
        runId: 'RUN-B',
        decision: 'accept',
        actor: 'reviewer',
        rationale: 'Empty array handling verified',
      });
      assert.equal(finalAccept.state, 'ACCEPTED');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('Flow C: Unit tests PASS while E2E smoke FAILS blocks technical pass (V01 / E15)', () => {
    const repo = createTempRepo({
      'src/app.mjs': 'export const unitOk = true;\n',
      'tests/unit.test.mjs': 'process.exit(0);\n',
      'tests/e2e.test.mjs': 'console.error("E2E connection failed"); process.exit(1);\n',
    });

    try {
      const iv = runInterview({
        repo,
        taskId: 'CH-FLOW-C',
        request: 'Feature with broken E2E flow',
        host: 'codex',
        inputData: {
          change_kind: 'feature',
          scope: { allow: ['src/**'], protect: [] },
          acceptance: [
            { id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node tests/unit.test.mjs', expected_exit_code: 0 },
            { id: 'AC-02', requirement: 'REQ-01', kind: 'e2e', command: 'node tests/e2e.test.mjs', expected_exit_code: 0 },
          ],
        },
      });
      approveContractFile(iv.contract_path, 'operator');
      initCheckpoint({ repo, contract: iv.contract_path, runId: 'RUN-C' });

      const v = runVerify({ repo, runId: 'RUN-C' });
      assert.equal(v.ok, false);
      assert.equal(v.technical_status, 'FAILED');
      assert.ok(v.failure_reasons.some((r) => r.includes('E2E_FAILED')));

      const pkg = publishReviewPackage({ repo, runId: 'RUN-C' });
      assert.equal(pkg.ok, false);
      assert.equal(pkg.error_code, 'TECHNICAL_VERIFICATION_NOT_PASSED');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('Flow D: 1-byte code edit after verify/review marks stamp & review STALE (V03 / E19)', () => {
    const repo = createTempRepo({
      'src/app.mjs': 'export const n = 1;\n',
      'tests/unit.test.mjs': 'process.exit(0);\n',
      'tests/e2e.test.mjs': 'process.exit(0);\n',
    });

    try {
      const iv = runInterview({
        repo,
        taskId: 'CH-FLOW-D',
        request: 'Check stale detection',
        host: 'codex',
        inputData: {
          scope: { allow: ['src/**'], protect: [] },
          acceptance: [
            { id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node tests/unit.test.mjs', expected_exit_code: 0 },
            { id: 'AC-02', requirement: 'REQ-01', kind: 'e2e', command: 'node tests/e2e.test.mjs', expected_exit_code: 0 },
          ],
        },
      });
      approveContractFile(iv.contract_path, 'operator');
      initCheckpoint({ repo, contract: iv.contract_path, runId: 'RUN-D' });

      const v = runVerify({ repo, runId: 'RUN-D' });
      assert.equal(v.ok, true);

      // Write an advisory review bound to the verified snapshot, then mutate src/app.mjs by 1 byte
      const reviewPath = path.join(getRunDir(repo, 'RUN-D'), 'evidence', 'review.json');
      fs.writeFileSync(reviewPath, JSON.stringify({ status: 'PASS', target_snapshot_digest: v.target_snapshot_digest }), 'utf8');
      fs.writeFileSync(path.join(repo, 'src/app.mjs'), 'export const n = 2;\n', 'utf8');

      // Publishing review package detects stale snapshot immediately
      const pkg = publishReviewPackage({ repo, runId: 'RUN-D' });
      assert.equal(pkg.ok, false);
      assert.equal(pkg.error_code, 'STALE_SNAPSHOT');

      // Running verify without updating review also flags review STALE
      const vStale = runVerify({ repo, runId: 'RUN-D', reviewFile: reviewPath });
      assert.equal(vStale.ok, false);
      assert.equal(vStale.technical_status, 'STALE');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('Flow E: Escalates to BLOCKED_HUMAN_ATTENTION after 3 failed repair rounds and blocks round 4 (V04 / E20)', () => {
    const repo = createTempRepo({ 'src/app.mjs': 'export const x = 1;\n' });
    try {
      const iv = runInterview({
        repo,
        taskId: 'CH-FLOW-E',
        request: 'Test 3-round repair cap',
        host: 'codex',
        inputData: {
          scope: { allow: ['src/**'], protect: [] },
          acceptance: [{ id: 'AC-01', requirement: 'REQ-01', kind: 'e2e', command: 'node -e "process.exit(1)"' }],
        },
      });
      approveContractFile(iv.contract_path, 'operator');
      initCheckpoint({ repo, contract: iv.contract_path, runId: 'RUN-E' });

      assert.equal(recordRepairRound({ repo, runId: 'RUN-E', cause: 'e2e_timeout', check: 'AC-01', command: 'node test' }).escalated, false);
      assert.equal(recordRepairRound({ repo, runId: 'RUN-E', cause: 'e2e_timeout', check: 'AC-01', command: 'node test' }).escalated, false);
      const r3 = recordRepairRound({ repo, runId: 'RUN-E', cause: 'e2e_timeout', check: 'AC-01', command: 'node test' });
      assert.equal(r3.escalated, true);
      assert.equal(r3.state, 'BLOCKED_HUMAN_ATTENTION');
      assert.equal(fs.existsSync(path.join(getRunDir(repo, 'RUN-E'), r3.escalation_file)), true);

      // Round 4 must be blocked
      const r4 = recordRepairRound({ repo, runId: 'RUN-E', cause: 'e2e_timeout', check: 'AC-01', command: 'node test' });
      assert.equal(r4.ok, false);
      assert.equal(r4.error_code, 'REPAIR_LIMIT_EXCEEDED');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('Flow F: Diff-triggered reliability rules honor observe vs enforce and log non_trigger_reason (V05 / V08)', () => {
    const rules = [
      {
        id: 'RULE-OBS-01',
        source: 'incident-1',
        trigger: { paths: ['src/session/**'], changed_symbols: ['resumeSession'] },
        check: { command_id: 'session-replay', command: 'node -e "process.exit(1)"' },
        severity: 'must_fix',
        policy_mode: 'observe',
        status: 'observe',
        owner: 'team',
      },
      {
        id: 'RULE-UNMATCHED-02',
        source: 'incident-2',
        trigger: { paths: ['src/billing/**'] },
        check: { command_id: 'billing-check', command: 'node -e "process.exit(1)"' },
        severity: 'must_fix',
        policy_mode: 'enforce',
        status: 'enforce',
        owner: 'team',
      },
    ];

    const repo = createTempRepo({
      '.crafthelm/reliability-rules.json': JSON.stringify(rules, null, 2),
      'src/session/state.mjs': 'export function resumeSession() { return 1; }\n',
      'tests/unit.mjs': 'process.exit(0);\n',
      'tests/e2e.mjs': 'process.exit(0);\n',
    });

    try {
      const iv = runInterview({
        repo,
        taskId: 'CH-FLOW-F',
        request: 'Update resumeSession',
        host: 'codex',
        inputData: {
          scope: { allow: ['src/session/**'], protect: ['.crafthelm/reliability-rules.json'] },
          acceptance: [
            { id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node tests/unit.mjs' },
            { id: 'AC-02', requirement: 'REQ-01', kind: 'e2e', command: 'node tests/e2e.mjs' },
          ],
        },
      });
      approveContractFile(iv.contract_path, 'operator');
      initCheckpoint({ repo, contract: iv.contract_path, runId: 'RUN-F' });

      fs.writeFileSync(path.join(repo, 'src/session/state.mjs'), 'export function resumeSession() { return 2; }\n', 'utf8');
      const v = runVerify({ repo, runId: 'RUN-F' });
      assert.equal(v.ok, true);

      const manifest = JSON.parse(fs.readFileSync(path.join(getRunDir(repo, 'RUN-F'), 'evidence-manifest.json'), 'utf8'));
      const obsRule = manifest.reliability_checks.find((r) => r.id === 'RULE-OBS-01');
      const skipRule = manifest.reliability_checks.find((r) => r.id === 'RULE-UNMATCHED-02');
      assert.equal(obsRule.triggered, true);
      assert.equal(obsRule.status, 'OBSERVED_FAIL');
      assert.equal(skipRule.triggered, false);
      assert.ok(skipRule.non_trigger_reason.includes('src/billing/**'));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('Flow G: Blocks broken links/AC mismatch (H04), missing Kouetsu (H05), Critical [확인 필요] (H07), and surface loops (E13)', () => {
    const repo = createTempRepo({
      'src/app.mjs': 'export const v = 1;\n',
      'tests/unit.mjs': 'process.exit(0);\n',
      'tests/e2e.mjs': 'process.exit(0);\n',
    });
    const draftDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-drafts-'));

    try {
      const iv = runInterview({
        repo,
        taskId: 'CH-FLOW-G',
        request: 'Validate review package gates',
        host: 'codex',
        inputData: {
          scope: { allow: ['src/**'], protect: [] },
          acceptance: [
            { id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node tests/unit.mjs' },
            { id: 'AC-02', requirement: 'REQ-01', kind: 'e2e', command: 'node tests/e2e.mjs' },
          ],
        },
      });
      approveContractFile(iv.contract_path, 'operator');
      initCheckpoint({ repo, contract: iv.contract_path, runId: 'RUN-G' });
      assert.equal(runVerify({ repo, runId: 'RUN-G' }).ok, true);

      // H05: --no-kouetsu blocks READY_FOR_HUMAN_REVIEW and records MISSING
      const noK = publishReviewPackage({ repo, runId: 'RUN-G', noKouetsu: true });
      assert.equal(noK.ok, false);
      assert.equal(noK.error_code, 'KOUETSU_MISSING_BLOCKED');
      assert.equal(noK.editorial_status, 'MISSING');

      // H04: Broken link + AC status mismatch in draft override
      const badParityDraft = path.join(draftDir, 'bad-parity.md');
      fs.writeFileSync(badParityDraft, [
        '# CraftHelm — 사람의 인수 검토 보고서 v0.3',
        '## 1. 지금 결정해야 할 것',
        '## 2. 변경 내용',
        '## 3. 요구사항과 검증 결과',
        '| `AC-01` | REQ-01 | unit | FAIL | `../evidence/missing.stdout.txt` | 확인 |',
        '| `AC-02` | REQ-01 | e2e | PASS | `../evidence/tests/AC-02.stdout.txt` | 확인 |',
        '## 4. 직접 확인할 시나리오',
        '## 5. 실행 검증의 범위와 한계',
        '## 6. 위험 및 미해결 사항',
        '## 7. 근거 자료',
        '## 8. 검토자의 결정',
      ].join('\n'), 'utf8');
      const h04Res = publishReviewPackage({ repo, runId: 'RUN-G', draftOverride: badParityDraft });
      assert.equal(h04Res.ok, false);
      assert.equal(h04Res.error_code, 'REVIEW_PACKAGE_VALIDATION_FAILED');
      assert.ok(h04Res.broken_links.length >= 1);
      assert.ok(h04Res.ac_mismatches.length >= 1);

      // E13: Repeated surface pattern (>2) fails Kouetsu editorial gate
      const surfaceLoopDraft = path.join(draftDir, 'surface-loop.md');
      fs.writeFileSync(surfaceLoopDraft, [
        '# CraftHelm — 사람의 인수 검토 보고서 v0.3',
        '## 1. 지금 결정해야 할 것',
        '다양한 검증을 통해 다양한 상황에서 다양한 결과를 확인했습니다.',
        '## 2. 변경 내용',
        '개발자가 `src/app.mjs`를 수정했습니다.',
        '## 3. 요구사항과 검증 결과',
        '| `AC-01` | REQ-01 | unit | PASS | `../evidence/tests/AC-01.stdout.txt` | 확인 |',
        '| `AC-02` | REQ-01 | e2e | PASS | `../evidence/tests/AC-02.stdout.txt` | 확인 |',
        '## 4. 직접 확인할 시나리오',
        '## 5. 실행 검증의 범위와 한계',
        '## 6. 위험 및 미해결 사항',
        '## 7. 근거 자료',
        '## 8. 검토자의 결정',
        '현재 상태: **미승인 (PENDING)**',
      ].join('\n'), 'utf8');
      const e13Res = publishReviewPackage({ repo, runId: 'RUN-G', draftOverride: surfaceLoopDraft });
      assert.equal(e13Res.ok, false);
      assert.equal(e13Res.error_code, 'EDITORIAL_GATE_FAILED');

      // H07: Critical [확인 필요] transitions checkpoint to BLOCKED
      const criticalDraft = path.join(draftDir, 'critical.md');
      fs.writeFileSync(criticalDraft, [
        '# CraftHelm — 사람의 인수 검토 보고서 v0.3',
        '## 1. 지금 결정해야 할 것',
        '| 미결 | [확인 필요: 운영 DB 마이그레이션 허용 여부] |',
        '## 2. 변경 내용',
        '## 3. 요구사항과 검증 결과',
        '| `AC-01` | REQ-01 | unit | PASS | `../evidence/tests/AC-01.stdout.txt` | 확인 |',
        '| `AC-02` | REQ-01 | e2e | PASS | `../evidence/tests/AC-02.stdout.txt` | 확인 |',
        '## 4. 직접 확인할 시나리오',
        '## 5. 실행 검증의 범위와 한계',
        '## 6. 위험 및 미해결 사항',
        '## 7. 근거 자료',
        '## 8. 검토자의 결정',
      ].join('\n'), 'utf8');
      const h07Res = publishReviewPackage({ repo, runId: 'RUN-G', draftOverride: criticalDraft });
      assert.equal(h07Res.ok, false);
      assert.equal(h07Res.error_code, 'CRITICAL_CONFIRMATION_BLOCKED');
      assert.equal(h07Res.state, 'BLOCKED');
    } finally {
      fs.rmSync(draftDir, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('Flow H: Interview BLOCKERs, single-writer lock, Waterfall gates, Resume & Replan (E04/E05/E06)', () => {
    const repo = createTempRepo({ 'README.md': '# Workflow Demo\n' });
    try {
      // E04: unresolved BLOCKER returns INTERVIEW_REQUIRED
      const blockedIv = runInterview({
        repo,
        taskId: 'CH-FLOW-H',
        request: 'Build waterfall workflow',
        host: 'codex',
        nonInteractive: true,
        inputData: {
          uncertainties: [{ id: 'B-1', level: 'BLOCKER', question: 'Confirm SLA?', resolved: false }],
        },
      });
      assert.equal(blockedIv.ok, false);
      assert.equal(blockedIv.status, 'INTERVIEW_REQUIRED');

      const iv = runInterview({
        repo,
        taskId: 'CH-FLOW-H',
        request: 'Build waterfall workflow',
        host: 'codex',
        inputData: {
          methodology: { lifecycle: 'waterfall', specification: 'sdd', engineering: 'tdd', execution: 'full' },
          scope: { allow: ['src/**'], protect: ['README.md'] },
          acceptance: [{ id: 'AC-01', requirement: 'REQ-01', kind: 'e2e', command: 'node -e "process.exit(0)"' }],
        },
      });
      approveContractFile(iv.contract_path, 'pm');
      initCheckpoint({ repo, contract: iv.contract_path, runId: 'RUN-H' });

      // Single-writer lock enforcement
      assert.equal(acquireWriterLock({ repo, runId: 'RUN-H', writer: 'w1' }).ok, true);
      assert.equal(acquireWriterLock({ repo, runId: 'RUN-H', writer: 'w2' }).error_code, 'CONCURRENT_WRITER_BLOCKED');
      assert.equal(resumeRun({ repo, runId: 'RUN-H', contract: iv.contract_path }).error_code, 'CONCURRENT_WRITER_BLOCKED');
      releaseWriterLock({ repo, runId: 'RUN-H', writer: 'w1' });

      // E05: Waterfall blocks implementation without prior stage approvals
      const blockedStage = recordStage({ repo, runId: 'RUN-H', stage: 'implementation', status: 'started' });
      assert.equal(blockedStage.ok, false);
      assert.equal(blockedStage.error_code, 'WATERFALL_GATE_BLOCKED');

      approveStage({ repo, runId: 'RUN-H', stage: 'requirements', actor: 'pm' });
      approveStage({ repo, runId: 'RUN-H', stage: 'architecture', actor: 'pm' });
      approveStage({ repo, runId: 'RUN-H', stage: 'detailed_design', actor: 'pm' });
      assert.equal(recordStage({ repo, runId: 'RUN-H', stage: 'implementation', status: 'started' }).ok, true);

      // E06: Contract edit triggers REPLAN_REQUIRED on resume; replan preserves history
      const cObj = JSON.parse(fs.readFileSync(iv.contract_path, 'utf8'));
      cObj.request = 'Build waterfall workflow with audit log';
      fs.writeFileSync(iv.contract_path, JSON.stringify(cObj, null, 2), 'utf8');
      const resReplan = resumeRun({ repo, runId: 'RUN-H', contract: iv.contract_path });
      assert.equal(resReplan.ok, false);
      assert.equal(resReplan.error_code, 'REPLAN_REQUIRED');

      approveContractFile(iv.contract_path, 'pm');
      const replanned = replanRun({ repo, runId: 'RUN-H', contract: iv.contract_path, reason: 'Added audit log requirement' });
      assert.equal(replanned.ok, true);
      const cpAfter = JSON.parse(fs.readFileSync(getCheckpointPath(repo, 'RUN-H'), 'utf8'));
      assert.equal(cpAfter.replan_history.length, 1);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('Flow I: Preserves Property counterexample/seed and audits Differential allowed_diffs (V06/V07/E16/E17)', () => {
    const repo = createTempRepo({
      'tests/prop-fail.mjs': 'console.log(JSON.stringify({ seed: "seed-42", counterexample: { input: -1 } })); process.exit(1);\n',
      'tests/diff-old.mjs': 'console.log(JSON.stringify({ total: 100, timestamp: "2026-01-01" }));\n',
      'tests/diff-new-ok.mjs': 'console.log(JSON.stringify({ total: 100, timestamp: "2026-11-19" }));\n',
      'tests/diff-new-bad.mjs': 'console.log(JSON.stringify({ total: 99, timestamp: "2026-11-19" }));\n',
      'tests/e2e.mjs': 'process.exit(0);\n',
    });

    try {
      const iv = runInterview({
        repo,
        taskId: 'CH-FLOW-I',
        request: 'Property & Differential verification',
        host: 'codex',
        inputData: {
          scope: { allow: ['src/**'], protect: [] },
          acceptance: [
            { id: 'AC-PROP', requirement: 'REQ-01', kind: 'property', command: 'node tests/prop-fail.mjs' },
            {
              id: 'AC-DIFF',
              requirement: 'REQ-02',
              kind: 'differential',
              baseline_command: 'node tests/diff-old.mjs',
              command: 'node tests/diff-new-ok.mjs',
              allowed_diffs: ['^timestamp$'],
            },
            { id: 'AC-E2E', requirement: 'REQ-01', kind: 'e2e', command: 'node tests/e2e.mjs' },
          ],
        },
      });
      approveContractFile(iv.contract_path, 'operator');
      initCheckpoint({ repo, contract: iv.contract_path, runId: 'RUN-I' });

      const v1 = runVerify({ repo, runId: 'RUN-I' });
      assert.equal(v1.ok, false);
      const manifest1 = JSON.parse(fs.readFileSync(path.join(getRunDir(repo, 'RUN-I'), 'evidence-manifest.json'), 'utf8'));
      const propCheck = manifest1.checks.find((c) => c.id === 'AC-PROP');
      const diffCheckOk = manifest1.checks.find((c) => c.id === 'AC-DIFF');
      assert.equal(propCheck.status, 'FAIL');
      assert.equal(propCheck.seed, 'seed-42');
      assert.ok(fs.existsSync(path.join(getRunDir(repo, 'RUN-I'), propCheck.counterexample_file)));
      assert.equal(diffCheckOk.status, 'PASS');

      // Now switch differential check to unapproved behavioral divergence
      const cObj = JSON.parse(fs.readFileSync(iv.contract_path, 'utf8'));
      cObj.acceptance[0].command = 'node tests/e2e.mjs';
      cObj.acceptance[1].command = 'node tests/diff-new-bad.mjs';
      fs.writeFileSync(iv.contract_path, JSON.stringify(cObj, null, 2), 'utf8');
      replanRun({ repo, runId: 'RUN-I', contract: iv.contract_path, reason: 'Test unapproved differential divergence' });

      const v2 = runVerify({ repo, runId: 'RUN-I' });
      assert.equal(v2.ok, false);
      const manifest2 = JSON.parse(fs.readFileSync(path.join(getRunDir(repo, 'RUN-I'), 'evidence-manifest.json'), 'utf8'));
      const diffCheckBad = manifest2.checks.find((c) => c.id === 'AC-DIFF');
      assert.equal(diffCheckBad.status, 'FAIL');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('Flow J: Antigravity host init-host -> interview -> skills lock -> verify -> Kouetsu -> READY_FOR_HUMAN_REVIEW -> ACCEPT', () => {
    const repo = createTempRepo({
      'README.md': '# Antigravity Flow Demo\n',
      'src/service.mjs': 'export function greet(name) { return `hi ${name}`; }\n',
      'tests/unit.test.mjs': "import assert from 'node:assert/strict'; import { greet } from '../src/service.mjs'; assert.equal(greet('agy'), 'hello agy');\n",
      'tests/e2e.test.mjs': "import assert from 'node:assert/strict'; import { greet } from '../src/service.mjs'; assert.equal(greet('user'), 'hello user');\n",
    });

    try {
      const initRes = initHost({ repo, host: 'antigravity' });
      assert.equal(initRes.ok, true);
      assert.equal(fs.existsSync(path.join(repo, '.agents', 'skills', 'crafthelm', 'SKILL.md')), true);
      assert.equal(fs.existsSync(path.join(repo, '.agents', 'skills', 'kouetsu', 'SKILL.md')), true);
      assert.equal(fs.existsSync(path.join(repo, 'GEMINI.md')), true);

      const iv = runInterview({
        repo,
        taskId: 'CH-FLOW-J',
        request: 'Switch greeting to hello for Antigravity host',
        inputData: {
          scope: { allow: ['src/**', 'tests/**'], protect: ['README.md'] },
          acceptance: [
            { id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node tests/unit.test.mjs', expected_exit_code: 0, require_red_first: true },
            { id: 'AC-02', requirement: 'REQ-01', kind: 'e2e', command: 'node tests/e2e.test.mjs', expected_exit_code: 0 },
          ],
        },
      });
      assert.equal(iv.ok, true);
      const contractObj = JSON.parse(fs.readFileSync(iv.contract_path, 'utf8'));
      assert.equal(contractObj.host, 'antigravity');

      approveContractFile(iv.contract_path, 'agy-operator');
      const lockRes = lockApprovedSkills({ repo, host: 'antigravity' });
      assert.equal(lockRes.ok, true);
      assert.equal(verifySkillLock({ repo }).ok, true);

      initCheckpoint({ repo, contract: iv.contract_path, runId: 'RUN-J' });
      assert.equal(recordRedEvidence({ repo, runId: 'RUN-J', acId: 'AC-01' }).ok, true);

      fs.writeFileSync(path.join(repo, 'src/service.mjs'), 'export function greet(name) { return `hello ${name}`; }\n', 'utf8');
      const v = runVerify({ repo, runId: 'RUN-J' });
      assert.equal(v.ok, true);
      assert.equal(v.technical_status, 'VERIFIED');

      const pkg = publishReviewPackage({ repo, runId: 'RUN-J' });
      assert.equal(pkg.ok, true);
      assert.equal(pkg.state, 'READY_FOR_HUMAN_REVIEW');
      assert.equal(pkg.editorial_status, 'PASS');

      const acc = recordHumanDecision({
        repo,
        runId: 'RUN-J',
        decision: 'accept',
        actor: 'chang',
        rationale: 'Verified end-to-end under Antigravity host',
      });
      assert.equal(acc.state, 'ACCEPTED');
      assert.equal(verifyHumanDecision({ repo, runId: 'RUN-J' }).valid, true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('Flow K: Generic / custom host (gemini-local) init-host -> full loop -> ACCEPT', () => {
    const repo = createTempRepo({
      'README.md': '# Generic Custom Host Demo\n',
      'src/calc.mjs': 'export const double = (n) => n;\n',
      'tests/unit.test.mjs': "import assert from 'node:assert/strict'; import { double } from '../src/calc.mjs'; assert.equal(double(4), 8);\n",
      'tests/e2e.test.mjs': "import assert from 'node:assert/strict'; import { double } from '../src/calc.mjs'; assert.equal(double(5), 10);\n",
    });

    try {
      const initRes = initHost({ repo, host: 'gemini-local' });
      assert.equal(initRes.ok, true);

      const iv = runInterview({
        repo,
        taskId: 'CH-FLOW-K',
        request: 'Fix double calculation under generic custom host',
        inputData: {
          scope: { allow: ['src/**'], protect: ['README.md'] },
          acceptance: [
            { id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'node tests/unit.test.mjs', expected_exit_code: 0 },
            { id: 'AC-02', requirement: 'REQ-01', kind: 'e2e', command: 'node tests/e2e.test.mjs', expected_exit_code: 0 },
          ],
        },
      });
      assert.equal(iv.ok, true);
      const contractObj = JSON.parse(fs.readFileSync(iv.contract_path, 'utf8'));
      assert.equal(contractObj.host, 'gemini-local');

      approveContractFile(iv.contract_path, 'operator');
      const lockRes = lockApprovedSkills({ repo, host: 'gemini-local' });
      assert.equal(lockRes.ok, true);
      assert.equal(verifySkillLock({ repo }).ok, true);

      initCheckpoint({ repo, contract: iv.contract_path, runId: 'RUN-K' });
      fs.writeFileSync(path.join(repo, 'src/calc.mjs'), 'export const double = (n) => n * 2;\n', 'utf8');

      const v = runVerify({ repo, runId: 'RUN-K' });
      assert.equal(v.ok, true);
      const pkg = publishReviewPackage({ repo, runId: 'RUN-K' });
      assert.equal(pkg.ok, true);
      assert.equal(pkg.state, 'READY_FOR_HUMAN_REVIEW');

      const acc = recordHumanDecision({
        repo,
        runId: 'RUN-K',
        decision: 'accept',
        actor: 'chang',
        rationale: 'Verified end-to-end under custom host gemini-local',
      });
      assert.equal(acc.state, 'ACCEPTED');
      assert.equal(verifyHumanDecision({ repo, runId: 'RUN-K' }).valid, true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('Flow L: Selective regression verification runs impacted unit + E2E tests, skips unimpacted, and falls back on global edits', () => {
    const repo = createTempRepo({
      'package.json': '{"name":"selective-demo","type":"module"}\n',
      'README.md': '# Selective Regression Demo\n',
      'src/auth.mjs': 'export function login(ok) { return ok ? "token" : null; }\n',
      'src/billing.mjs': 'export function invoice(x) { return x * 10; }\n',
      'tests/auth.test.mjs': "import assert from 'node:assert/strict'; import { login } from '../src/auth.mjs'; assert.equal(login(true), 'token-v2');\n",
      'tests/billing.test.mjs': "import assert from 'node:assert/strict'; import { invoice } from '../src/billing.mjs'; assert.equal(invoice(2), 20);\n",
      'tests/e2e.test.mjs': "import assert from 'node:assert/strict'; import { login } from '../src/auth.mjs'; assert.equal(login(true), 'token-v2');\n",
    });

    try {
      const iv = runInterview({
        repo,
        taskId: 'CH-FLOW-L',
        request: 'Update login token version with selective regression testing',
        host: 'antigravity',
        inputData: {
          scope: { allow: ['src/**', 'package.json'], protect: ['README.md'] },
          verification_policy: { regression_mode: 'selective' },
          acceptance: [
            { id: 'AC-AUTH', requirement: 'REQ-01', kind: 'unit', command: 'node tests/auth.test.mjs' },
            { id: 'AC-BILLING', requirement: 'REQ-02', kind: 'unit', command: 'node tests/billing.test.mjs' },
            { id: 'AC-E2E', requirement: 'REQ-01', kind: 'e2e', command: 'node tests/e2e.test.mjs' },
          ],
        },
      });
      approveContractFile(iv.contract_path, 'operator');
      initCheckpoint({ repo, contract: iv.contract_path, runId: 'RUN-L' });

      // Modify only src/auth.mjs
      fs.writeFileSync(path.join(repo, 'src/auth.mjs'), 'export function login(ok) { return ok ? "token-v2" : null; }\n', 'utf8');
      const v1 = runVerify({ repo, runId: 'RUN-L', selective: true });
      assert.equal(v1.ok, true);
      assert.equal(v1.regression_selection.mode, 'selective');
      assert.equal(v1.regression_selection.executed_count, 2);
      assert.equal(v1.regression_selection.skipped_count, 1);

      const manifest1 = JSON.parse(fs.readFileSync(path.join(getRunDir(repo, 'RUN-L'), 'evidence-manifest.json'), 'utf8'));
      assert.equal(manifest1.checks.find((c) => c.id === 'AC-AUTH').status, 'PASS');
      assert.equal(manifest1.checks.find((c) => c.id === 'AC-E2E').status, 'PASS');
      assert.equal(manifest1.checks.find((c) => c.id === 'AC-BILLING').status, 'SKIPPED_UNIMPACTED');
      assert.equal(fs.existsSync(path.join(getRunDir(repo, 'RUN-L'), manifest1.impact_analysis_file)), true);

      const pkg = publishReviewPackage({ repo, runId: 'RUN-L' });
      assert.equal(pkg.ok, true);
      assert.equal(pkg.state, 'READY_FOR_HUMAN_REVIEW');

      // Global package.json change must force fallback_to_full and execute all 3 checks
      fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"selective-demo","type":"module","version":"0.2.0"}\n', 'utf8');
      const v2 = runVerify({ repo, runId: 'RUN-L', selective: true });
      assert.equal(v2.ok, true);
      assert.equal(v2.regression_selection.mode, 'fallback_to_full');
      assert.equal(v2.regression_selection.fallback_to_full, true);
      assert.equal(v2.regression_selection.executed_count, 3);
      assert.equal(v2.regression_selection.skipped_count, 0);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('Flow M: Automated feedback loop converges to READY_FOR_HUMAN_REVIEW (no auto-accept) and escalates at round 3', async () => {
    // Part 1: Fails on round 0 -> feedback packet -> onRepair fixes -> converges to READY_FOR_HUMAN_REVIEW
    const repoOk = createTempRepo({
      'README.md': '# Feedback Loop Converge\n',
      'src/math.mjs': 'export function add(a, b) { return a - b; }\n',
      'tests/math.test.mjs': "import assert from 'node:assert/strict'; import { add } from '../src/math.mjs'; assert.equal(add(2, 3), 5);\n",
      'tests/e2e.test.mjs': "import assert from 'node:assert/strict'; import { add } from '../src/math.mjs'; assert.equal(add(10, 5), 15);\n",
    });

    try {
      const iv = runInterview({
        repo: repoOk,
        taskId: 'CH-FLOW-M1',
        request: 'Fix addition bug via automated feedback loop',
        host: 'antigravity',
        inputData: {
          scope: { allow: ['src/**'], protect: ['README.md'] },
          acceptance: [
            { id: 'AC-UNIT', requirement: 'REQ-01', kind: 'unit', command: 'node tests/math.test.mjs' },
            { id: 'AC-E2E', requirement: 'REQ-01', kind: 'e2e', command: 'node tests/e2e.test.mjs' },
          ],
        },
      });
      approveContractFile(iv.contract_path, 'operator');
      initCheckpoint({ repo: repoOk, contract: iv.contract_path, runId: 'RUN-M1' });

      const seenTiers = [];
      const loopRes = await runFeedbackLoop({
        repo: repoOk,
        runId: 'RUN-M1',
        selective: true,
        capabilities: { status: 'AVAILABLE', supports_multi_model: true, supports_subagents: true, execution_mode: 'agy_cli' },
        onRepair: async (packet, routeDecision) => {
          seenTiers.push(routeDecision.tier);
          assert.equal(packet.status, 'FAIL');
          assert.ok(packet.failed_checks.length >= 1);
          fs.writeFileSync(path.join(repoOk, 'src/math.mjs'), 'export function add(a, b) { return a + b; }\n', 'utf8');
        },
      });

      assert.equal(loopRes.ok, true);
      assert.equal(loopRes.status, 'READY_FOR_HUMAN_APPROVAL');
      assert.equal(loopRes.state, 'READY_FOR_HUMAN_REVIEW');
      assert.equal(loopRes.rounds_executed, 1);
      assert.deepEqual(seenTiers, ['standard']);
      assert.equal(loopRes.approval_request.auto_approved, false);
      assert.equal(fs.existsSync(getApprovalDecisionPath(repoOk, 'RUN-M1')), false);
    } finally {
      fs.rmSync(repoOk, { recursive: true, force: true });
    }

    // Part 2: Persistent failure escalates Round 1 (standard) -> Round 2 (reasoning) -> Round 3 (BLOCKED_HUMAN_ATTENTION) & blocks Round 4
    const repoFail = createTempRepo({
      'README.md': '# Feedback Escalate\n',
      'src/app.mjs': 'export const ok = false;\n',
      'tests/unit.test.mjs': "import assert from 'node:assert/strict'; import { ok } from '../src/app.mjs'; assert.equal(ok, true);\n",
      'tests/e2e.test.mjs': "import assert from 'node:assert/strict'; import { ok } from '../src/app.mjs'; assert.equal(ok, true);\n",
    });

    try {
      const iv2 = runInterview({
        repo: repoFail,
        taskId: 'CH-FLOW-M2',
        request: 'Test feedback escalation cap',
        host: 'claude',
        inputData: {
          scope: { allow: ['src/**'], protect: ['README.md'] },
          acceptance: [
            { id: 'AC-UNIT', requirement: 'REQ-01', kind: 'unit', command: 'node tests/unit.test.mjs' },
            { id: 'AC-E2E', requirement: 'REQ-01', kind: 'e2e', command: 'node tests/e2e.test.mjs' },
          ],
        },
      });
      approveContractFile(iv2.contract_path, 'operator');
      initCheckpoint({ repo: repoFail, contract: iv2.contract_path, runId: 'RUN-M2' });

      const repairTiers = [];
      const escRes = await runFeedbackLoop({
        repo: repoFail,
        runId: 'RUN-M2',
        capabilities: { status: 'AVAILABLE', supports_multi_model: true, supports_subagents: true, execution_mode: 'native_subagent' },
        onRepair: async (_packet, routeDecision) => {
          repairTiers.push(routeDecision.tier);
        },
      });

      assert.equal(escRes.ok, false);
      assert.equal(escRes.status, 'ESCALATED_HUMAN_ATTENTION');
      assert.equal(escRes.state, 'BLOCKED_HUMAN_ATTENTION');
      assert.deepEqual(repairTiers, ['standard', 'reasoning']);
      assert.deepEqual(escRes.history.map((h) => h.recommended_tier), ['standard', 'reasoning', 'reasoning']);
      assert.equal(fs.existsSync(path.join(getRunDir(repoFail, 'RUN-M2'), 'evidence', 'escalation.json')), true);

      // Re-invoking loop after escalation must stay blocked (no 4th repair round)
      const round4 = await runFeedbackLoop({
        repo: repoFail,
        runId: 'RUN-M2',
        onRepair: async () => {
          throw new Error('Round 4 must never execute');
        },
      });
      assert.equal(round4.ok, false);
      assert.equal(round4.error_code, 'REPAIR_LIMIT_EXCEEDED');
    } finally {
      fs.rmSync(repoFail, { recursive: true, force: true });
    }
  });

  it('Flow N: Polyglot Python/Go repo with universal init-host -> selective verify -> repairCmd env hook -> READY_FOR_HUMAN_REVIEW', async () => {
    const repo = createTempRepo({
      'README.md': '# Polyglot Repo\n',
      'pyproject.toml': '[project]\nname = "poly-app"\n',
      'go.mod': 'module example.com/poly\n\ngo 1.23\n',
      'src/auth/token.py': 'def issue_token():\n    return "bad"\n',
      'src/billing/invoice.py': 'def calc():\n    return 100\n',
      'pkg/health/check.go': 'package health\nfunc Ping() string { return "pong" }\n',
      'tests/test_auth.py': 'from src.auth.token import issue_token\ndef test_issue():\n    assert issue_token() == "ok"\n',
      'tests/test_billing.py': 'from src.billing.invoice import calc\ndef test_calc():\n    assert calc() == 100\n',
      'tests/e2e/test_flow.py': 'from src.auth.token import issue_token\ndef test_e2e():\n    assert issue_token() == "ok"\n',
    });

    const helperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-flow-n-'));
    const authTestJs = path.join(helperDir, 'check_auth.mjs');
    const billingTestJs = path.join(helperDir, 'check_billing.mjs');
    const e2eTestJs = path.join(helperDir, 'check_e2e.mjs');
    const repairHookJs = path.join(helperDir, 'repair_hook.mjs');
    const repairEnvLog = path.join(helperDir, 'repair-env.json');

    try {
      const checkScript = 'import fs from "node:fs"; const txt = fs.readFileSync(process.argv[2], "utf8"); if (!txt.includes(\'"ok"\')) process.exit(1);';
      fs.writeFileSync(authTestJs, checkScript, 'utf8');
      fs.writeFileSync(billingTestJs, 'process.exit(0);', 'utf8');
      fs.writeFileSync(e2eTestJs, checkScript, 'utf8');
      fs.writeFileSync(
        repairHookJs,
        [
          'import fs from "node:fs";',
          'import path from "node:path";',
          `fs.writeFileSync(${JSON.stringify(repairEnvLog)}, JSON.stringify({`,
          '  host: process.env.CRAFTHELM_HOST,',
          '  tier: process.env.CRAFTHELM_RECOMMENDED_TIER,',
          '  impact: process.env.CRAFTHELM_IMPACT_FILE,',
          '  packet: process.env.CRAFTHELM_FEEDBACK_PACKET,',
          '}));',
          'fs.writeFileSync(path.join(process.env.CRAFTHELM_REPO, "src/auth/token.py"), "def issue_token():\\n    return \\"ok\\"\\n", "utf8");',
        ].join('\n'),
        'utf8',
      );

      const initRes = initHost({
        repo,
        host: 'opencode',
        lightweightModel: 'qwen-mini',
        standardModel: 'qwen-coder',
        reasoningModel: 'qwen-reason',
        supportsMultiModel: true,
      });
      assert.equal(initRes.ok, true);
      assert.ok(initRes.detected_languages.includes('python'));
      assert.ok(initRes.detected_languages.includes('go'));
      assert.ok(initRes.detected_test_runners.includes('pytest'));
      assert.ok(initRes.detected_test_runners.includes('go-test'));

      const iv = runInterview({
        repo,
        taskId: 'CH-FLOW-N',
        request: 'Fix Python auth token via polyglot selective loop under custom host',
        host: 'opencode',
        inputData: {
          host_config: { supports_multi_model: true, in_session: true },
          scope: { allow: ['src/**'], protect: ['README.md'] },
          verification_policy: { regression_mode: 'selective' },
          model_routing: {
            enabled: true,
            model_tiers: { lightweight: 'qwen-mini', standard: 'qwen-coder', reasoning: 'qwen-reason' },
          },
          acceptance: [
            {
              id: 'AC-PY-AUTH',
              requirement: 'REQ-01',
              kind: 'unit',
              target_files: ['tests/test_auth.py'],
              command: `node "${authTestJs.replace(/\\/g, '/')}" src/auth/token.py`,
            },
            {
              id: 'AC-PY-BILL',
              requirement: 'REQ-02',
              kind: 'unit',
              target_files: ['tests/test_billing.py'],
              command: `node "${billingTestJs.replace(/\\/g, '/')}"`,
            },
            {
              id: 'AC-E2E',
              requirement: 'REQ-01',
              kind: 'e2e',
              target_files: ['tests/e2e/test_flow.py'],
              command: `node "${e2eTestJs.replace(/\\/g, '/')}" src/auth/token.py`,
            },
          ],
        },
      });
      approveContractFile(iv.contract_path, 'operator');
      initCheckpoint({ repo, contract: iv.contract_path, runId: 'RUN-N' });

      // Edit Python auth file with broken value first so feedback loop runs 1 repair cycle
      fs.writeFileSync(path.join(repo, 'src/auth/token.py'), 'def issue_token():\n    return "still-bad"\n', 'utf8');

      const loopRes = await runFeedbackLoop({
        repo,
        runId: 'RUN-N',
        selective: true,
        repairCmd: `node "${repairHookJs.replace(/\\/g, '/')}"`,
      });

      assert.equal(loopRes.ok, true);
      assert.equal(loopRes.status, 'READY_FOR_HUMAN_APPROVAL');
      assert.equal(loopRes.state, 'READY_FOR_HUMAN_REVIEW');
      assert.equal(loopRes.rounds_executed, 1);
      assert.equal(loopRes.verify_result.regression_selection.mode, 'selective');
      assert.equal(loopRes.verify_result.regression_selection.executed_count, 2);
      assert.equal(loopRes.verify_result.regression_selection.skipped_count, 1);
      assert.equal(fs.existsSync(getApprovalDecisionPath(repo, 'RUN-N')), false);
      assert.match(loopRes.approval_request.approval_command, /scripts\/approval\.mjs/);

      const capturedEnv = JSON.parse(fs.readFileSync(repairEnvLog, 'utf8'));
      assert.equal(capturedEnv.host, 'opencode');
      assert.equal(capturedEnv.tier, 'standard');
      assert.equal(fs.existsSync(capturedEnv.impact), true);
      assert.equal(fs.existsSync(capturedEnv.packet), true);
    } finally {
      fs.rmSync(helperDir, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
