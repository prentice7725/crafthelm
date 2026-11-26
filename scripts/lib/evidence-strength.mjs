/**
 * Evidence strength: how much a PASS actually says about the change.
 *
 * A green check proves only that its command exited as expected. When the acceptance criteria are a
 * single generic test command, or no test reaches the changed code, PASS is weak evidence. This module
 * grades that deterministically from data verification already has (acceptance checks + impact analysis).
 * It is advisory: it never changes `technical_status`, it tells the human reviewer what to check by hand.
 */

import { detectTestWeakening } from './test-weakening.mjs';

const NON_BEHAVIORAL_KINDS = new Set(['docs', 'research']);
const DOC_FILE_PATTERN = /\.(md|mdx|txt|rst|adoc)$/i;
const EXECUTED_STATUSES = new Set(['PASS', 'FAIL', 'BLOCKED']);

const SIGNAL_DEFS = {
  NO_EXECUTED_PASSING_CHECK: {
    weight: 'weak',
    detail: 'No acceptance check was executed and passed.',
    human_check: 'Run the changed behaviour yourself; no executed check vouches for it.',
  },
  NO_TEST_REACHES_CHANGE: {
    weight: 'weak',
    detail: 'Impact analysis found no test file that imports or calls the changed code.',
    human_check: 'Confirm by hand that the changed code is exercised; the passing tests may not touch it.',
  },
  SINGLE_GENERIC_CHECK: {
    weight: 'weak',
    detail: 'The only executed check is one umbrella test command, not a criterion written for this change.',
    human_check: 'Check that the request has a test asserting it, not just a green pre-existing suite.',
  },
  NO_TEST_CHANGED: {
    weight: 'moderate',
    detail: 'Behaviour changed but no test file was added or modified.',
    human_check: 'Confirm an existing test asserts the new behaviour, or request one.',
  },
  MUTANTS_SURVIVED: {
    weight: 'moderate',
    detail: 'Some deliberately broken changed lines did not make any passing check fail.',
    human_check: 'Review the surviving mutants: those lines are not pinned down by a test.',
  },
  TEST_FILE_DELETED: {
    weight: 'weak',
    detail: 'A test file was deleted in this change.',
    human_check: 'Confirm the deleted tests were obsolete, not tests the change could not pass.',
  },
  TEST_SKIP_ADDED: {
    weight: 'weak',
    detail: 'A skip, only or todo marker was added to a test file.',
    human_check: 'Confirm no failing test was switched off to make the suite pass.',
  },
  ASSERTIONS_REMOVED: {
    weight: 'moderate',
    detail: 'A test file lost more assertion lines than it gained.',
    human_check: 'Compare the removed assertions with the request; they may have been the ones that failed.',
  },
  IMPACT_INCONCLUSIVE: {
    weight: 'moderate',
    detail: 'Impact analysis could not build a usable graph, so test reach over the changed code is unknown.',
    human_check: 'Test reach could not be established mechanically; spot-check the changed code paths.',
  },
};

/**
 * Grade evidence strength for a verification run.
 * @param {{
 *   contract: { change_kind?: string },
 *   checks: Array<{ kind: string, status: string, command?: string }>,
 *   impact: { test_candidates?: string[], selected_tests?: Array<{ file: string }>, fallback_to_full?: boolean, fallback_code?: string|null, fallback_reason?: string|null },
 *   changedFiles: string[],
 *   mutationProbe?: { status: string, total: number, survived: number, score: number|null, mutants: Array<{ file: string, line: number, operator: string, killed: boolean }> }|null,
 *   diffText?: string,
 *   testPatterns?: string[],
 * }} input
 * @returns {{ level: 'strong'|'moderate'|'weak'|'not_applicable', signals: Array<{ code: string, weight: string, detail: string, human_check: string, refs?: string[] }>, changed_source_files: string[], reaching_tests: string[] }}
 */
