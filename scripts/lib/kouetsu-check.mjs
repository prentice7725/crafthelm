import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashFileSet, sha256Text } from './crypto.mjs';
import { CRAFTHELM_ROOT } from './paths.mjs';

const SKILL_CORE_FILES = [
  'SKILL.md',
  'references/ko.md',
  'references/ja.md',
  'references/en.md',
];

const REFERENCE_FILES = [
  'references/ko.md',
  'references/ja.md',
  'references/en.md',
];

const CLAUDE_SKILL_SUBPATH = 'skills/kouetsu';

function hashNormalizedFileSet(baseDir, relPaths) {
  const sorted = [...new Set(relPaths)].sort();
  const lines = [];
  for (const rel of sorted) {
    const text = fs.readFileSync(path.join(baseDir, rel), 'utf8').replace(/\r\n/g, '\n');
    lines.push(`${rel}:${sha256Text(text)}\n`);
  }
  return sha256Text(lines.join(''));
}

/**
 * Locate and verify Kouetsu 1.0.2 assets strictly for the active host (`claude` or `codex`).
 * Never modifies upstream plugin directories.
 * @param {'claude'|'codex'} host
 * @param {{ kouetsuRoot?: string, homeDir?: string, registryPath?: string }} [options]
 */
export function verifyKouetsuAsset(host, options = {}) {
  const registryPath = options.registryPath ?? path.join(CRAFTHELM_ROOT, 'external-skills', 'registry.json');
  const registry = fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, 'utf8')) : { entries: [] };
  const kouetsuEntry = (registry.entries ?? []).find((e) => e.id === 'kouetsu');

  const rawHost = String(host ?? 'generic').trim().toLowerCase();
  const normHost = rawHost === 'agy' ? 'antigravity' : rawHost;
  const homeDir = options.homeDir ?? os.homedir();
  const candidates = [];

  if (options.kouetsuRoot) {
    candidates.push(options.kouetsuRoot);
  } else if (normHost === 'claude') {
    candidates.push(
      path.join(homeDir, '.claude', 'plugins', 'cache', 'prentice7725', 'kouetsu', '1.0.2'),
      path.join(homeDir, '.claude', 'plugins', 'marketplaces', 'prentice7725'),
      path.join(homeDir, '.claude', 'skills', 'kouetsu'),
    );
  } else if (normHost === 'codex') {
    candidates.push(
      path.join(CRAFTHELM_ROOT, 'hosts', 'codex', 'skills', 'kouetsu'),
      path.join(homeDir, '.codex', 'skills', 'kouetsu'),
    );
  } else if (normHost === 'antigravity') {
    candidates.push(
      path.join(homeDir, '.gemini', 'config', 'skills', 'kouetsu'),
      ...(options.repoRoot ? [path.join(path.resolve(options.repoRoot), '.agents', 'skills', 'kouetsu')] : []),
      path.join(CRAFTHELM_ROOT, '.agents', 'skills', 'kouetsu'),
      path.join(CRAFTHELM_ROOT, 'hosts', 'universal', 'skills', 'kouetsu'),
    );
  } else {
    candidates.push(
      ...(options.repoRoot ? [path.join(path.resolve(options.repoRoot), '.agents', 'skills', 'kouetsu')] : []),
      path.join(CRAFTHELM_ROOT, 'hosts', 'universal', 'skills', 'kouetsu'),
    );
  }

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const skillBase = fs.existsSync(path.join(candidate, CLAUDE_SKILL_SUBPATH, 'SKILL.md'))
      ? path.join(candidate, CLAUDE_SKILL_SUBPATH)
      : candidate;
    const licensePath = fs.existsSync(path.join(skillBase, 'LICENSE'))
      ? path.join(skillBase, 'LICENSE')
      : fs.existsSync(path.join(candidate, 'LICENSE'))
        ? path.join(candidate, 'LICENSE')
        : null;

    const hasAll = Boolean(licensePath) && SKILL_CORE_FILES.every((rel) => fs.existsSync(path.join(skillBase, rel)));
    if (!hasAll) continue;

    const filesToHash = [...SKILL_CORE_FILES];
    if (fs.existsSync(path.join(skillBase, 'LICENSE'))) {
      filesToHash.push('LICENSE');
    }
    const { filesDigest, fileHashes } = hashFileSet(skillBase, filesToHash);
    const normalizedDigest = hashNormalizedFileSet(skillBase, SKILL_CORE_FILES);
    const referencesDigest = hashNormalizedFileSet(skillBase, REFERENCE_FILES);

    const hostDigests = kouetsuEntry?.host_digests ?? {};
    const expectedNormalizedDigest = normHost === 'claude'
      ? hostDigests.claude?.normalized_skill_digest
      : normHost === 'codex'
        ? hostDigests.codex?.normalized_skill_digest
        : hostDigests.universal?.normalized_skill_digest;
    const allPinnedDigests = new Set(
      Object.values(hostDigests)
        .map((d) => d?.normalized_skill_digest)
        .filter(Boolean),
    );
    const expectedRefDigest = kouetsuEntry?.references_digest;

    const digestMismatch = options.kouetsuRoot
      ? (allPinnedDigests.size > 0 && !allPinnedDigests.has(normalizedDigest))
      : (expectedNormalizedDigest && expectedNormalizedDigest !== normalizedDigest);

    const tampered = Boolean(digestMismatch || (expectedRefDigest && expectedRefDigest !== referencesDigest));

    return {
      found: true,
      status: tampered ? 'TAMPERED' : 'VERIFIED',
      host: normHost,
      path: skillBase,
      licensePath,
      version: kouetsuEntry?.commit_or_release ?? '1.0.2',
      filesDigest,
      normalizedDigest,
      referencesDigest,
      fileHashes,
    };
  }

  return {
    found: false,
    status: 'MISSING',
    host: normHost,
    path: null,
    licensePath: null,
    version: kouetsuEntry?.commit_or_release ?? '1.0.2',
    filesDigest: null,
    normalizedDigest: null,
    referencesDigest: null,
    fileHashes: {},
  };
}

