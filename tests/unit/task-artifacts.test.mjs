import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { peerArtifactHashes, writeTaskReceipt } from '../../scripts/lib/task-artifacts.mjs';

function writeContract(repo, taskId, body = { task_id: taskId }) {
  const file = path.join(repo, '.crafthelm', 'contracts', `${taskId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body), 'utf8');
}

const receipt = (docsDir) => ({ docs_dir: docsDir, docs: { 'acceptance.md': 'a'.repeat(64) }, contract: 'c'.repeat(64) });

describe('Peer task receipts only exempt what an interview could have written', () => {
  it('accepts a real peer under docs/ and ignores receipts that point elsewhere or have no contract', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-peer-'));
    try {
      writeContract(repo, 'PEER');
      writeTaskReceipt(repo, 'PEER', receipt('docs/tasks/PEER'));

      // Forged: docs_dir outside docs/, an escaping path, a receipt without a contract, a mismatched contract.
      writeContract(repo, 'SRC');
      writeTaskReceipt(repo, 'SRC', receipt('src'));
      writeContract(repo, 'ESC');
      writeTaskReceipt(repo, 'ESC', receipt('docs/../src'));
      writeTaskReceipt(repo, 'GHOST', receipt('docs/tasks/GHOST'));
      writeContract(repo, 'MISMATCH', { task_id: 'OTHER' });
      writeTaskReceipt(repo, 'MISMATCH', receipt('docs/tasks/MISMATCH'));

      const hashes = peerArtifactHashes(repo, 'CURRENT');
      assert.deepEqual([...hashes.keys()].sort(), ['.crafthelm/contracts/PEER.json', 'docs/tasks/PEER/acceptance.md']);

      // The current task never exempts its own files.
      assert.equal(peerArtifactHashes(repo, 'PEER').size, 0);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
