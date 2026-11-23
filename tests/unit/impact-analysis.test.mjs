import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runGit } from '../../scripts/lib/git.mjs';
import { analyzeImpact } from '../../scripts/lib/impact-analysis.mjs';
import { parseSourceModule } from '../../scripts/lib/impact-languages.mjs';
import { extractCommandTargets } from '../../scripts/lib/test-runners.mjs';

function createTempRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-impact-'));
  runGit(dir, ['init', '-b', 'main']);
  runGit(dir, ['config', 'user.name', 'CraftHelm Impact']);
  runGit(dir, ['config', 'user.email', 'impact@crafthelm.local']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'Baseline']);
  return dir;
}

describe('AST & Call-Graph Impact Analysis', () => {
  it('traces changed functions and classes transitively across A -> B -> C while ignoring unrelated D', () => {
    const repo = createTempRepo({
      'package.json': '{"name":"impact-demo","type":"module"}\n',
      'src/auth/token.mjs': [
        '// function fakeCommentCall() { helper(); }',
        'const tpl = `class FakeClass { method() {} }`;',
        'export class TokenManager {',
        '  refreshToken(user) {',
        '    return `${user}-v1`;',
        '  }',
        '  unrelatedMethod() {',
        '    return 0;',
        '  }',
        '}',
        'export function signToken(user) {',
        '  const tm = new TokenManager();',
        '  return tm.refreshToken(user);',
        '}',
      ].join('\n') + '\n',
      'src/session/session.mjs': [
        "import { signToken } from '../auth/token.mjs';",
        'export function createSession(user) {',
        '  return signToken(user);',
        '}',
      ].join('\n') + '\n',
      'src/api/signup.mjs': [
        "import { createSession } from '../session/session.mjs';",
        'export function registerUser(user) {',
        '  return createSession(user);',
        '}',
      ].join('\n') + '\n',
      'src/billing/invoice.mjs': [
        '// Same function name in unimported module must not cause false positive',
        'export function signToken() {',
        '  return "invoice-hash";',
        '}',
        'export function calcInvoice(n) {',
        '  return signToken() + n;',
        '}',
      ].join('\n') + '\n',
      'tests/signup.test.mjs': [
        "import assert from 'node:assert/strict';",
        "import { registerUser } from '../src/api/signup.mjs';",
        "assert.equal(registerUser('alice'), 'alice-v1');",
      ].join('\n') + '\n',
      'tests/auth.test.mjs': [
        "import assert from 'node:assert/strict';",
        "import { signToken } from '../src/auth/token.mjs';",
        "assert.equal(signToken('alice'), 'alice-v1');",
      ].join('\n') + '\n',
      'tests/billing.test.mjs': [
        "import assert from 'node:assert/strict';",
        "import { calcInvoice } from '../src/billing/invoice.mjs';",
        "assert.equal(calcInvoice(5), 'invoice-hash5');",
      ].join('\n') + '\n',
    });

    try {
      // Edit TokenManager.refreshToken only (line 5)
      const tokenPath = path.join(repo, 'src/auth/token.mjs');
      const updated = fs.readFileSync(tokenPath, 'utf8').replace('`${user}-v1`', '`${user}-v2`');
      fs.writeFileSync(tokenPath, updated, 'utf8');

      const impact = analyzeImpact(repo);
      assert.equal(impact.fallback_to_full, false);
      assert.deepEqual(impact.directly_changed_files, ['src/auth/token.mjs']);
      assert.ok(impact.directly_changed_classes.includes('src/auth/token.mjs::TokenManager'));
      assert.ok(impact.directly_changed_functions.includes('src/auth/token.mjs::TokenManager.refreshToken'));
      assert.equal(impact.directly_changed_functions.includes('src/auth/token.mjs::TokenManager.unrelatedMethod'), false);

      // Transitive call-graph propagation through signToken -> createSession -> registerUser
      assert.ok(impact.impacted_functions.includes('src/auth/token.mjs::signToken'));
      assert.ok(impact.impacted_functions.includes('src/session/session.mjs::createSession'));
      assert.ok(impact.impacted_functions.includes('src/api/signup.mjs::registerUser'));
      assert.equal(impact.impacted_functions.includes('src/billing/invoice.mjs::calcInvoice'), false);

      const selectedFiles = impact.selected_tests.map((t) => t.file);
      assert.ok(selectedFiles.includes('tests/auth.test.mjs'));
      assert.ok(selectedFiles.includes('tests/signup.test.mjs'));
      assert.equal(selectedFiles.includes('tests/billing.test.mjs'), false);
      assert.ok(impact.impacted_features.includes('auth'));
      assert.ok(impact.impacted_features.includes('signup'));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('triggers safe fallback_to_full on package.json or schema edits and when non-JS code changes', () => {
    const repo = createTempRepo({
      'package.json': '{"name":"fallback-demo","type":"module"}\n',
      'src/app.mjs': 'export const ok = true;\n',
      'tests/app.test.mjs': "import '../src/app.mjs';\n",
    });

    try {
      fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"fallback-demo","type":"module","version":"0.2.0"}\n', 'utf8');
      const impactGlobal = analyzeImpact(repo);
      assert.equal(impactGlobal.fallback_to_full, true);
      assert.match(impactGlobal.fallback_reason, /package\.json/);
      assert.equal(impactGlobal.recommended_test_command, null);

      // Revert package.json and add unparsed .sql file in src/
      runGit(repo, ['checkout', '--', 'package.json']);
      fs.writeFileSync(path.join(repo, 'src/migration.sql'), 'CREATE TABLE t(id INT);\n', 'utf8');
      const impactSql = analyzeImpact(repo);
      assert.equal(impactSql.fallback_to_full, true);
      assert.match(impactSql.fallback_reason, /migration\.sql/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('traces Python call graphs, ignores docstrings, recommends pytest, and falls back on pyproject.toml', () => {
    const repo = createTempRepo({
      'pyproject.toml': '[project]\nname = "py-demo"\n',
      'src/auth/token.py': [
        '# def comment_only(): pass',
        '"""',
        'class DocstringFake:',
        '    def fake(self): pass',
        '"""',
        'class TokenManager:',
        '    def refresh_token(self, user):',
        '        return f"{user}-v1"',
        '    def unrelated(self):',
        '        return 0',
        '',
        'def sign_token(user):',
        '    tm = TokenManager()',
        '    return tm.refresh_token(user)',
      ].join('\n') + '\n',
      'src/session/session.py': [
        'from src.auth.token import sign_token',
        '',
        'def create_session(user):',
        '    return sign_token(user)',
      ].join('\n') + '\n',
      'src/billing/invoice.py': [
        'def calc_total(x):',
        '    return x * 2',
      ].join('\n') + '\n',
      'tests/test_session.py': [
        'from src.session.session import create_session',
        '',
        'def test_create_session():',
        '    assert create_session("alice") == "alice-v2"',
      ].join('\n') + '\n',
      'tests/test_billing.py': [
        'from src.billing.invoice import calc_total',
        '',
        'def test_billing():',
        '    assert calc_total(3) == 6',
      ].join('\n') + '\n',
    });

    try {
      const tokenPath = path.join(repo, 'src/auth/token.py');
      fs.writeFileSync(tokenPath, fs.readFileSync(tokenPath, 'utf8').replace('{user}-v1', '{user}-v2'), 'utf8');

      const impact = analyzeImpact(repo);
      assert.equal(impact.fallback_to_full, false);
      assert.ok(impact.languages_detected.includes('python'));
      assert.equal(impact.test_runner, 'pytest');
      assert.ok(impact.directly_changed_functions.includes('src/auth/token.py::TokenManager.refresh_token'));
      assert.equal(impact.directly_changed_functions.includes('src/auth/token.py::DocstringFake.fake'), false);
      assert.equal(impact.directly_changed_functions.includes('src/auth/token.py::TokenManager.unrelated'), false);
      assert.ok(impact.impacted_functions.includes('src/auth/token.py::sign_token'));
      assert.ok(impact.impacted_functions.includes('src/session/session.py::create_session'));
      assert.deepEqual(impact.selected_tests.map((t) => t.file), ['tests/test_session.py']);
      assert.equal(impact.recommended_test_command, 'pytest tests/test_session.py');

      fs.writeFileSync(path.join(repo, 'pyproject.toml'), '[project]\nname = "py-demo"\nversion = "0.2.0"\n', 'utf8');
      const fallback = analyzeImpact(repo);
      assert.equal(fallback.fallback_to_full, true);
      assert.match(fallback.fallback_reason, /pyproject\.toml/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('traces Go same-package and cross-package imports and builds go test package commands', () => {
    const repo = createTempRepo({
      'go.mod': 'module example.com/app\n\ngo 1.23\n',
      'auth/token.go': [
        'package auth',
        '',
        'func SignToken(user string) string {',
        '  return user + "-v1"',
        '}',
      ].join('\n') + '\n',
      'auth/token_test.go': [
        'package auth',
        '',
        'func TestSignToken() {',
        '  _ = SignToken("alice")',
        '}',
      ].join('\n') + '\n',
      'session/session.go': [
        'package session',
        'import "example.com/app/auth"',
        '',
        'func CreateSession(user string) string {',
        '  return auth.SignToken(user)',
        '}',
      ].join('\n') + '\n',
      'session/session_test.go': [
        'package session',
        '',
        'func TestCreateSession() {',
        '  _ = CreateSession("alice")',
        '}',
      ].join('\n') + '\n',
      'billing/billing_test.go': [
        'package billing',
        '',
        'func TestBilling() {}',
      ].join('\n') + '\n',
    });

    try {
      const tokenPath = path.join(repo, 'auth/token.go');
      fs.writeFileSync(tokenPath, fs.readFileSync(tokenPath, 'utf8').replace('"-v1"', '"-v2"'), 'utf8');

      const impact = analyzeImpact(repo);
      assert.equal(impact.fallback_to_full, false);
      assert.ok(impact.languages_detected.includes('go'));
      assert.equal(impact.test_runner, 'go-test');
      assert.ok(impact.directly_changed_functions.includes('auth/token.go::SignToken'));
      assert.ok(impact.impacted_functions.includes('session/session.go::CreateSession'));
      assert.deepEqual(impact.selected_tests.map((t) => t.file), ['auth/token_test.go', 'session/session_test.go']);
      assert.equal(impact.recommended_test_command, 'go test ./auth ./session');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('traces Rust crate/impl methods and recommends targeted cargo test integration targets', () => {
    const repo = createTempRepo({
      'Cargo.toml': '[package]\nname = "my-app"\nversion = "0.1.0"\n',
      'src/lib.rs': 'pub mod auth;\npub mod billing;\n',
      'src/auth.rs': [
        'pub struct TokenManager;',
        'impl TokenManager {',
        '    pub fn refresh(&self) -> &str {',
        '        "v1"',
        '    }',
        '}',
        'pub fn sign() -> &str {',
        '    let tm = TokenManager;',
        '    tm.refresh()',
        '}',
      ].join('\n') + '\n',
      'src/billing.rs': 'pub fn total() -> i32 { 42 }\n',
      'tests/auth_test.rs': [
        'use my_app::auth::sign;',
        'fn test_sign() { let _ = sign(); }',
      ].join('\n') + '\n',
      'tests/billing_test.rs': [
        'use my_app::billing::total;',
        'fn test_total() { let _ = total(); }',
      ].join('\n') + '\n',
    });

    try {
      const authPath = path.join(repo, 'src/auth.rs');
      fs.writeFileSync(authPath, fs.readFileSync(authPath, 'utf8').replace('"v1"', '"v2"'), 'utf8');

      const impact = analyzeImpact(repo);
      assert.equal(impact.fallback_to_full, false);
      assert.equal(impact.test_runner, 'cargo-test');
      assert.ok(impact.directly_changed_functions.includes('src/auth.rs::TokenManager.refresh'));
      assert.ok(impact.impacted_functions.includes('src/auth.rs::sign'));
      assert.deepEqual(impact.selected_tests.map((t) => t.file), ['tests/auth_test.rs']);
      assert.equal(impact.recommended_test_command, 'cargo test --test auth_test');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('supports polyglot Java/C#/C++/Ruby/PHP analysis and hybrid custom external analyzers', () => {
    const repo = createTempRepo({
      'src/main/java/com/acme/AuthService.java': [
        'package com.acme;',
        'public class AuthService {',
        '  public String issue() { return "a1"; }',
        '}',
      ].join('\n') + '\n',
      'src/test/java/com/acme/AuthServiceTest.java': [
        'package com.acme;',
        'public class AuthServiceTest {',
        '  void verifies() { new AuthService().issue(); }',
        '}',
      ].join('\n') + '\n',
      'pom.xml': '<project></project>\n',
      'include/calc.hpp': 'int computeVal(int x);\n',
      'src/calc.cpp': [
        '#include "calc.hpp"',
        'int computeVal(int x) { return x + 1; }',
      ].join('\n') + '\n',
      'tests/calc_test.cpp': [
        '#include "calc.hpp"',
        'int main() { return computeVal(1) == 2 ? 0 : 1; }',
      ].join('\n') + '\n',
      'lib/helper.rb': 'class Helper\n  def greet\n    "hi"\n  end\nend\n',
      'spec/helper_spec.rb': "require_relative '../lib/helper'\ndef run_spec\n  Helper.new.greet\nend\n",
      'src/User.php': '<?php\nnamespace App;\nclass User {\n  public function name() { return "u1"; }\n}\n',
      'tests/UserTest.php': '<?php\nuse App\\User;\nfunction testUser() { $u = new User(); return $u->name(); }\n',
      'src/Greeter.cs': 'namespace App { public class Greeter { public string Hi() { return "hi"; } } }\n',
      'tests/GreeterTests.cs': 'using App;\npublic class GreeterTests { public void Test() { new Greeter().Hi(); } }\n',
    });

    try {
      fs.writeFileSync(path.join(repo, 'src/main/java/com/acme/AuthService.java'), 'package com.acme;\npublic class AuthService {\n  public String issue() { return "a2"; }\n}\n', 'utf8');
      fs.writeFileSync(path.join(repo, 'src/calc.cpp'), '#include "calc.hpp"\nint computeVal(int x) { return x + 2; }\n', 'utf8');
      fs.writeFileSync(path.join(repo, 'lib/helper.rb'), 'class Helper\n  def greet\n    "hello"\n  end\nend\n', 'utf8');
      fs.writeFileSync(path.join(repo, 'src/User.php'), '<?php\nnamespace App;\nclass User {\n  public function name() { return "u2"; }\n}\n', 'utf8');
      fs.writeFileSync(path.join(repo, 'src/Greeter.cs'), 'namespace App { public class Greeter { public string Hi() { return "hey"; } } }\n', 'utf8');

      const poly = analyzeImpact(repo);
      assert.equal(poly.fallback_to_full, false);
      const selected = poly.selected_tests.map((t) => t.file);
      for (const expectedTest of [
        'src/test/java/com/acme/AuthServiceTest.java',
        'tests/calc_test.cpp',
        'spec/helper_spec.rb',
        'tests/UserTest.php',
        'tests/GreeterTests.cs',
      ]) {
        assert.ok(selected.includes(expectedTest), `Expected ${expectedTest} in selected tests`);
      }
      assert.ok(poly.recommended_test_commands.some((c) => c.runner === 'maven' && c.command.includes('AuthServiceTest')));
      assert.ok(poly.recommended_test_commands.some((c) => c.runner === 'ctest' && c.command.includes('calc_test')));
      assert.ok(poly.recommended_test_commands.some((c) => c.runner === 'rspec' && c.command.includes('helper_spec.rb')));
      assert.ok(poly.recommended_test_commands.some((c) => c.runner === 'phpunit' && c.command.includes('UserTest.php')));
      assert.ok(poly.recommended_test_commands.some((c) => c.runner === 'dotnet-test' && c.command.includes('GreeterTests')));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }

    // Custom hybrid analyzer plugin for an otherwise unsupported language (.zig)
    const zigRepo = createTempRepo({
      'src/auth.zig': 'pub fn token() i32 { return 1; }\n',
      'tests/auth_test.zig': 'const auth = @import("auth"); pub fn testToken() void { _ = auth.token(); }\n',
      'tests/billing_test.zig': 'pub fn testBilling() void {}\n',
    });
    const helperPath = path.join(os.tmpdir(), `crafthelm-zig-analyzer-${Date.now()}.mjs`);
    try {
      fs.writeFileSync(
        helperPath,
        [
          'const data = {',
          '  modules: [',
          '    { file: "src/auth.zig", language: "zig", imports: [], importBindings: [], classes: [], functions: [{ name: "token", qualified_name: "src/auth.zig::token", class_name: null, file: "src/auth.zig", start_line: 1, end_line: 1, exported: true, calls: [] }], moduleCalls: [] },',
          '    { file: "tests/auth_test.zig", language: "zig", imports: ["src/auth.zig"], importBindings: [], classes: [], functions: [{ name: "testToken", qualified_name: "tests/auth_test.zig::testToken", class_name: null, file: "tests/auth_test.zig", start_line: 1, end_line: 1, exported: true, calls: [{ kind: "direct", object: null, name: "token", line: 1 }] }], moduleCalls: [] },',
          '    { file: "tests/billing_test.zig", language: "zig", imports: [], importBindings: [], classes: [], functions: [], moduleCalls: [] },',
          '  ],',
          '};',
          'process.stdout.write(JSON.stringify(data));',
        ].join('\n'),
        'utf8',
      );
      fs.writeFileSync(path.join(zigRepo, 'src/auth.zig'), 'pub fn token() i32 { return 2; }\n', 'utf8');

      const hybrid = analyzeImpact(zigRepo, {
        customAnalyzerCmd: `node "${helperPath.replace(/\\/g, '/')}"`,
        testCommandTemplate: 'zig test {files}',
      });
      assert.equal(hybrid.analyzer_source, 'hybrid');
      assert.equal(hybrid.fallback_to_full, false);
      assert.deepEqual(hybrid.selected_tests.map((t) => t.file), ['tests/auth_test.zig']);
      assert.equal(hybrid.recommended_test_command, 'zig test tests/auth_test.zig');
    } finally {
      fs.rmSync(helperPath, { force: true });
      fs.rmSync(zigRepo, { recursive: true, force: true });
    }
  });

  it('ignores working-tree .crafthelm/config.json tampering and enforces mandatory fallbacks on custom analyzers', () => {
    const repo = createTempRepo({
      'package.json': '{"name":"tamper-demo","type":"module"}\n',
      'src/a.mjs': 'export const a = () => 1;\n',
      'tests/a.test.mjs': "import { a } from '../src/a.mjs'; a();\n",
    });
    const fakeAnalyzer = path.join(os.tmpdir(), `crafthelm-fake-analyzer-${Date.now()}.mjs`);
    try {
      fs.writeFileSync(
        fakeAnalyzer,
        [
          'process.stdout.write(JSON.stringify({',
          '  schema_version: "0.3", base_ref: "HEAD",',
          '  directly_changed_files: [], directly_changed_functions: [], directly_changed_classes: [],',
          '  impacted_functions: [], impacted_files: [], impacted_features: [],',
          '  test_candidates: ["tests/a.test.mjs"], selected_tests: [],',
          '  unselected_tests: [{ file: "tests/a.test.mjs", reason: "none" }],',
          '  recommended_test_command: null, fallback_to_full: false, fallback_reason: null,',
          '  graph_stats: { files_parsed: 0, functions_indexed: 0, classes_indexed: 0, import_edges: 0, call_edges: 0 },',
          '  analyzed_at: "2026-11-21T00:00:00Z"',
          '}));',
        ].join('\n'),
        'utf8',
      );
      const fakeCmd = `node "${fakeAnalyzer.replace(/\\/g, '/')}"`;

      // Untrusted candidate working-tree config must not activate a custom analyzer or bypass baseline
      fs.mkdirSync(path.join(repo, '.crafthelm'), { recursive: true });
      fs.writeFileSync(
        path.join(repo, '.crafthelm/config.json'),
        JSON.stringify({ verification_policy: { custom_impact_analyzer: fakeCmd } }),
        'utf8',
      );
      fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"tamper-demo","version":"2.0.0"}\n', 'utf8');

      const fromUntrustedTree = analyzeImpact(repo);
      assert.equal(fromUntrustedTree.analyzer_source, 'builtin_polyglot');
      assert.equal(fromUntrustedTree.fallback_to_full, true);
      assert.match(fromUntrustedTree.fallback_reason, /package\.json/);

      // Even when a custom analyzer is explicitly configured/approved, mandatory global fallback still holds
      const fromTrustedCustom = analyzeImpact(repo, { customAnalyzerCmd: fakeCmd });
      assert.equal(fromTrustedCustom.analyzer_source, 'custom_analyzer');
      assert.equal(fromTrustedCustom.fallback_to_full, true);
      assert.match(fromTrustedCustom.fallback_reason, /package\.json/);
      assert.equal(fromTrustedCustom.recommended_test_command, null);
    } finally {
      fs.rmSync(fakeAnalyzer, { force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('tracks git-tracked files under bin/ and forces fallback when ignored directories are modified', () => {
    const repo = createTempRepo({
      'bin/cli.js': 'export function runCli() { return 1; }\n',
      'src/a.mjs': 'export const a = () => 1;\n',
      'generated/code.js': 'export const g = () => 1;\n',
      'tests/cli.test.mjs': "import { runCli } from '../bin/cli.js'; runCli();\n",
      'tests/a.test.mjs': "import { a } from '../src/a.mjs'; a();\n",
    });
    try {
      fs.writeFileSync(path.join(repo, 'bin/cli.js'), 'export function runCli() { return 2; }\n', 'utf8');
      fs.writeFileSync(path.join(repo, 'src/a.mjs'), 'export const a = () => 2;\n', 'utf8');

      const res = analyzeImpact(repo);
      assert.equal(res.fallback_to_full, false);
      const selected = res.selected_tests.map((t) => t.file);
      assert.ok(selected.includes('tests/cli.test.mjs'));
      assert.ok(selected.includes('tests/a.test.mjs'));

      // Modifying a file inside an ignored directory forces full verification
      fs.writeFileSync(path.join(repo, 'generated/code.js'), 'export const g = () => 2;\n', 'utf8');
      const resIgnored = analyzeImpact(repo, { ignoredDirs: ['generated'] });
      assert.equal(resIgnored.fallback_to_full, true);
      assert.match(resIgnored.fallback_reason, /generated\/code\.js/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('handles Ruby inline assignment blocks and restricts command symbol flags to matching test runners', () => {
    const rubyCode = [
      'class Token',
      '  def refresh(x)',
      '    val = if x > 0',
      '      x + 1',
      '    else',
      '      0',
      '    end',
      '    return nil if val.nil?',
      '    val + 10',
      '  end',
      'end',
    ].join('\n');
    const ast = parseSourceModule('lib/token.rb', rubyCode, process.cwd());
    const refreshFn = ast.functions.find((f) => f.name === 'refresh');
    assert.ok(refreshFn);
    assert.equal(refreshFn.start_line, 2);
    assert.equal(refreshFn.end_line, 10);

    const cpTargets = extractCommandTargets('cp -R src dst');
    assert.deepEqual(cpTargets.symbols, []);

    const chainedTargets = extractCommandTargets('cp -R src dst && pytest -k test_billing');
    assert.deepEqual(chainedTargets.symbols, ['test_billing']);
  });
});
