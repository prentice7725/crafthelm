import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_IGNORED_DIRS, DEFAULT_TEST_PATTERNS_UNIVERSAL } from './impact-languages.mjs';
import { matchesAnyGlob, toPosixPath } from './paths.mjs';
import { detectRepoTestRunners } from './test-runners.mjs';

/**
 * Deterministic interview question generation.
 *
 * The interview used to classify only the uncertainties it was handed, so the quality of the intake
 * depended entirely on what the model thought to ask. This module derives questions from repository
 * signals and the request text (zero LLM calls), and tracks which uncertainty categories were looked at,
 * so an area nobody examined is visible instead of silently absent.
 */

export const COVERAGE_CATEGORIES = Object.freeze(['scope', 'acceptance', 'data', 'security', 'compatibility']);

const DEFAULT_SCOPE_ALLOW = ['src/**', 'tests/**'];

// Multilingual request heuristics. Matching a pattern raises a question; it never resolves one.
const RISK_PATTERNS = {
  data: /\b(delete|drop|truncate|purge|migrat\w*|backfill|schema change|data loss)\b|삭제|마이그레이션|이관|스키마 변경|데이터 손실|削除|移行/i,
  security: /\b(auth\w*|login|password|token|secret|credential|permission|encrypt\w*|oauth|session|api key)\b|인증|인가|로그인|비밀번호|토큰|권한|암호화|認証|権限/i,
  compatibility: /\b(api|endpoint|public interface|breaking|deprecat\w*|rename|remove|upgrade|version|protocol|schema)\b|호환|공개 인터페이스|엔드포인트|이름 변경|제거|업그레이드|버전|互換/i,
};

const RISK_QUESTIONS = {
  data: {
    question: '이 변경이 기존 데이터를 지우거나 형태를 바꿉니까? 그렇다면 되돌리는 방법과 백업 여부는 무엇입니까?',
    why: '요청 문구가 데이터 삭제·이관·스키마 변경을 가리킵니다. 데이터 손실 가능성은 정책상 BLOCKER입니다.',
  },
  security: {
    question: '인증·권한·비밀값 처리에서 반드시 유지해야 할 동작과 바뀌면 안 되는 동작은 무엇입니까?',
    why: '요청 문구가 인증·권한·비밀값을 가리킵니다. 보안 결정은 정책상 BLOCKER입니다.',
  },
  compatibility: {
    question: '이 변경으로 기존 호출자나 저장된 데이터, 공개 인터페이스가 깨질 수 있습니까? 깨져도 되는 범위는 어디까지입니까?',
    why: '요청 문구가 공개 인터페이스·버전·이름 변경을 가리킵니다.',
  },
};

function collectRepoFiles(repoRoot) {
  const results = [];
  const walk = (dir, prefix) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) results.push(toPosixPath(rel));
    }
  };
  walk(repoRoot, '');
  return results;
}

function isAnswered(entry) {
  return Boolean(entry && (entry.resolved || entry.answer || entry.resolution));
}

/**
 * Generate interview questions and a coverage map for one request.
 * @param {{
 *   repoRoot: string,
 *   requestText: string,
 *   changeKind?: string,
 *   input?: object,
 *   relatedDecisions?: Array<{ id: string, title: string, source_path: string }>,
 * }} params
 * @returns {{
 *   questions: Array<{ id: string, category: string, level: 'BLOCKER'|'ASSUMABLE', question: string, why: string, resolve_with: string, answered: boolean }>,
 *   coverage: Record<string, { status: 'addressed'|'unaddressed', basis: string }>,
 *   signals: { test_runners: string[], test_file_count: number, default_scope_matches: number },
 * }}
 */
