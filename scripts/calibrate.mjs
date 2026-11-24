import path from 'node:path';
import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import { LITE_DEFAULT_LIMITS } from './lib/lite-profile.mjs';
import { readProfileObservations } from './lib/profile-observations.mjs';

/**
 * Lite limit calibration from recorded verification rounds.
 *
 * The question the lite limits answer: "below this size, would skipping E2E have let a bug through?"
 * The only rounds that answer it are bugfix rounds that did run E2E, whose other checks all passed and
 * whose evidence was not weak (the lite preconditions). If E2E failed in such a round, that is a bug a
 * lite run of the same size would have shipped: a *catch*. Rounds where E2E was waived or never ran say
 * nothing about misses and only count toward coverage (how often a limit would apply).
 *
 * The sample unit is the run, not the round. A lite run stops at its first round whose other checks pass,
 * so per run and per candidate limit the one round that counts is the first informative round within that
 * limit. Re-verifying the same task many times adds rounds but no independent lite decisions.
 *
 * With zero catches in n runs, the 95% upper bound on the miss rate is about 3/n (rule of three).
 * That bound, not "zero misses", is what the report states.
 */

export const DEFAULT_MIN_SAMPLES = 20;
// Contract policy allows 1-10 files and 1-300 lines; the grid spans that range.
export const CANDIDATE_FILES = Object.freeze([1, 2, 3, 5, 10]);
export const CANDIDATE_LINES = Object.freeze([20, 60, 100, 300]);

function isInformative(r) {
  return (r.e2e === 'PASS' || r.e2e === 'FAIL') && r.other_checks === 'ALL_PASS' && r.evidence_strength !== 'weak';
}

function within(r, limits) {
  return r.changed_source_files <= limits.max_changed_source_files && r.added_lines <= limits.max_added_lines;
}

function evaluateCandidate(limits, roundsByRun, latestPerRun, minSamples) {
  // One sample per run: the first informative round inside the limit is where lite would have stopped.
  const samples = [];
  for (const rounds of roundsByRun.values()) {
    const first = rounds.find((r) => isInformative(r) && within(r, limits));
    if (first) samples.push(first);
  }
  const catches = samples.filter((r) => r.e2e === 'FAIL');
  const n = samples.length;
  const covered = latestPerRun.filter((r) => within(r, limits)).length;
  return {
    ...limits,
    informative_runs: n,
    e2e_catches: catches.length,
    observed_miss_rate: n > 0 ? catches.length / n : null,
    // Rule of three: with 0 catches in n trials the 95% upper bound is ~3/n.
    miss_rate_upper_95: n > 0 && catches.length === 0 ? Math.min(1, 3 / n) : null,
    coverage: latestPerRun.length > 0 ? covered / latestPerRun.length : null,
    sufficient: n >= minSamples,
    catch_examples: catches.slice(0, 5).map((r) => `${r.repo}:${r.run_id}`),
  };
}

