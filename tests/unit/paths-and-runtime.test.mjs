import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkContractReadiness } from '../../scripts/contract.mjs';
import { MIN_NODE_MAJOR, describeUnsupportedNode } from '../../scripts/crafthelm.mjs';
import { matchGlob, matchesAnyGlob, unsupportedGlobSyntax } from '../../scripts/lib/paths.mjs';

describe('Scope globs: the supported syntax, and a warning for the rest', () => {
  it('matches **, *, ? and a trailing slash, and treats everything else literally', () => {
    assert.equal(matchGlob('src/a/b/c.mjs', 'src/**'), true);
    assert.equal(matchGlob('src/a/b/c.mjs', 'src/**/*.mjs'), true);
    assert.equal(matchGlob('src/c.mjs', 'src/**/*.mjs'), true);
    assert.equal(matchGlob('src/a/c.mjs', 'src/*.mjs'), false);
    assert.equal(matchGlob('src/a1.mjs', 'src/a?.mjs'), true);
    assert.equal(matchGlob('src/a/1.mjs', 'src/a?1.mjs'), false);
    assert.equal(matchGlob('docs/guide/x.md', 'docs/'), true);
    assert.equal(matchGlob('docs2/x.md', 'docs/'), false);
    // A bare directory name is one path, not a prefix.
    assert.equal(matchGlob('src/a.mjs', 'src'), false);
    // Windows separators and a leading ./ are normalised on both sides.
    assert.equal(matchGlob('src\\a\\b.mjs', './src/**'), true);
    // Regex metacharacters and square brackets are literal.
    assert.equal(matchGlob('pages/[id].tsx', 'pages/[id].tsx'), true);
    assert.equal(matchGlob('pages/i.tsx', 'pages/[id].tsx'), false);
    assert.equal(matchGlob('a+b.txt', 'a+b.txt'), true);
    assert.equal(matchGlob('aab.txt', 'a+b.txt'), false);
    assert.equal(matchesAnyGlob('lib/x.mjs', ['src/**', 'lib/**']), true);
    assert.equal(matchesAnyGlob('lib/x.mjs', []), false);
  });

  it('names negation and brace alternation as unsupported, because they would match nothing', () => {
    assert.equal(matchGlob('src/a.mjs', '{src,lib}/**'), false);
    assert.match(unsupportedGlobSyntax('{src,lib}/**'), /brace/);
    assert.match(unsupportedGlobSyntax('!src/generated/**'), /negation/);
    assert.equal(unsupportedGlobSyntax('src/**/*.mjs'), null);
    assert.equal(unsupportedGlobSyntax('pages/[id].tsx'), null);
    assert.equal(unsupportedGlobSyntax('templates/{name}.txt'), null);
  });

  it('holds a contract back from approval readiness when a scope pattern is unsupported', () => {
    const contract = {
      change_kind: 'docs',
      scope: { allow: ['docs/**'], protect: ['{migrations,infra}/**'] },
      acceptance: [{ id: 'AC-01', requirement: 'REQ-01', kind: 'fast', command: 'node --version' }],
    };
    const res = checkContractReadiness(contract);
    assert.equal(res.policy_ready, false);
    assert.deepEqual(res.warnings.map((w) => w.code), ['SCOPE_GLOB_UNSUPPORTED']);
    assert.match(res.warnings[0].message, /scope\.protect .* protect nothing/);

    contract.scope.protect = ['migrations/**', 'infra/**'];
    assert.equal(checkContractReadiness(contract).policy_ready, true);
  });
});

describe('Node.js runtime check in the CLI dispatcher', () => {
  it('explains an old runtime in one line and stays silent on a supported one', () => {
    assert.equal(describeUnsupportedNode(`${MIN_NODE_MAJOR}.0.0`), null);
    assert.equal(describeUnsupportedNode('25.1.0'), null);
    assert.equal(describeUnsupportedNode(), null);
    const message = describeUnsupportedNode('22.11.0');
    assert.match(message, /needs Node\.js 24 or newer; this is 22\.11\.0/);
    assert.match(message, /nvm install 24/);
  });
});
