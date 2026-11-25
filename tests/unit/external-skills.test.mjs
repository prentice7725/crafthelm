import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { sha256Text } from '../../scripts/lib/crypto.mjs';
import { CRAFTHELM_ROOT } from '../../scripts/lib/paths.mjs';
import { auditSkillDirectory, listSkills } from '../../scripts/skills.mjs';

const readLf = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

describe('vendored ponytail rules', () => {
  const entry = listSkills().find((e) => e.id === 'ponytail');
  const vendoredDir = path.join(CRAFTHELM_ROOT, 'external-skills', 'ponytail');

  it('is approved, pinned to a commit, and matches the vendored AGENTS.md digest', () => {
    assert.ok(entry, 'registry has a ponytail entry');
    assert.equal(entry.status, 'approved');
    assert.match(entry.commit_or_release, /@[a-f0-9]{40}$/);
    assert.equal(entry.vendored_path, 'external-skills/ponytail/AGENTS.md');
    assert.equal(sha256Text(readLf(path.join(CRAFTHELM_ROOT, entry.vendored_path))), entry.files_digest);
    assert.equal(fs.existsSync(path.join(vendoredDir, 'LICENSE')), true);
  });

  it('vendors rules only: no scripts or hooks, and passes the static audit on every host', () => {
    assert.deepEqual(fs.readdirSync(vendoredDir).sort(), ['AGENTS.md', 'LICENSE', 'NOTICE.md']);
    for (const host of ['claude', 'codex', 'antigravity', 'generic']) {
      const res = auditSkillDirectory(vendoredDir, { host });
      assert.equal(res.ok, true, `${host}: ${JSON.stringify(res.blocks)}`);
    }
  });

  it('is applied in the implementation stage with the contract taking precedence, in every host copy', () => {
    const source = readLf(path.join(CRAFTHELM_ROOT, 'skills', 'implement', 'SKILL.md'));
    assert.match(source, /external-skills\/ponytail\/AGENTS\.md/);
    assert.match(source, /acceptance checks are required/);
    assert.match(source, /`not_run`/);
    for (const host of ['claude', 'codex', 'antigravity']) {
      const copy = readLf(path.join(CRAFTHELM_ROOT, 'hosts', host, 'skills', 'crafthelm', 'references', 'implement.md'));
      assert.equal(copy, source, `${host} implement reference is stale`);
    }
  });
});