export function assessEvidenceStrength(input) {
  const changeKind = input.contract?.change_kind ?? 'feature';
  const testFiles = new Set(input.impact?.test_candidates ?? []);
  const changedFiles = input.changedFiles ?? [];
  const reachingTests = (input.impact?.selected_tests ?? []).map((t) => t.file);

  // Weakened tests matter for every kind of change, including one that touches no source file:
  // "only the tests changed" is exactly what switching off a failing test looks like.
  const weakening = detectTestWeakening({ diffText: input.diffText, testFiles: [...testFiles], testPatterns: input.testPatterns });
  const weakeningRefs = {
    TEST_FILE_DELETED: weakening.deleted_test_files,
    TEST_SKIP_ADDED: [...new Set(weakening.skip_markers.map((m) => m.file))],
    ASSERTIONS_REMOVED: weakening.assertion_drops.map((d) => d.file),
  };
  // A deleted test file is no longer a test candidate, but it is not changed source either.
  const deletedTests = new Set(weakening.deleted_test_files);
  const changedSource = changedFiles.filter((f) => !testFiles.has(f) && !deletedTests.has(f) && !DOC_FILE_PATTERN.test(f));
  const weakeningCodes = Object.keys(weakeningRefs).filter((code) => weakeningRefs[code].length > 0);
  const behavioural = !NON_BEHAVIORAL_KINDS.has(changeKind) && changedSource.length > 0;

  if (!behavioural && weakeningCodes.length === 0) {
    return { level: 'not_applicable', signals: [], changed_source_files: changedSource, reaching_tests: reachingTests };
  }

  const codes = [];
  const executed = (input.checks ?? []).filter((c) => EXECUTED_STATUSES.has(c.status));
  const passing = executed.filter((c) => c.status === 'PASS');

  if (!behavioural) {
    // Only the weakening signals apply; reach and tailoring are about changed source.
  } else if (passing.length === 0) {
    codes.push('NO_EXECUTED_PASSING_CHECK');
  } else if (executed.length === 1 && executed[0].kind === 'test') {
    codes.push('SINGLE_GENERIC_CHECK');
  }

  // Reach is conclusive when the graph ran: either it found reaching tests, or it found none
  // (`NO_TEST_MATCHED` is the analyzer saying exactly that before falling back to the full suite).
  if (behavioural && reachingTests.length === 0) {
    const graphConclusive = !input.impact?.fallback_to_full || input.impact?.fallback_code === 'NO_TEST_MATCHED';
    codes.push(graphConclusive ? 'NO_TEST_REACHES_CHANGE' : 'IMPACT_INCONCLUSIVE');
  }

  const behaviourChange = behavioural && (changeKind === 'feature' || changeKind === 'bugfix');
  if (behaviourChange && !changedFiles.some((f) => testFiles.has(f))) {
    codes.push('NO_TEST_CHANGED');
  }

  const probe = input.mutationProbe;
  if (probe?.status === 'PROBED' && probe.survived > 0) {
    codes.push('MUTANTS_SURVIVED');
  }
  codes.push(...weakeningCodes);

  const signals = codes.map((code) => ({
    code,
    ...SIGNAL_DEFS[code],
    ...(weakeningRefs[code] ? { detail: `${SIGNAL_DEFS[code].detail} Files: ${weakeningRefs[code].join(', ')}.`, refs: weakeningRefs[code] } : {}),
  }));
  const survivedSignal = signals.find((s) => s.code === 'MUTANTS_SURVIVED');
  if (survivedSignal) {
    // Most mutants surviving means the checks barely constrain the change.
    if (probe.score < 0.5) survivedSignal.weight = 'weak';
    const survivors = probe.mutants.filter((m) => !m.killed).map((m) => `${m.file}:${m.line} (${m.operator})`);
    survivedSignal.detail = `${probe.survived} of ${probe.total} mutants survived: ${survivors.join(', ')}.`;
  }
  const inconclusive = signals.find((s) => s.code === 'IMPACT_INCONCLUSIVE');
  if (inconclusive && input.impact?.fallback_reason) {
    const sig = inconclusive;
    sig.detail = `${sig.detail} Reason: ${input.impact.fallback_reason}.`;
  }
  const level = signals.some((s) => s.weight === 'weak')
    ? 'weak'
    : signals.length > 0
      ? 'moderate'
      : 'strong';

  return { level, signals, changed_source_files: changedSource, reaching_tests: reachingTests };
}
