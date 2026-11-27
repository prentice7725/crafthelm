#!/usr/bin/env node
import { describeSessionStatus } from '../lib/scope-guard.mjs';

/**
 * Claude Code `SessionStart` and `UserPromptSubmit` hook.
 *
 * What it prints on stdout is added to the agent's context. A skill is read once, when invoked;
 * this repeats the part that must hold on every later turn: which run is open and what it may touch.
 * It reads checkpoints and contracts only. It never hashes the tree, so it stays fast in a large
 * repository, and any failure prints nothing and exits 0.
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
  const payload = JSON.parse(await readStdin());
  const text = describeSessionStatus({
    cwd: typeof payload.cwd === 'string' ? payload.cwd : process.cwd(),
    event: payload.hook_event_name,
  });
  if (text) process.stdout.write(`${text}\n`);
} catch {
  // Saying nothing is the safe failure for a reminder.
}
process.exit(0);