export function generateInterviewQuestions(params) {
  const input = params.input ?? {};
  const requestText = String(params.requestText ?? '');
  const changeKind = params.changeKind ?? input.change_kind ?? 'feature';
  const repoFiles = collectRepoFiles(params.repoRoot);
  const runners = detectRepoTestRunners(params.repoRoot, repoFiles).runners;
  const testFiles = repoFiles.filter((f) => matchesAnyGlob(f, DEFAULT_TEST_PATTERNS_UNIVERSAL));
  const defaultScopeMatches = repoFiles.filter((f) => matchesAnyGlob(f, DEFAULT_SCOPE_ALLOW)).length;

  const suppliedUncertainties = new Map(
    (Array.isArray(input.uncertainties) ? input.uncertainties : []).filter((u) => u?.id).map((u) => [u.id, u]),
  );
  const declaredCoverage = input.uncertainty_coverage ?? {};
  const hasAcceptance = Array.isArray(input.acceptance) && input.acceptance.length > 0;
  const hasScope = Array.isArray(input.scope?.allow) && input.scope.allow.length > 0;
  const behavioural = changeKind !== 'docs' && changeKind !== 'research';

  const questions = [];
  const add = (q) => {
    const answered = q.answered || isAnswered(suppliedUncertainties.get(q.id)) || Boolean(declaredCoverage[q.category]?.basis);
    questions.push({ ...q, answered });
  };

  if (behavioural) {
    add({
      id: 'Q-ACCEPTANCE',
      category: 'acceptance',
      level: 'BLOCKER',
      question: '이 요청이 충족됐음을 보여 줄 측정 가능한 수용 기준(실행 명령과 기대 결과)은 무엇입니까?',
      why: '수용 기준이 주어지지 않아 범용 테스트 명령 하나가 기본값으로 들어갑니다. 그 명령이 이번 요청을 단언하는지는 알 수 없습니다.',
      resolve_with: 'input.acceptance',
      answered: hasAcceptance,
    });
    // Runner detection falls back to a per-language default, so the absence of test files is the signal.
    if (testFiles.length === 0) {
      add({
        id: 'Q-NO-TESTS',
        category: 'acceptance',
        level: 'BLOCKER',
        question: '저장소에서 테스트 파일을 찾지 못했습니다. 이번 변경을 무엇으로 검증합니까?',
        why: '실행할 검사가 없으면 검증 단계가 증거를 만들 수 없습니다.',
        resolve_with: 'input.acceptance',
        answered: hasAcceptance,
      });
    }
  }

  add({
    id: 'Q-SCOPE',
    category: 'scope',
    level: defaultScopeMatches === 0 ? 'BLOCKER' : 'ASSUMABLE',
    question: defaultScopeMatches === 0
      ? `기본 허용 범위(${DEFAULT_SCOPE_ALLOW.join(', ')})에 해당하는 파일이 저장소에 없습니다. 수정해도 되는 경로는 어디입니까?`
      : `수정 허용 범위를 지정하지 않아 기본값(${DEFAULT_SCOPE_ALLOW.join(', ')})을 씁니다. 더 좁히거나 넓혀야 합니까?`,
    why: '범위 밖 수정은 검증에서 SCOPE_VIOLATION으로 실패합니다.',
    resolve_with: 'input.scope.allow',
    answered: hasScope,
  });

  if (changeKind === 'bugfix') {
    add({
      id: 'Q-REPRO',
      category: 'acceptance',
      level: 'BLOCKER',
      question: '버그를 재현하는 최소 절차와 그때의 기대 결과·실제 결과는 무엇입니까?',
      why: '재현 절차가 없으면 수정 전 실패(RED)를 확인할 수 없어, 통과가 수정 덕분인지 알 수 없습니다.',
      resolve_with: 'input.reproduction',
      answered: Boolean(input.reproduction),
    });
  }
  if (changeKind === 'refactor') {
    add({
      id: 'Q-BASELINE',
      category: 'acceptance',
      level: 'BLOCKER',
      question: '리팩터링 전후 동작이 같음을 확인할 기준선 GREEN 명령은 무엇입니까?',
      why: '동작 보존은 변경 전 통과하던 검사가 변경 후에도 통과하는 것으로만 보일 수 있습니다.',
      resolve_with: 'input.acceptance',
      answered: hasAcceptance,
    });
  }

  for (const [category, pattern] of Object.entries(RISK_PATTERNS)) {
    if (pattern.test(requestText)) {
      add({
        id: `Q-RISK-${category.toUpperCase()}`,
        category,
        level: category === 'compatibility' ? 'ASSUMABLE' : 'BLOCKER',
        ...RISK_QUESTIONS[category],
        resolve_with: `input.uncertainties[id=Q-RISK-${category.toUpperCase()}].answer`,
        answered: false,
      });
    }
  }

  for (const dec of params.relatedDecisions ?? []) {
    add({
      id: `Q-DECISION-${dec.id}`,
      category: 'compatibility',
      level: 'ASSUMABLE',
      question: `기존 결정 "${dec.title}"(${dec.source_path})과 이번 요청이 충돌하지 않습니까? 충돌하면 어느 쪽을 따릅니까?`,
      why: '요청 문구가 기록된 결정과 겹칩니다.',
      resolve_with: `input.uncertainties[id=Q-DECISION-${dec.id}].answer`,
      answered: false,
    });
  }

  if (requestText.trim().split(/\s+/).filter(Boolean).length < 4) {
    add({
      id: 'Q-VAGUE-REQUEST',
      category: 'scope',
      level: 'ASSUMABLE',
      question: '요청이 짧아 대상 기능이나 파일을 특정하기 어렵습니다. 무엇을, 어디에서, 어떻게 바꿉니까?',
      why: '요청이 네 단어 미만입니다.',
      resolve_with: 'request',
      answered: false,
    });
  }

  // Coverage: a category is addressed when an explicit basis was declared, its input was supplied,
  // or every question raised in it was answered. A category with no question and no basis is unaddressed:
  // nothing looked at it.
  const coverage = {};
  for (const category of COVERAGE_CATEGORIES) {
    const declared = declaredCoverage[category];
    const inCategory = questions.filter((q) => q.category === category);
    if (declared?.basis) {
      coverage[category] = { status: 'addressed', basis: String(declared.basis) };
    } else if (category === 'scope' && hasScope) {
      coverage[category] = { status: 'addressed', basis: 'scope.allow supplied' };
    } else if (category === 'acceptance' && hasAcceptance && inCategory.every((q) => q.answered)) {
      coverage[category] = { status: 'addressed', basis: 'acceptance criteria supplied' };
    } else if (inCategory.length > 0 && inCategory.every((q) => q.answered)) {
      coverage[category] = { status: 'addressed', basis: 'all generated questions answered' };
    } else {
      coverage[category] = {
        status: 'unaddressed',
        basis: inCategory.length > 0
          ? `open questions: ${inCategory.filter((q) => !q.answered).map((q) => q.id).join(', ')}`
          : 'no question was raised and no basis was declared',
      };
    }
  }

  return {
    questions,
    coverage,
    signals: { test_runners: runners, test_file_count: testFiles.length, default_scope_matches: defaultScopeMatches },
  };
}