const REQUIRED_SECTION_PATTERNS = [
  { id: 'sec1', label: '1. 지금 결정해야 할 것', regex: /^##\s*1\.\s+/m },
  { id: 'sec2', label: '2. 변경 내용', regex: /^##\s*2\.\s+/m },
  { id: 'sec3', label: '3. 요구사항과 검증 결과', regex: /^##\s*3\.\s+/m },
  { id: 'sec4', label: '4. 직접 확인할 시나리오', regex: /^##\s*4\.\s+/m },
  { id: 'sec5', label: '5. 실행 검증의 범위와 한계', regex: /^##\s*5\.\s+/m },
  { id: 'sec6', label: '6. 위험 및 미해결 사항', regex: /^##\s*6\.\s+/m },
  { id: 'sec7', label: '7. 근거 자료', regex: /^##\s*7\.\s+/m },
  { id: 'sec8', label: '8. 검토자의 결정', regex: /^##\s*8\.\s+/m },
];

const SURFACE_PATTERNS = {
  ko: [
    { name: 'ko_nominalization', regex: /(?:에 대한\s+\S+의\s+(?:수행|진행)|을\s*통해\s+\S+가\s+이루어|함으로써|분석을\s+진행했|검증을\s+진행했)/g },
    { name: 'ko_can_do', regex: /할\s+수\s+있습니다/g },
    { name: 'ko_hedged_ending', regex: /(?:라고\s+할\s+수\s+있습니다|것으로\s+보입니다|일\s+수도\s+있습니다)/g },
    { name: 'ko_empty_modifiers', regex: /(?:다양한|효과적인|체계적인|혁신적인|핵심적인)/g },
    { name: 'ko_signposting', regex: /(?:에\s+대해\s+살펴보겠습니다|정리하면\s+다음과\s+같습니다|결론적으로)/g },
    { name: 'ko_negative_parallelism', regex: /(?:단순한\s+[^.\n]+가\s+아니라|을\s*넘어\s+[^.\n]+로)/g },
    { name: 'ko_particle_chains', regex: /[가-힣A-Za-z0-9]+의\s+[가-힣A-Za-z0-9]+의\s+[가-힣A-Za-z0-9]+/g },
  ],
  en: [
    { name: 'en_nominalization', regex: /\b(?:perform an analysis of|implementation of .+ was carried out)\b/gi },
    { name: 'en_negative_parallelism', regex: /\b(?:it'?s not .+?, it'?s|not just .+? but)\b/gi },
    { name: 'en_significance', regex: /\b(?:plays a crucial role|a testament to|marks a pivotal moment|game-changer)\b/gi },
    { name: 'en_signposting', regex: /\b(?:let'?s dive in|here'?s the thing|it'?s worth noting that|in conclusion)\b/gi },
    { name: 'en_stock_words', regex: /\b(?:delve|landscape|robust|seamless|leverage)\b/gi },
  ],
  ja: [
    { name: 'ja_nominalization', regex: /(?:の実施を行いました|における[^。\n]+の[^。\n]+)/g },
    { name: 'ja_hedged_ending', regex: /(?:と言えるでしょう|と考えられます|かもしれません)/g },
    { name: 'ja_empty_modifiers', regex: /(?:さまざまな|多岐にわたる|効果的な|重要な役割を果たす)/g },
    { name: 'ja_signposting', regex: /(?:について見ていきましょう|まとめると|結論として|いかがでしたか)/g },
    { name: 'ja_negative_parallelism', regex: /(?:単なる[^。\n]+ではなく|だけでなく[^。\n]+も)/g },
  ],
};

/**
 * Run deterministic Kouetsu 3-layer editorial diagnostics (Content -> Clarity -> Surface)
 * on a Human Review Package Markdown document.
 * @param {string} markdownText
 * @param {{ runId?: string, host?: 'claude'|'codex', language?: 'ko'|'ja'|'en', kouetsuAsset?: object, manifest?: object, separateReaderResult?: object }} [options]
 */
export function runEditorialCheck(markdownText, options = {}) {
  const text = String(markdownText ?? '').replace(/\r\n/g, '\n');
  const language = options.language ?? 'ko';
  const host = options.host ?? 'claude';
  const asset = options.kouetsuAsset ?? verifyKouetsuAsset(host);

  const findings = [];
  const confirmationMarkers = [];
  const criticalConfirmations = [];

  // Layer 1: Content
  for (const sec of REQUIRED_SECTION_PATTERNS) {
    if (!sec.regex.test(text)) {
      findings.push({
        layer: 'content',
        tag: 'missing_section',
        severity: 'error',
        message: `Required section missing: ${sec.label}`,
      });
    }
  }

  const unreplacedMatches = text.match(/\{\{[^}]+\}\}/g) ?? [];
  if (unreplacedMatches.length > 0) {
    findings.push({
      layer: 'content',
      tag: 'unreplaced_placeholder',
      severity: 'error',
      message: `Unreplaced template placeholders remain: ${unreplacedMatches.slice(0, 5).join(', ')}`,
    });
  }

  if (/AI가\s*(?:최종\s*)?(?:검증했다|완료했다|승인했다)/.test(text)) {
    findings.push({
      layer: 'content',
      tag: 'prohibited_claim',
      severity: 'error',
      message: 'Prohibited phrasing claims AI verified/completed/approved final acceptance',
    });
  }

  // Extract [확인 필요] and [needs confirmation] markers (H07)
  const markerLines = text.split('\n');
  let currentSection = 'header';
  for (const line of markerLines) {
    const hMatch = line.match(/^##\s*(.+)$/);
    if (hMatch) currentSection = hMatch[1].trim();
    const mMatches = line.match(/\[(?:확인\s*필요|needs\s*confirmation)[^\]]*\]/gi) ?? [];
    for (const marker of mMatches) {
      const isCritical =
        /critical|치명|차단|blocker|승인\s*대상|결정|보안/i.test(line) ||
        currentSection.startsWith('1.') ||
        currentSection.startsWith('6.') ||
        currentSection.startsWith('8.');
      confirmationMarkers.push({ marker, section: currentSection, critical: isCritical });
      if (isCritical) {
        criticalConfirmations.push(`${currentSection}: ${marker}`);
        findings.push({
          layer: 'content',
          tag: 'critical_confirmation_needed',
          severity: 'critical',
          sentence: line.trim(),
          message: `Critical confirmation marker blocks acceptance submission: ${marker}`,
        });
      }
    }
  }

  // Consistency check across sections (Section 1 vs Section 3 vs Section 8 vs manifest)
  if (options.manifest) {
    const mStatus = options.manifest.technical_status;
    if (mStatus === 'FAILED' && /\*\*VERIFIED\*\*/.test(text)) {
      findings.push({
        layer: 'content',
        tag: 'inconsistent',
        severity: 'error',
        message: `[inconsistent] Report states VERIFIED while Evidence Manifest technical_status is ${mStatus}`,
      });
    }
    if (mStatus === 'VERIFIED' && /\*\*FAILED\*\*/.test(text)) {
      findings.push({
        layer: 'content',
        tag: 'inconsistent',
        severity: 'error',
        message: `[inconsistent] Report states FAILED while Evidence Manifest technical_status is ${mStatus}`,
      });
    }
  }
  if (/^>\s*\*\*상태:\s*승인됨|현재 상태:\s*\*\*승인됨|\*\*ACCEPTED\*\*/m.test(text)) {
    findings.push({
      layer: 'content',
      tag: 'inconsistent',
      severity: 'error',
      message: '[inconsistent] Pre-decision review package must remain PENDING until explicit human approval',
    });
  }

  // Layer 2: Clarity
  const sentences = text
    .split('\n')
    .filter((l) => !l.startsWith('#') && !l.startsWith('|---') && l.trim().length > 0);

  for (const line of sentences) {
    if (/(?:수행되었다|진행되었다|처리되었다|was performed|was executed|it was decided)/.test(line)) {
      findings.push({
        layer: 'clarity',
        tag: 'actor',
        severity: 'warning',
        sentence: line.trim(),
        message: '[actor] Passive/nominalized action without clear actor',
      });
    }
    if (/(?:위의 방식|이것을 통해|approach [AB]|the new pipeline)\b/i.test(line)) {
      findings.push({
        layer: 'clarity',
        tag: 'vague',
        severity: 'warning',
        sentence: line.trim(),
        message: '[vague] Unclear pronoun or internal label without explicit referent',
      });
    }
    if (/(?:모든\s*검사가\s*문제없이\s*완벽|100%\s*완벽|everything succeeded seamlessly)/i.test(line)) {
      findings.push({
        layer: 'clarity',
        tag: 'buried',
        severity: 'error',
        sentence: line.trim(),
        message: '[buried] Sweeping positive claim risks hiding failures or unverified items',
      });
    }
  }

  // Layer 3: Surface (flag patterns appearing > 2 times, i.e., 3+)
  const langPatterns = SURFACE_PATTERNS[language] ?? SURFACE_PATTERNS.ko;
  for (const pat of langPatterns) {
    const matches = text.match(pat.regex) ?? [];
    if (matches.length > 2) {
      findings.push({
        layer: 'surface',
        tag: `pattern:${pat.name}`,
        severity: 'error',
        pattern: pat.name,
        count: matches.length,
        message: `[pattern:${pat.name}] Appears ${matches.length} times (>2 threshold); rewrite from root cause`,
      });
    }
  }

  const contentFailed = findings.some((f) => f.layer === 'content' && (f.severity === 'error' || f.severity === 'critical'));
  const clarityFailed = findings.some((f) => f.layer === 'clarity' && f.severity === 'error');
  const surfaceFailed = findings.some((f) => f.layer === 'surface' && f.severity === 'error');

  let status = 'PASS';
  if (criticalConfirmations.length > 0) {
    status = 'BLOCKED';
  } else if (contentFailed || clarityFailed || surfaceFailed) {
    status = 'FAIL';
  }

  const sepReview = options.separateReaderResult?.status === 'EXECUTED'
    ? 'EXECUTED'
    : options.separateReaderResult?.status === 'UNAVAILABLE'
      ? 'UNAVAILABLE'
      : 'NOT_RUN_DETERMINISTIC_ONLY';

  return {
    schema_version: '0.3',
    run_id: options.runId ?? 'unknown',
    host,
    kouetsu_skill_id: 'kouetsu',
    kouetsu_version: asset.version,
    kouetsu_digest: asset.filesDigest,
    executed: asset.found && asset.status !== 'TAMPERED',
    status: !asset.found ? 'MISSING' : asset.status === 'TAMPERED' ? 'BLOCKED' : status,
    language,
    separate_reader_review: sepReview,
    layers: {
      content: contentFailed || criticalConfirmations.length > 0 ? 'FAIL' : 'PASS',
      clarity: clarityFailed ? 'FAIL' : 'PASS',
      surface: surfaceFailed ? 'FAIL' : 'PASS',
    },
    findings,
    confirmation_markers: confirmationMarkers,
    critical_confirmations: criticalConfirmations,
    checked_at: new Date().toISOString(),
  };
}
