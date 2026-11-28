import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { isMainModule } from './lib/cli.mjs';
import { CRAFTHELM_ROOT } from './lib/paths.mjs';

// `approve` waits on a person reading review packages at a prompt; cutting it off mid-answer would
// record nothing and look like a hang.
export const LONG_RUNNING_COMMANDS = new Set(['verify', 'feedback', 'benchmark', 'approve', 'review']);
// A guard against a hung subcommand, not a performance budget: hashing a repository with large
// files can take minutes. CRAFTHELM_CLI_TIMEOUT_MS overrides it; 0 turns it off.
export const DEFAULT_CLI_TIMEOUT_MS = 300_000;

/**
 * Resolve overall CLI process timeout in ms (`0` disables parent cutoff for long-running suites).
 * @param {string} subcommand
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function resolveCommandTimeoutMs(subcommand, env = process.env) {
  const rawOverride = env?.CRAFTHELM_CLI_TIMEOUT_MS;
  if (rawOverride !== undefined && String(rawOverride).trim() !== '') {
    const parsed = Number(rawOverride);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return LONG_RUNNING_COMMANDS.has(subcommand) ? 0 : DEFAULT_CLI_TIMEOUT_MS;
}

export const MIN_NODE_MAJOR = 24;

/**
 * Explain an unsupported Node.js runtime in one line instead of letting a subcommand die on a
 * missing built-in (`node:sqlite` and friends). Returns null when the runtime is new enough.
 * @param {string} [version]
 * @returns {string|null}
 */
export function describeUnsupportedNode(version = process.versions.node) {
  const major = Number(String(version).split('.')[0]);
  if (Number.isInteger(major) && major >= MIN_NODE_MAJOR) return null;
  return `CraftHelm needs Node.js ${MIN_NODE_MAJOR} or newer; this is ${version}. Install it (for example "nvm install ${MIN_NODE_MAJOR}") and run the command again.`;
}

const SUBCOMMANDS = new Map([
  ['start', 'scripts/start.mjs'],
  ['status', 'scripts/status.mjs'],
  ['doctor', 'scripts/doctor.mjs'],
  ['init-host', 'scripts/init-host.mjs'],
  ['install-skills', 'scripts/install-skills.mjs'],
  ['interview', 'scripts/interview.mjs'],
  ['contract', 'scripts/contract.mjs'],
  ['checkpoint', 'scripts/checkpoint.mjs'],
  ['impact', 'scripts/impact.mjs'],
  ['route', 'scripts/route.mjs'],
  ['delegate', 'scripts/delegate.mjs'],
  ['verify', 'scripts/verify.mjs'],
  ['feedback', 'scripts/feedback-loop.mjs'],
  ['review-package', 'scripts/review-package.mjs'],
  ['approve', 'scripts/approval.mjs'],
  ['review', 'scripts/review.mjs'],
  ['memory', 'scripts/memory.mjs'],
  ['skills', 'scripts/skills.mjs'],
  ['zones', 'scripts/zones.mjs'],
  ['benchmark', 'scripts/benchmark.mjs'],
  ['calibrate', 'scripts/calibrate.mjs'],
]);

function printHelp() {
  process.stdout.write(
    [
      'CraftHelm CLI (v0.1.0 / Spec v0.3)',
      '',
      'Usage: crafthelm <command> [options]',
      '       crafthelm help [command]     (same as <command> --help)',
      '',
      'Commands:',
      '  start            Detect host/test runners, run interview, and print the next command',
      '  status           Show active run(s), pending contracts, and recommended next action without --run-id',
      '  doctor           Probe host capabilities (claude, codex, antigravity, generic, or custom CLI)',
      '  init-host        Install CraftHelm/Kouetsu host integration files into a target repository',
      '  install-skills   Register CraftHelm skill packages into Claude Code, Codex, and Gemini/Antigravity',
      '  interview        Run Source-First intake and generate contract + specs',
      '  contract         validate | plan | add-e2e | add-test | approve an execution contract',
      '  checkpoint       init | acquire-lock | release-lock | stage | approve-stage | transition | record-repair | resume | handoff | replan | rebaseline | consider | close | status',
      '  impact           Run AST + call-graph diff impact analysis and selective test recommendation',
      '  route            Route task to cost-efficient tier (deterministic | lightweight | standard | reasoning)',
      '  delegate         run | record | status: dispatch a worker on the active host and record what actually ran',
      '  verify           Execute AC checks (--selective supported), E2E/property/differential tests, reliability rules',
      '  feedback         Run bounded verify -> feedback -> repair -> READY_FOR_HUMAN_REVIEW loop',
      '  review-package   Generate 8-section Markdown package, validate links/ACs, run Kouetsu editorial check',
      '  approve          record | batch | queue | trial | verify explicit human acceptance decisions',
      '  review           Open the review page: read and decide the runs waiting for a human decision',
      '  memory           index | search | decide | list Markdown SOT + SQLite FTS5 memory',
      '  skills           list | audit | lock | verify-lock external skills',
      '  zones            show | set | check the paths this project treats as strict',
      '  benchmark        Run deterministic E01-E04, E10 comparison suite',
      '  calibrate        lite: measure lite E2E-exemption limits against recorded bugfix verification rounds',
      '',
    ].join('\n'),
  );
}

if (isMainModule(import.meta.url)) {
  const unsupportedNode = describeUnsupportedNode();
  if (unsupportedNode) {
    process.stderr.write(`${unsupportedNode}\n`);
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const sub = args[0];

  if (!sub || sub === '--help' || sub === '-h' || (sub === 'help' && !args[1])) {
    printHelp();
    process.exit(0);
  }
  // `help <command>` is `<command> --help`.
  if (sub === 'help') {
    args.splice(0, 2, args[1], '--help');
  }

  const command = args[0];
  const scriptRel = SUBCOMMANDS.get(command);
  if (!scriptRel) {
    process.stderr.write(`Unknown command "${command}". Run "crafthelm --help" for usage.\n`);
    process.exit(1);
  }

  const scriptAbs = path.join(CRAFTHELM_ROOT, scriptRel);
  const timeout = resolveCommandTimeoutMs(command, process.env);
  const res = spawnSync(process.execPath, [scriptAbs, ...args.slice(1)], {
    cwd: process.cwd(),
    stdio: 'inherit',
    windowsHide: true,
    ...(timeout > 0 ? { timeout } : {}),
  });

  if (res.error) {
    if (res.error.code === 'ETIMEDOUT') {
      process.stderr.write(`Command "${command}" timed out after ${timeout}ms and was stopped; it did not finish (exit code 124). Set CRAFTHELM_CLI_TIMEOUT_MS to a larger value, or 0 for no limit.\n`);
      process.exit(124);
    }
    process.stderr.write(`${res.error.message}\n`);
    process.exit(1);
  }
  if (typeof res.status === 'number') {
    process.exit(res.status);
  }
  process.stderr.write(`Command "${command}" terminated by signal ${res.signal ?? 'unknown'}.\n`);
  process.exit(1);
}
