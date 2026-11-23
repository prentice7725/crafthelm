import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runEditorialCheck, verifyKouetsuAsset } from '../../scripts/lib/kouetsu-check.mjs';

function makeValidEightSectionReport(extraBody = '') {
  return [
    '# CraftHelm — 사람의 인수 검토 보고서 v0.3',
    '',
    '> **상태: 검토 대기 (READY_FOR_HUMAN_REVIEW)**',
    '',
    '## 1. 지금 결정해야 할 것',
    '| 자동 검증 상태 | **VERIFIED** |',
    '',
    '## 2. 변경 내용',
    '개발자가 `src/app.mjs`를 수정했습니다.',
    extraBody,
    '',
    '## 3. 요구사항과 검증 결과',
    '| `AC-01` | 로그인 동작 | unit | PASS | `../evidence/tests/AC-01.stdout.txt` | 로그 확인 |',
    '',
    '## 4. 직접 확인할 시나리오',
    '1. 테스트 명령 실행 후 종료 코드 0을 확인합니다.',
    '',
    '## 5. 실행 검증의 범위와 한계',
    '단위 테스트와 E2E smoke를 실행했습니다.',
    '',
    '## 6. 위험 및 미해결 사항',
    '중대 위험 없음.',
    '',
    '## 7. 근거 자료',
    '근거 파일을 연결했습니다.',
    '',
    '## 8. 검토자의 결정',
    '현재 상태: **미승인 (PENDING)**',
    '',
  ].join('\n');
}

describe('Kouetsu Editorial Gate & Cross-Host Parity (H06 / H07 / E13)', () => {
  it('verifies identical reference pattern digests across Claude, Codex, Universal, and Antigravity Kouetsu packages (H06)', () => {
    const codexAsset = verifyKouetsuAsset('codex');
    assert.equal(codexAsset.found, true);
    assert.equal(codexAsset.status, 'VERIFIED');

    const agyAsset = verifyKouetsuAsset('antigravity');
    assert.equal(agyAsset.found, true);
    assert.equal(agyAsset.status, 'VERIFIED');
    assert.equal(agyAsset.referencesDigest, codexAsset.referencesDigest);

    const genericAsset = verifyKouetsuAsset('generic');
    assert.equal(genericAsset.found, true);
    assert.equal(genericAsset.status, 'VERIFIED');
    assert.equal(genericAsset.referencesDigest, codexAsset.referencesDigest);

    const claudePluginExists = fs.existsSync(
      path.join(os.homedir(), '.claude', 'plugins', 'cache', 'prentice7725', 'kouetsu', '1.0.2', 'skills', 'kouetsu', 'SKILL.md'),
    );
    if (claudePluginExists) {
      const claudeAsset = verifyKouetsuAsset('claude');
      assert.equal(claudeAsset.found, true);
      assert.equal(claudeAsset.status, 'VERIFIED');
      assert.equal(claudeAsset.referencesDigest, codexAsset.referencesDigest);
    }
  });

  it('passes clean 8-section document and allows <=2 surface pattern hits', () => {
    const md = makeValidEightSectionReport('다양한 옵션 중 2건을 유지했고 효과적인 결과를 확인했습니다.');
    const report = runEditorialCheck(md, {
      runId: 'RUN-K1',
      host: 'codex',
      language: 'ko',
      kouetsuAsset: verifyKouetsuAsset('codex'),
      manifest: { technical_status: 'VERIFIED' },
    });
    assert.equal(report.status, 'PASS');
  });

  it('flags surface pattern when repeated >2 times (3+ hits)', () => {
    const md = makeValidEightSectionReport(
      '다양한 테스트를 통해 다양한 경로에서 다양한 입력을 검증했습니다.',
    );
    const report = runEditorialCheck(md, {
      runId: 'RUN-K2',
      host: 'codex',
      language: 'ko',
      kouetsuAsset: verifyKouetsuAsset('codex'),
      manifest: { technical_status: 'VERIFIED' },
    });
    assert.equal(report.status, 'FAIL');
    assert.equal(report.layers.surface, 'FAIL');
    assert.ok(report.findings.some((f) => f.tag === 'pattern:ko_empty_modifiers' && f.count === 3));
  });

  it('flags [inconsistent], [buried], and Critical [확인 필요] markers (H07 / E13)', () => {
    const inconsistentMd = makeValidEightSectionReport('이 변경은 모든 검사가 문제없이 완벽합니다.');
    const res1 = runEditorialCheck(inconsistentMd, {
      runId: 'RUN-K3',
      host: 'codex',
      language: 'ko',
      kouetsuAsset: verifyKouetsuAsset('codex'),
      manifest: { technical_status: 'FAILED' },
    });
    assert.equal(res1.status, 'FAIL');
    assert.ok(res1.findings.some((f) => f.tag === 'inconsistent'));
    assert.ok(res1.findings.some((f) => f.tag === 'buried'));

    const criticalMd = makeValidEightSectionReport('').replace(
      '| 자동 검증 상태 | **VERIFIED** |',
      '| 자동 검증 상태 | **VERIFIED** [확인 필요: 운영 배포 허용 여부] |',
    );
    const res2 = runEditorialCheck(criticalMd, {
      runId: 'RUN-K4',
      host: 'codex',
      language: 'ko',
      kouetsuAsset: verifyKouetsuAsset('codex'),
      manifest: { technical_status: 'VERIFIED' },
    });
    assert.equal(res2.status, 'BLOCKED');
    assert.equal(res2.critical_confirmations.length, 1);
  });
});
