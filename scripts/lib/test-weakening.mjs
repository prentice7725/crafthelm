import { DEFAULT_TEST_PATTERNS_UNIVERSAL } from './impact-languages.mjs';
import { matchesAnyGlob } from './paths.mjs';

/**
 * Test weakening: did the change make the checks easier to pass instead of making the code right?
 *
 * A green suite says nothing when the failing test was deleted, skipped, or stripped of its
 * assertions. This reads the diff of test files only and reports three facts. Line-based on purpose:
 * no parser, so it flags candidates for the human reviewer and never decides that a change is wrong.
 */

// A marker on an added line that stops a test from running, or narrows the run to one test.
const SKIP_MARKERS = [
  /\b(?:it|test|describe|context|suite)\.(?:skip|only|todo)\s*\(/,
  /\b(?:xit|xdescribe|xtest|xcontext|fit|fdescribe)\s*\(/,
  /\{\s*(?:skip|todo)\s*:\s*(?!false\b)/,
  /\bt\.(?:skip|todo)\s*\(/,
  /@pytest\.mark\.(?:skip|skipif|xfail)\b/,
  /@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/,
  /\bpytest\.skip\s*\(/,
  /\bt\.Skip(?:f|Now)?\s*\(/,
  /#\[ignore\b/,
  /@(?:Disabled|Ignore)\b/,
  /\[(?:Ignore|(?:Fact|Theory)\s*\(\s*Skip)\b/,
  /\bmarkTestSkipped\s*\(/,
];

const ASSERTION = /\bassert|\bexpect\s*\(|\.should\b|\bt\.(?:Error|Fatal)f?\s*\(/i;

/**
 * @param {{ diffText: string, testFiles?: string[], testPatterns?: string[] }} params
 * @returns {{
 *   deleted_test_files: string[],
 *   skip_markers: Array<{ file: string, text: string }>,
 *   assertion_drops: Array<{ file: string, removed: number, added: number }>,
 * }}
 */
export function detectTestWeakening(params) {
  const known = new Set(params.testFiles ?? []);
  const patterns = params.testPatterns?.length ? params.testPatterns : DEFAULT_TEST_PATTERNS_UNIVERSAL;
  const isTest = (file) => known.has(file) || matchesAnyGlob(file, patterns);

  const deleted = [];
  const skipMarkers = [];
  const assertions = new Map();
  let file = null;
  let inHunk = false;
  let fileDeleted = false;

  for (const line of String(params.diffText ?? '').split(/\r?\n/)) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      file = isTest(header[2]) ? header[2] : null;
      inHunk = false;
      fileDeleted = false;
      continue;
    }
    if (!file) continue;
    if (!inHunk) {
      if (line.startsWith('deleted file mode')) {
        fileDeleted = true;
        deleted.push(file);
      } else if (line.startsWith('@@')) {
        inHunk = true;
      }
      continue;
    }
    // A deleted file is reported once as deleted, not again as lost assertions.
    if (fileDeleted || line.startsWith('@@')) continue;
    const sign = line[0];
    if (sign !== '+' && sign !== '-') continue;
    const text = line.slice(1);
    if (sign === '+' && SKIP_MARKERS.some((rx) => rx.test(text))) {
      skipMarkers.push({ file, text: text.trim().slice(0, 120) });
    }
    if (ASSERTION.test(text)) {
      const count = assertions.get(file) ?? { removed: 0, added: 0 };
      count[sign === '+' ? 'added' : 'removed'] += 1;
      assertions.set(file, count);
    }
  }

  const assertionDrops = [...assertions]
    .filter(([, c]) => c.removed > c.added)
    .map(([f, c]) => ({ file: f, removed: c.removed, added: c.added }));

  return { deleted_test_files: deleted, skip_markers: skipMarkers, assertion_drops: assertionDrops };
}
