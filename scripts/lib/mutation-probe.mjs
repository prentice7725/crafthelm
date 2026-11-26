import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sha256Buffer, sha256File, sha256Text } from './crypto.mjs';
import { runShellCommand } from './exec.mjs';
import { writeAtomic } from './task-artifacts.mjs';

/**
 * Mutation probe: a deterministic substitute for the cross-model review a single provider cannot give.
 *
 * A passing test only matters if it would fail when the change is wrong. The probe breaks one changed
 * line at a time (flip a comparison, a boolean, an arithmetic operator, or remove a whole statement
 * that has no operator), re-runs the checks that passed, and expects at least one to fail. A mutant
 * that survives is a concrete line the tests do not pin down.
 * Token-level on purpose: no parser, no dependency, bounded cost. String literals and trailing comments
 * on the line are masked first (`maskNonCode`), so an operator inside them is never mutated.
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

const SLASH_COMMENT_EXTS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'go', 'rs', 'java', 'kt', 'kts', 'cs', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'swift', 'scala', 'dart', 'php']);
const HASH_COMMENT_EXTS = new Set(['py', 'rb', 'sh', 'bash', 'zsh', 'pl', 'pm', 'r', 'ex', 'exs', 'php']);
// Languages where `'` delimits a single character, not a string (in Rust it may also start a lifetime).
const CHAR_QUOTE_EXTS = new Set(['go', 'rs', 'java', 'kt', 'kts', 'cs', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'scala', 'swift']);
const BACKTICK_STRING_EXTS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'go']);
const CHAR_LITERAL = /^'(\\[^']{1,10}|[^'\\])'/;

function fileExt(file) {
  const m = /\.([^./\\]+)$/.exec(file);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Blank out string literal contents and trailing comments on one line, keeping its length, so operator
 * matches land only in code. Quote characters are kept; everything between them becomes spaces.
 * A quote that does not close on the same line is left alone: multi-line strings and block comments
 * that started on an earlier line are not tracked. Unknown extensions get string masking only.
 * @param {string} line
 * @param {string} file
 * @returns {string}
 */