function parseMinSamples(value) {
  const n = Number(value ?? DEFAULT_MIN_SAMPLES);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--min-samples must be an integer of at least 1, got "${value}".`);
  }
  return n;
}

/**
 * @param {{ repos: string[], minSamples?: number }} options
 */
export function calibrateLiteLimits(options) {
  const minSamples = parseMinSamples(options.minSamples);
  const repos = (options.repos?.length ? options.repos : ['.']).map((r) => path.resolve(r));
  let malformed = 0;
  const seen = new Set();
  const bugfix = [];
  for (const repo of repos) {
    const read = readProfileObservations(repo);
    malformed += read.malformed;
    for (const r of read.records) {
      if (r.change_kind !== 'bugfix') continue;
      if (!Number.isFinite(r.changed_source_files) || !Number.isFinite(r.added_lines)) continue;
      // Re-running verify on an unchanged tree adds no information.
      const key = `${repo}::${r.run_id}::${r.target_snapshot_digest}::${r.e2e}::${r.other_checks}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // The full resolved path identifies the repository; two checkouts can share a folder name and run IDs.
      bugfix.push({ ...r, repo });
    }
  }

  const roundsByRun = new Map();
  for (const r of bugfix) {
    const key = `${r.repo}::${r.run_id}`;
    if (!roundsByRun.has(key)) roundsByRun.set(key, []);
    roundsByRun.get(key).push(r);
  }
  const latestPerRun = [...roundsByRun.values()].map((rounds) => rounds[rounds.length - 1]);
  const informative = bugfix.filter(isInformative);

  const candidates = [];
  for (const files of CANDIDATE_FILES) {
    for (const lines of CANDIDATE_LINES) {
      candidates.push(evaluateCandidate({ max_changed_source_files: files, max_added_lines: lines }, roundsByRun, latestPerRun, minSamples));
    }
  }
  const current = evaluateCandidate({ ...LITE_DEFAULT_LIMITS }, roundsByRun, latestPerRun, minSamples);

  let verdict = 'INSUFFICIENT_DATA';
  if (current.e2e_catches > 0) verdict = 'DEFAULT_TOO_LOOSE';
  else if (current.sufficient) verdict = 'DEFAULT_SUPPORTED';

  // Widest candidate with enough evidence and no catch. Wider means more lines first, then more files.
  const clean = candidates
    .filter((c) => c.sufficient && c.e2e_catches === 0)
    .sort((a, b) => b.max_added_lines - a.max_added_lines || b.max_changed_source_files - a.max_changed_source_files);
  const suggested = clean[0]
    ? { max_changed_source_files: clean[0].max_changed_source_files, max_added_lines: clean[0].max_added_lines, miss_rate_upper_95: clean[0].miss_rate_upper_95 }
    : null;

  return {
    ok: true,
    repos,
    min_samples: minSamples,
    bugfix_rounds: bugfix.length,
    bugfix_runs: latestPerRun.length,
    informative_rounds: informative.length,
    malformed_lines: malformed,
    default_limits: { ...LITE_DEFAULT_LIMITS },
    current,
    verdict,
    suggested_limits: suggested,
    candidates,
    notes: [
      'Only bugfix rounds that ran E2E with all other checks passing and non-weak evidence can show a miss.',
    'Each run counts once: its first such round inside a limit, where a lite run would have stopped.',
      'Lite runs waive E2E and add coverage only; full-profile bugfix runs with an E2E check supply the evidence.',
      'Suggested limits are the widest candidate with enough rounds and no catch; set them in verification_policy, they are not applied automatically.',
    ],
  };
}

function pct(x) {
  return x === null ? '-' : `${(x * 100).toFixed(0)}%`;
}

function printUsage() {
  process.stdout.write(
    [
      'CraftHelm Calibration CLI',
      '',
      'Usage: calibrate.mjs lite [--repo <path>]... [--min-samples 20] [--json]',
      '',
      'Reads .crafthelm/runs/*/evidence/profile-observations.jsonl from each repo and reports, per candidate',
      'lite limit, how many bugfix runs had E2E fail at the round where every other check first passed.',
      '',
    ].join('\n'),
  );
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (isHelpRequested(argv) || argv[0] !== 'lite') {
    printUsage();
    process.exit(isHelpRequested(argv) ? 0 : 1);
  }
  const args = parseArgs(argv.slice(1), { multiFlags: ['repo'] });
  const repos = Array.isArray(args.repo) ? args.repo : args.repo ? [args.repo] : ['.'];
  let report;
  try {
    report = calibrateLiteLimits({ repos, minSamples: args['min-samples'] });
  } catch (err) {
    process.stderr.write(`${err.message}
`);
    process.exit(1);
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const c = report.current;
    process.stdout.write(`Lite limit calibration: ${report.verdict}\n`);
    process.stdout.write(`- Bugfix runs: ${report.bugfix_runs}, rounds: ${report.bugfix_rounds}, informative rounds: ${report.informative_rounds} (need ${report.min_samples} runs within a limit)\n`);
    process.stdout.write(`- Default ${c.max_changed_source_files} files / ${c.max_added_lines} lines: ${c.informative_runs} runs, ${c.e2e_catches} E2E catches, miss rate upper bound ${pct(c.miss_rate_upper_95)}, coverage ${pct(c.coverage)}\n`);
    if (report.suggested_limits) {
      const s = report.suggested_limits;
      process.stdout.write(`- Widest supported: ${s.max_changed_source_files} files / ${s.max_added_lines} lines (miss rate upper bound ${pct(s.miss_rate_upper_95)})\n`);
    }
    for (const note of report.notes) process.stdout.write(`  ${note}\n`);
  }
}
