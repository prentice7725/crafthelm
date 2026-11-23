import { parseAddedLines } from './mutation-probe.mjs';

/**
 * Lite process profile: a conditional exemption from the E2E requirement (V01) for small bugfixes.
 *
 * The exemption is earned, not declared. A lite contract skips the E2E check only while the change stays
 * small and a tailored test reaches the changed code. The moment it outgrows those limits, verification
 * fails with `LITE_PROFILE_EXCEEDED` and the task has to add an E2E check or be re-planned as `full`.
 * Limits live in the approved contract, so they are hash-locked for the run.
 */

export const LITE_ELIGIBLE_CHANGE_KINDS = Object.freeze(['bugfix']);

export const LITE_DEFAULT_LIMITS = Object.freeze({
  max_changed_source_files: 3,
  max_added_lines: 60,
});

/**
 * @param {object} contract
 * @returns {boolean}
 */
export function isLiteContract(contract) {
  return contract?.process_profile === 'lite';
}

/**
 * Whether a contract's declared profile can waive the E2E requirement at all (checked before any code exists).
 * @param {object} contract
 */
export function liteExemptsE2eByContract(contract) {
  return isLiteContract(contract) && LITE_ELIGIBLE_CHANGE_KINDS.includes(contract.change_kind ?? 'feature');
}

/**
 * Evaluate whether the actual change still qualifies for the lite exemption.
 * @param {{
 *   contract: object,
 *   strength: { level: string, signals: Array<{ code: string, weight: string }>, changed_source_files: string[] },
 *   diffText: string,
 * }} params
 * @returns {{ profile: 'full'|'lite', eligible: boolean, violations: string[], limits: { max_changed_source_files: number, max_added_lines: number }, observed: { change_kind: string, changed_source_files: number, added_lines: number, evidence_strength: string } }}
 */
export function evaluateLiteProfile(params) {
  const { contract, strength } = params;
  const changeKind = contract.change_kind ?? 'feature';
  const limits = {
    max_changed_source_files: contract.verification_policy?.lite_max_changed_source_files ?? LITE_DEFAULT_LIMITS.max_changed_source_files,
    max_added_lines: contract.verification_policy?.lite_max_added_lines ?? LITE_DEFAULT_LIMITS.max_added_lines,
  };
  const sourceFiles = new Set(strength.changed_source_files);
  const addedByFile = parseAddedLines(params.diffText);
  let addedLines = 0;
  for (const [file, lines] of addedByFile) {
    if (sourceFiles.has(file)) addedLines += lines.length;
  }
  const observed = {
    change_kind: changeKind,
    changed_source_files: sourceFiles.size,
    added_lines: addedLines,
    evidence_strength: strength.level,
  };

  if (!isLiteContract(contract)) {
    return { profile: 'full', eligible: false, violations: [], limits, observed };
  }

  const violations = [];
  if (!LITE_ELIGIBLE_CHANGE_KINDS.includes(changeKind)) {
    violations.push(`change_kind "${changeKind}" is not eligible (allowed: ${LITE_ELIGIBLE_CHANGE_KINDS.join(', ')})`);
  }
  if (sourceFiles.size > limits.max_changed_source_files) {
    violations.push(`${sourceFiles.size} source files changed, limit is ${limits.max_changed_source_files}`);
  }
  if (addedLines > limits.max_added_lines) {
    violations.push(`${addedLines} source lines added, limit is ${limits.max_added_lines}`);
  }
  if (strength.level === 'weak') {
    const weakSignals = strength.signals.filter((s) => s.weight === 'weak').map((s) => s.code);
    violations.push(`evidence strength is weak (${weakSignals.join(', ')})`);
  }
  return { profile: 'lite', eligible: violations.length === 0, violations, limits, observed };
}
