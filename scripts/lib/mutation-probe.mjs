import fs from 'node:fs';
import path from 'node:path';
import { sha256File, sha256Text } from './crypto.mjs';
import { runShellCommand } from './exec.mjs';

/**
 * Mutation probe: a deterministic substitute for the cross-model review a single provider cannot give.
 *
 * A passing test only matters if it would fail when the change is wrong. The probe breaks one changed
 * line at a time (flip a comparison, a boolean, an arithmetic operator), re-runs the checks that passed,
 * and expects at least one to fail. A mutant that survives is a concrete line the tests do not pin down.
 * Token-level and language-agnostic on purpose: no parser, no dependency, bounded cost.
 *
 * Working-tree safety: every mutation is restored in a `finally`, and the original bytes are journaled
 * in the run directory first so an interrupted probe is repaired by the next call.
 */

const COMMENT_OR_IMPORT = /^\s*(\/\/|#|\*|\/\*|<!--|import\b|from\b|export\s+\*|using\b|package\b|require\b)/;

// Ordered: the first operator that matches a line is the mutation applied to it.
const OPERATORS = [
  { id: 'eq_strict_flip', pattern: /===/, replace: '!==' },
  { id: 'neq_strict_flip', pattern: /!==/, replace: '===' },
  { id: 'eq_flip', pattern: /(?<![=!<>])==(?!=)/, replace: '!=' },
  { id: 'neq_flip', pattern: /!=(?!=)/, replace: '==' },
  { id: 'lte_to_lt', pattern: /<=(?!=)/, replace: '<' },
  { id: 'gte_to_gt', pattern: /(?<![=-])>=(?!=)/, replace: '>' },
  { id: 'lt_to_lte', pattern: /(?<=[\w)\]]\s)<(?=\s[\w(\-])/, replace: '<=' },
  { id: 'gt_to_gte', pattern: /(?<=[\w)\]]\s)>(?=\s[\w(\-])/, replace: '>=' },
  { id: 'and_to_or', pattern: /&&/, replace: '||' },
  { id: 'or_to_and', pattern: /\|\|/, replace: '&&' },
  { id: 'true_to_false', pattern: /\btrue\b/, replace: 'false' },
  { id: 'false_to_true', pattern: /\bfalse\b/, replace: 'true' },
  { id: 'True_to_False', pattern: /\bTrue\b/, replace: 'False' },
  { id: 'False_to_True', pattern: /\bFalse\b/, replace: 'True' },
  { id: 'plus_to_minus', pattern: /(?<=[\w)\]]\s)\+(?=\s[\w(])/, replace: '-' },
  { id: 'minus_to_plus', pattern: /(?<=[\w)\]]\s)-(?=\s[\w(])/, replace: '+' },
  { id: 'mul_to_div', pattern: /(?<=[\w)\]]\s)\*(?=\s[\w(])/, replace: '/' },
  { id: 'div_to_mul', pattern: /(?<=[\w)\]]\s)\/(?=\s[\w(])/, replace: '*' },
];

/**
 * Parse a unified diff into the set of added line numbers (new-file numbering) per file.
 * @param {string} diffText
 * @returns {Map<string, number[]>}
 */
export function parseAddedLines(diffText) {
  const added = new Map();
  let current = null;
  let lineNo = 0;
  for (const line of String(diffText ?? '').split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      current = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (current && !added.has(current)) added.set(current, []);
      continue;
    }
    if (line.startsWith('--- ')) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      lineNo = Number(hunk[1]);
      continue;
    }
    if (!current || lineNo === 0) continue;
    if (line.startsWith('+')) {
      added.get(current).push(lineNo);
      lineNo += 1;
    } else if (!line.startsWith('-') && !line.startsWith('\\')) {
      lineNo += 1;
    }
  }
  return added;
}

/**
 * Plan mutants for the changed lines of the given source files, without touching the tree.
 * @param {{ repoRoot: string, diffText: string, sourceFiles: string[], maxMutants?: number }} params
 */
