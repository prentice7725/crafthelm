import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { initCheckpoint, recordRepairRound, resumeRun } from '../../scripts/checkpoint.mjs';
import { approveContractFile } from '../../scripts/contract.mjs';
import { runInterview } from '../../scripts/interview.mjs';
import { computeSnapshotDigest, runGit } from '../../scripts/lib/git.mjs';
import {
  listDecisions,
  parseDecisionMarkdown,
  rebuildMemoryIndex,
  recordDecision,
  searchMemory,
} from '../../scripts/lib/memory.mjs';
import { getHandoffPacketPath, getMemoryIndexPath, getRunDir } from '../../scripts/lib/paths.mjs';
import { validateAgainstSchema } from '../../scripts/lib/schema.mjs';
import { runVerify } from '../../scripts/verify.mjs';

function createTempRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-mem-'));
  runGit(dir, ['init', '-b', 'main']);
  runGit(dir, ['config', 'user.name', 'CraftHelm Memory']);
  runGit(dir, ['config', 'user.email', 'memory@crafthelm.local']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'Baseline']);
  return dir;
}

describe('Markdown SOT Memory (FTS5 + Supersession + Decay) & Handoff Packets', () => {
  it('supports decision supersession, zero-LLM SQLite FTS5 rebuild without snapshot mutation, and bilingual queries', () => {
    const repo = createTempRepo({
      'README.md': '# Memory Demo\n',
      'src/auth.mjs': 'export const ok = true;\n',
    });

    try {
      const d1 = recordDecision({
        repo,
        id: 'DEC-001',
        title: 'HS256 세션 토큰 서명',
        body: '초기 인증 토큰 서명 방식으로 HS256 공유 시크릿을 사용합니다.',
        tags: ['auth', 'jwt'],
      });
      assert.equal(d1.ok, true);
      assert.equal(d1.status, 'active');

      const d2 = recordDecision({
        repo,
        id: 'DEC-002',
        title: 'RS256 로테이션 토큰 전환',
        body: 'JWT 인증 토큰 서명을 비대칭 RS256 및 refresh rotation 방식으로 교체합니다.',
        supersedes: 'DEC-001',
        tags: ['auth', 'jwt', 'security'],
      });
      assert.equal(d2.ok, true);
      assert.equal(d2.supersedes, 'DEC-001');

      // Historical file is preserved with status=superseded & superseded_by=DEC-002
      const oldMd = fs.readFileSync(path.join(repo, '.crafthelm', 'memory', 'decisions', 'DEC-001.md'), 'utf8');
      const parsedOld = parseDecisionMarkdown(oldMd);
      assert.equal(parsedOld.meta.status, 'superseded');
      assert.equal(parsedOld.meta.superseded_by, 'DEC-002');
      assert.match(parsedOld.body, /HS256/);

      assert.deepEqual(listDecisions({ repo }).map((d) => d.id), ['DEC-002']);
      assert.deepEqual(listDecisions({ repo, includeSuperseded: true }).map((d) => d.id), ['DEC-001', 'DEC-002']);

      // Snapshot digest must stay completely unaffected by rebuilding/deleting index.sqlite cache
      const digestWithIndex = computeSnapshotDigest(repo);
      const indexPath = getMemoryIndexPath(repo);
      assert.equal(fs.existsSync(indexPath), true);
      fs.unlinkSync(indexPath);
      const digestWithoutIndex = computeSnapshotDigest(repo);
      assert.equal(digestWithoutIndex, digestWithIndex);

      // Searching after index deletion automatically rebuilds from Markdown SOT and returns active decision
      const searchRes = searchMemory({ repo, query: '토큰 rotation: auth/jwt.mjs!' });
      assert.equal(fs.existsSync(indexPath), true);
      assert.equal(computeSnapshotDigest(repo), digestWithIndex);
      assert.deepEqual(searchRes.hits.map((h) => h.id), ['DEC-002']);

      // includeSuperseded surfaces DEC-001 below DEC-002 with superseded_by link
      const allHits = searchMemory({ repo, query: '인증 토큰 서명', includeSuperseded: true });
      assert.equal(allHits.hits[0].id, 'DEC-002');
      const oldHit = allHits.hits.find((h) => h.id === 'DEC-001');
      assert.ok(oldHit);
      assert.equal(oldHit.status, 'superseded');
      assert.equal(oldHit.superseded_by, 'DEC-002');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('applies exponential time decay to older episodic failure logs', () => {
    const repo = createTempRepo({
      'README.md': '# Decay Demo\n',
    });

    try {
      const nowMs = Date.parse('2026-11-21T12:00:00Z');
      const oldIso = new Date(nowMs - 120 * 24 * 60 * 60 * 1000).toISOString();
      const recentIso = new Date(nowMs - 1 * 24 * 60 * 60 * 1000).toISOString();

      const oldDir = path.join(getRunDir(repo, 'RUN-OLD'), 'evidence');
      const newDir = path.join(getRunDir(repo, 'RUN-NEW'), 'evidence');
      fs.mkdirSync(oldDir, { recursive: true });
      fs.mkdirSync(newDir, { recursive: true });

      fs.writeFileSync(
        path.join(oldDir, 'repair-TEST_FAILURE.jsonl'),
        `${JSON.stringify({
          round: 1,
          cause_id: 'TEST_FAILURE',
          check_id: 'AC-01',
          repro_command: 'node test.mjs',
          note: 'Legacy jwt mismatch occurred during old migration',
          recorded_at: oldIso,
        })}\n`,
        'utf8',
      );
      fs.writeFileSync(
        path.join(newDir, 'repair-TEST_FAILURE.jsonl'),
        `${JSON.stringify({
          round: 1,
          cause_id: 'TEST_FAILURE',
          check_id: 'AC-02',
          repro_command: 'node test.mjs',
          note: 'Recent jwt mismatch after clock skew adjustment',
          recorded_at: recentIso,
        })}\n`,
        'utf8',
      );

      const idx = rebuildMemoryIndex({ repo });
      assert.equal(idx.counts_by_kind.failed_approach, 2);

      const res = searchMemory({ repo, query: 'jwt mismatch', halfLifeDays: 30, now: nowMs });
      assert.equal(res.hits.length, 2);
      assert.match(res.hits[0].id, /^RUN-NEW:/);
      assert.equal(res.hits[0].decayed, false);
      assert.match(res.hits[1].id, /^RUN-OLD:/);
      assert.equal(res.hits[1].decayed, true);
      assert.equal(res.hits[1].status, 'decayed');
      assert.ok(res.hits[0].score > res.hits[1].score);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('populates tried_and_failed & prior_memory_hits on verify failure and emits handoff-packet on resume', () => {
    const repo = createTempRepo({
      'README.md': '# Handoff Demo\n',
      'src/auth.mjs': 'export function check() { return false; }\n',
      'tests/unit.test.mjs': "import assert from 'node:assert/strict'; import { check } from '../src/auth.mjs'; assert.equal(check(), true);\n",
      'tests/e2e.test.mjs': "import assert from 'node:assert/strict'; import { check } from '../src/auth.mjs'; assert.equal(check(), true);\n",
    });

    try {
      recordDecision({
        repo,
        id: 'DEC-001',
        title: 'Validate check() strict boolean return',
        body: 'TEST_FAILURE on auth check requires strict boolean true from src/auth.mjs.',
        tags: ['auth', 'TEST_FAILURE'],
      });

      const iv = runInterview({
        repo,
        taskId: 'CH-HANDOFF-1',
        request: 'Fix strict boolean auth check failure',
        host: 'generic',
        inputData: {
          scope: { allow: ['src/**'], protect: ['README.md'] },
          uncertainties: [{ id: 'Q-TTL', level: 'DEFERRED', question: 'Keep 15m TTL or extend to 30m?', owner: 'security' }],
          acceptance: [
            { id: 'AC-UNIT', requirement: 'REQ-01', kind: 'unit', command: 'node tests/unit.test.mjs' },
            { id: 'AC-E2E', requirement: 'REQ-01', kind: 'e2e', command: 'node tests/e2e.test.mjs' },
          ],
        },
      });
      assert.equal(iv.ok, true);
      assert.ok(iv.sot_sources.includes('.crafthelm/memory/decisions/DEC-001.md'));
      assert.ok(iv.prior_memory_hits.some((h) => h.id === 'DEC-001'));

      approveContractFile(iv.contract_path, 'operator');
      initCheckpoint({ repo, contract: iv.contract_path, runId: 'RUN-HO' });

      // Simulate 2 failed repair attempts before verification re-run & cross-agent resume
      recordRepairRound({
        repo,
        runId: 'RUN-HO',
        cause: 'TEST_FAILURE',
        check: 'AC-UNIT',
        command: 'node tests/unit.test.mjs',
        note: 'Attempt 1 swapped export name - still failed',
      });
      recordRepairRound({
        repo,
        runId: 'RUN-HO',
        cause: 'TEST_FAILURE',
        check: 'AC-UNIT',
        command: 'node tests/unit.test.mjs',
        note: 'Attempt 2 returned truthy string instead of boolean - still failed',
      });

      const v = runVerify({ repo, runId: 'RUN-HO' });
      assert.equal(v.ok, false);

      const feedback = JSON.parse(fs.readFileSync(path.join(getRunDir(repo, 'RUN-HO'), 'evidence', 'feedback-packet.json'), 'utf8'));
      assert.equal(validateAgainstSchema('feedback-packet', feedback).valid, true);
      assert.equal(feedback.tried_and_failed.length, 2);
      assert.equal(feedback.tried_and_failed[0].round, 1);
      assert.match(feedback.tried_and_failed[1].note, /truthy string/);
      assert.ok(feedback.prior_memory_hits.some((h) => h.id === 'DEC-001'));

      const resumed = resumeRun({ repo, runId: 'RUN-HO' });
      assert.equal(resumed.ok, true);
      assert.equal(resumed.handoff_packet_file, 'evidence/handoff-packet.json');
      assert.equal(resumed.handoff_summary.tried_and_failed_count, 2);
      assert.equal(resumed.handoff_summary.open_questions_count, 1);
      assert.equal(resumed.handoff_summary.active_decisions_count, 1);

      const handoff = JSON.parse(fs.readFileSync(getHandoffPacketPath(repo, 'RUN-HO'), 'utf8'));
      assert.equal(validateAgainstSchema('handoff-packet', handoff).valid, true);
      assert.equal(handoff.tried_and_failed.length, 2);
      assert.ok(handoff.open_questions.some((q) => q.includes('15m TTL')));
      assert.deepEqual(handoff.active_decisions.map((d) => d.id), ['DEC-001']);
      assert.ok(handoff.related_memory_hits.some((h) => h.id === 'DEC-001'));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
