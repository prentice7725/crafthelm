import fs from 'node:fs';
import path from 'node:path';
import { getRunDir } from './paths.mjs';

/**
 * The single-writer lock of a run, as seen by the steps that rewrite run state.
 *
 * The lock is taken with `checkpoint acquire-lock` and names a writer, not a process: the command
 * that takes it exits at once, so the PID it records is never alive and cannot tell a held lock from
 * an abandoned one. A lock left behind is cleared by a person with `checkpoint release-lock --force`.
 */

export function writerLockPath(repoRoot, runId) {
  return path.join(getRunDir(repoRoot, runId), 'writer.lock.json');
}

/**
 * @param {string} repoRoot
 * @param {string} runId
 * @returns {{ writer_id?: string, acquired_at?: string }|null} the lock, or null when none is held
 */
export function readWriterLock(repoRoot, runId) {
  const lockPath = writerLockPath(repoRoot, runId);
  if (!fs.existsSync(lockPath)) return null;
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return lock && typeof lock === 'object' ? lock : {};
  } catch {
    // An unreadable lock still means someone took it.
    return {};
  }
}

export function describeLockRelease(runId) {
  return `checkpoint release-lock --run-id ${runId} --force`;
}

/**
 * Refuse to rewrite run state while another writer holds the lock. The holder passes its own
 * writer id and goes through.
 * @param {string} repoRoot
 * @param {string} runId
 * @param {string|undefined} writer
 * @param {string} action what the caller is about to do, for the message
 */
export function assertNoForeignWriterLock(repoRoot, runId, writer, action) {
  const lock = readWriterLock(repoRoot, runId);
  if (!lock) return;
  if (writer && lock.writer_id === writer) return;
  const holder = lock.writer_id ?? 'unknown';
  throw new Error(
    `CONCURRENT_WRITER_BLOCKED: cannot ${action} run ${runId} while writer "${holder}" holds its lock`
    + `${lock.acquired_at ? ` (since ${lock.acquired_at})` : ''}. `
    + `The holder passes --writer ${holder}; if the lock was left behind, clear it with: ${describeLockRelease(runId)}`,
  );
}