export function planMutants(params) {
  const addedByFile = parseAddedLines(params.diffText);
  const wanted = new Set(params.sourceFiles);
  const mutants = [];
  for (const [file, lineNumbers] of addedByFile) {
    if (!wanted.has(file)) continue;
    const abs = path.join(params.repoRoot, file);
    if (!fs.existsSync(abs)) continue;
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    for (const lineNo of lineNumbers) {
      const original = lines[lineNo - 1];
      if (original === undefined || !original.trim() || COMMENT_OR_IMPORT.test(original)) continue;
      const op = OPERATORS.find((o) => o.pattern.test(original));
      if (!op) continue;
      mutants.push({ file, line: lineNo, operator: op.id, original: original.trim(), mutated: original.replace(op.pattern, op.replace).trim() });
    }
  }
  // Spread the budget across files instead of spending it all on the first one.
  const limit = params.maxMutants ?? 8;
  if (mutants.length <= limit) return mutants;
  const byFile = new Map();
  for (const m of mutants) {
    if (!byFile.has(m.file)) byFile.set(m.file, []);
    byFile.get(m.file).push(m);
  }
  const picked = [];
  while (picked.length < limit) {
    let progressed = false;
    for (const list of byFile.values()) {
      if (list.length > 0 && picked.length < limit) {
        picked.push(list.shift());
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return picked;
}

function journalPath(journalDir) {
  return path.join(journalDir, 'mutation-journal.json');
}

/**
 * Restore a file left mutated by an interrupted probe. Safe to call when nothing is pending.
 * @param {string} repoRoot
 * @param {string} journalDir
 * @returns {{ recovered: boolean, file?: string }}
 */
export function recoverInterruptedProbe(repoRoot, journalDir) {
  const jp = journalPath(journalDir);
  if (!fs.existsSync(jp)) return { recovered: false };
  const journal = JSON.parse(fs.readFileSync(jp, 'utf8'));
  fs.writeFileSync(path.join(repoRoot, journal.file), Buffer.from(journal.original_base64, 'base64'));
  fs.rmSync(jp, { force: true });
  return { recovered: true, file: journal.file };
}

/**
 * Run the probe: apply each planned mutant, run the commands, expect a failure, restore.
 * @param {{ repoRoot: string, journalDir: string, diffText: string, sourceFiles: string[], commands: Array<{ id: string, command: string, expected_exit_code?: number }>, maxMutants?: number, timeoutMs?: number }} params
 */
export function runMutationProbe(params) {
  fs.mkdirSync(params.journalDir, { recursive: true });
  recoverInterruptedProbe(params.repoRoot, params.journalDir);

  if (params.commands.length === 0) {
    return { status: 'SKIPPED', reason: 'no passing command-based check to re-run', total: 0, killed: 0, survived: 0, score: null, mutants: [] };
  }
  const planned = planMutants(params);
  if (planned.length === 0) {
    return { status: 'NO_MUTABLE_LINES', reason: 'no changed source line matched a mutation operator', total: 0, killed: 0, survived: 0, score: null, mutants: [] };
  }

  const results = [];
  for (const mutant of planned) {
    const abs = path.join(params.repoRoot, mutant.file);
    const originalBuf = fs.readFileSync(abs);
    const originalSha = sha256File(abs);
    const lines = originalBuf.toString('utf8').split('\n');
    const op = OPERATORS.find((o) => o.id === mutant.operator);
    lines[mutant.line - 1] = lines[mutant.line - 1].replace(op.pattern, op.replace);

    fs.writeFileSync(
      journalPath(params.journalDir),
      JSON.stringify({ file: mutant.file, original_sha256: originalSha, original_base64: originalBuf.toString('base64') }),
      'utf8',
    );
    let killedBy = null;
    try {
      fs.writeFileSync(abs, lines.join('\n'), 'utf8');
      for (const cmd of params.commands) {
        const res = runShellCommand(cmd.command, { cwd: params.repoRoot, timeoutMs: params.timeoutMs });
        if (res.exitCode !== (cmd.expected_exit_code ?? 0)) {
          killedBy = cmd.id;
          break;
        }
      }
    } finally {
      fs.writeFileSync(abs, originalBuf);
      fs.rmSync(journalPath(params.journalDir), { force: true });
    }
    if (sha256File(abs) !== originalSha) {
      throw new Error(`MUTATION_RESTORE_FAILED: ${mutant.file} does not match its pre-probe content.`);
    }
    results.push({ ...mutant, killed: killedBy !== null, killed_by: killedBy });
  }

  const killed = results.filter((r) => r.killed).length;
  return {
    status: 'PROBED',
    reason: null,
    total: results.length,
    killed,
    survived: results.length - killed,
    score: killed / results.length,
    plan_digest: sha256Text(JSON.stringify(planned)),
    mutants: results,
  };
}