export function maskNonCode(line, file) {
  const ext = fileExt(file);
  const slash = SLASH_COMMENT_EXTS.has(ext);
  const hash = HASH_COMMENT_EXTS.has(ext);
  const charQuote = CHAR_QUOTE_EXTS.has(ext);
  const quotes = new Set(['"']);
  if (!charQuote) quotes.add("'");
  if (BACKTICK_STRING_EXTS.has(ext)) quotes.add('`');
  const out = line.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k++) out[k] = ' ';
  };
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (slash && ch === '/' && line[i + 1] === '/') {
      blank(i + 2, line.length);
      break;
    }
    if (slash && ch === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      blank(i + 2, end === -1 ? line.length : end);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    // `#` right after an identifier char or `.` is code (`this.#x`, `$#arr`), not a comment.
    if (hash && ch === '#' && !/[\w.$]/.test(line[i - 1] ?? '')) {
      blank(i + 1, line.length);
      break;
    }
    if (charQuote && ch === "'") {
      // 'x' or an escape such as '\n'; anything else (a Rust lifetime) is code.
      const m = CHAR_LITERAL.exec(line.slice(i));
      if (m) blank(i + 1, i + m[0].length - 1);
      i += m ? m[0].length : 1;
      continue;
    }
    if (quotes.has(ch)) {
      let k = i + 1;
      while (k < line.length && line[k] !== ch) k += line[k] === '\\' ? 2 : 1;
      if (k >= line.length) {
        i += 1;
        continue;
      }
      blank(i + 1, k);
      i = k + 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/**
 * First operator that matches code on a line, with strings and comments masked.
 * @param {string} line
 * @param {string} file
 * @returns {{ op: { id: string, pattern: RegExp, replace: string }, column: number, length: number }|null}
 */
function findCodeOperator(line, file) {
  const masked = maskNonCode(line, file);
  for (const op of OPERATORS) {
    const m = op.pattern.exec(masked);
    if (m) return { op, column: m.index, length: m[0].length };
  }
  return null;
}

// Statement removal is limited to languages where the file still loads without the line, so a
// kill means a test ran the code and noticed. In a compiled language a removed `return` is a
// build error, which would count as a kill without any test reaching the line.
const DELETE_STATEMENT_EXTS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx']);
const DELETE_TO_PASS_EXTS = new Set(['py']);
const PY_NOT_A_STATEMENT = /^(?:def|class|if|elif|else|for|while|try|except|finally|with|async|match|case|pass)\b|^@/;

function bracketsBalanced(code) {
  let depth = 0;
  for (const ch of code) {
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * Whole-statement removal for a line with no operator to flip: the line must be one complete
 * statement, so that removing it changes behaviour without breaking the syntax around it.
 * JS/TS: ends with `;`, brackets balanced, not an export or a string-only statement. The line is blanked.
 * Python: brackets balanced, not a block header, decorator, docstring or continuation. The line becomes `pass`.
 * @param {string} line
 * @param {string} file
 * @returns {{ op: { id: string, replace: string }, column: number, length: number }|null}
 */
function findLineDeletion(line, file) {
  const ext = fileExt(file);
  const masked = maskNonCode(line, file);
  const indent = line.length - line.trimStart().length;
  const hit = (replace) => ({ op: { id: 'line_delete', replace }, column: indent, length: line.length - indent });
  if (DELETE_STATEMENT_EXTS.has(ext)) {
    const cut = masked.indexOf('//');
    const code = (cut === -1 ? masked : masked.slice(0, cut)).trim();
    if (!code.endsWith(';') || /^(?:export\b|["'`])/.test(code) || !bracketsBalanced(code)) return null;
    return hit('');
  }
  if (DELETE_TO_PASS_EXTS.has(ext)) {
    const cut = masked.indexOf('#');
    const code = (cut === -1 ? masked : masked.slice(0, cut)).trim();
    if (!code || /[:,\\]$/.test(code) || /^["']/.test(code) || PY_NOT_A_STATEMENT.test(code) || !bracketsBalanced(code)) return null;
    return hit('pass');
  }
  return null;
}

/**
 * The mutation for a line: an operator flip when the code has one, otherwise statement removal.
 */
function findMutation(line, file) {
  return findCodeOperator(line, file) ?? findLineDeletion(line, file);
}

function applyAt(line, column, length, replacement) {
  return line.slice(0, column) + replacement + line.slice(column + length);
}

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
  const flips = [];
  const removals = [];
  for (const [file, lineNumbers] of addedByFile) {
    if (!wanted.has(file)) continue;
    const abs = path.join(params.repoRoot, file);
    if (!fs.existsSync(abs)) continue;
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    for (const lineNo of lineNumbers) {
      const original = lines[lineNo - 1];
      if (original === undefined || !original.trim() || COMMENT_OR_IMPORT.test(original)) continue;
      const hit = findMutation(original, file);
      if (!hit) continue;
      (hit.op.id === 'line_delete' ? removals : flips).push({
        file,
        line: lineNo,
        column: hit.column,
        operator: hit.op.id,
        original: original.trim(),
        mutated: applyAt(original, hit.column, hit.length, hit.op.replace).trim() || '(line removed)',
      });
    }
  }
  // Operator flips first: under a tight budget they are the sharper probe.
  const mutants = [...flips, ...removals];
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
 *
 * The journal sits under `.crafthelm/runs/`, which anything in the workspace can write, so it is
 * not trusted blindly: the target must stay inside the repository (never `.git/` or `.crafthelm/`),
 * the stored original must match its recorded hash, and the file is only rewritten while it still
 * holds the mutated bytes. A file edited since the probe is left alone. A journal that cannot be
 * used is moved aside so it never blocks verification, and the reason is returned.
 * @param {string} repoRoot
 * @param {string} journalDir
 * @returns {{ recovered: boolean, file?: string, restored_sha256?: string, problem?: string, detail?: string }}
 */
export function recoverInterruptedProbe(repoRoot, journalDir) {
  const jp = journalPath(journalDir);
  if (!fs.existsSync(jp)) return { recovered: false };
  const setAside = (problem, detail, file) => {
    fs.renameSync(jp, path.join(journalDir, `mutation-journal.rejected-${Date.now()}-${randomUUID().slice(0, 8)}.json`));
    return { recovered: false, problem, detail, ...(file ? { file } : {}) };
  };

  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(jp, 'utf8'));
  } catch (err) {
    return setAside('JOURNAL_CORRUPT', `journal is not valid JSON: ${err.message}`);
  }
  const root = path.resolve(repoRoot);
  const rel = typeof journal?.file === 'string' ? journal.file : '';
  const abs = path.resolve(root, rel);
  const relPosix = path.relative(root, abs).split(path.sep).join('/');
  if (!rel || relPosix === '' || relPosix === '..' || relPosix.startsWith('../') || path.isAbsolute(relPosix) || /^(\.git|\.crafthelm)(\/|$)/.test(relPosix)) {
    return setAside('JOURNAL_PATH_REJECTED', `journal target "${rel}" is outside the repository's source tree`, rel);
  }
  const original = Buffer.from(String(journal.original_base64 ?? ''), 'base64');
  if (sha256Buffer(original) !== journal.original_sha256) {
    return setAside('JOURNAL_CORRUPT', 'stored original does not match original_sha256', relPosix);
  }
  const current = fs.existsSync(abs) ? sha256File(abs) : null;
  if (current === journal.original_sha256) {
    // The finally block restored it before the process died; only the journal is left.
    fs.rmSync(jp, { force: true });
    return { recovered: false, file: relPosix };
  }
  if (!journal.mutated_sha256 || current !== journal.mutated_sha256) {
    return setAside('FILE_CHANGED_SINCE_PROBE', 'the file no longer holds the mutated content; it was left as it is', relPosix);
  }
  writeAtomic(abs, original);
  fs.rmSync(jp, { force: true });
  return { recovered: true, file: relPosix, restored_sha256: journal.original_sha256 };
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
    return { status: 'NO_MUTABLE_LINES', reason: 'no changed source line has an operator to flip or a statement that can be removed', total: 0, killed: 0, survived: 0, score: null, mutants: [] };
  }

  const results = [];
  for (const mutant of planned) {
    const abs = path.join(params.repoRoot, mutant.file);
    const originalBuf = fs.readFileSync(abs);
    const originalSha = sha256File(abs);
    const lines = originalBuf.toString('utf8').split('\n');
    // Re-locate on the current bytes and mutate only at the planned column, never at an earlier match.
    const hit = findMutation(lines[mutant.line - 1] ?? '', mutant.file);
    if (!hit || hit.op.id !== mutant.operator || hit.column !== mutant.column) {
      throw new Error(`MUTATION_PLAN_STALE: ${mutant.file}:${mutant.line} changed between planning and mutation.`);
    }
    lines[mutant.line - 1] = applyAt(lines[mutant.line - 1], hit.column, hit.length, hit.op.replace);

    const mutatedText = lines.join('\n');
    // Atomic, and with the mutated hash: recovery restores only a file still in the mutated state.
    writeAtomic(
      journalPath(params.journalDir),
      JSON.stringify({
        file: mutant.file,
        original_sha256: originalSha,
        mutated_sha256: sha256Text(mutatedText),
        original_base64: originalBuf.toString('base64'),
      }),
    );
    let killedBy = null;
    try {
      fs.writeFileSync(abs, mutatedText, 'utf8');
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
