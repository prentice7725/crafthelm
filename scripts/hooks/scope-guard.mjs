#!/usr/bin/env node
import { evaluateHookPayload } from '../lib/scope-guard.mjs';

/**
 * Claude Code `PreToolUse` hook for the file-writing tools.
 *
 * Reads the hook payload on stdin. Exit 0 lets the tool call proceed. Exit 2 blocks it, and the
 * text on stderr is what the agent is shown. Any failure inside the guard exits 0: a broken guard
 * must not stop work, and `verify` still checks the scope afterwards.
 */

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

try {
  const raw = await readStdin();
  const verdict = evaluateHookPayload(JSON.parse(raw));
  if (verdict.decision === 'deny') {
    process.stderr.write(`CraftHelm scope guard blocked this write (${verdict.code}): ${verdict.reason}\n`);
    process.exit(2);
  }
} catch (err) {
  process.stderr.write(`CraftHelm scope guard skipped: ${err.message}\n`);
}
process.exit(0);
