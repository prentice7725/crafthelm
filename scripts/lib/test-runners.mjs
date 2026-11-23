import fs from 'node:fs';
import path from 'node:path';
import { detectLanguageForFile } from './impact-languages.mjs';
import { toPosixPath } from './paths.mjs';

function detectJsRunner(repoRoot) {
  const pkgPath = path.join(repoRoot, 'package.json');
  const hasBunLock = fs.existsSync(path.join(repoRoot, 'bun.lock')) || fs.existsSync(path.join(repoRoot, 'bun.lockb'));
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const testScript = String(pkg.scripts?.test ?? '');
      if (deps.vitest || /\bvitest\b/.test(testScript)) return 'vitest';
      if (deps.jest || /\bjest\b/.test(testScript)) return 'jest';
      if (deps.mocha || /\bmocha\b/.test(testScript)) return 'mocha';
      if (deps.ava || /\bava\b/.test(testScript)) return 'ava';
    } catch {
      // Ignore invalid package.json
    }
  }
  if (hasBunLock) return 'bun-test';
  return 'node-test';
}

function detectJvmRunner(repoRoot) {
  if (fs.existsSync(path.join(repoRoot, 'pom.xml'))) return 'maven';
  if (fs.existsSync(path.join(repoRoot, 'build.gradle')) || fs.existsSync(path.join(repoRoot, 'build.gradle.kts'))) {
    return 'gradle';
  }
  return 'maven';
}

/**
 * Detect programming languages and test runners present in a target repository.
 * @param {string} repoRoot
 * @param {string[]} allRepoFiles
 * @returns {{ languages: string[], runners: string[] }}
 */
export function detectRepoTestRunners(repoRoot, allRepoFiles) {
  const absRoot = path.resolve(repoRoot);
  const files = allRepoFiles.map(toPosixPath);
  const fileSet = new Set(files);
  const langSet = new Set();
  for (const rel of files) {
    const lang = detectLanguageForFile(rel);
    if (lang) langSet.add(lang);
  }

  const runners = new Set();
  if (langSet.has('javascript') || langSet.has('typescript') || fileSet.has('package.json')) {
    runners.add(detectJsRunner(absRoot));
  }
  if (langSet.has('python') || fileSet.has('pyproject.toml') || fileSet.has('pytest.ini')) {
    runners.add('pytest');
  }
  if (langSet.has('go') || fileSet.has('go.mod')) {
    runners.add('go-test');
  }
  if (langSet.has('rust') || fileSet.has('Cargo.toml')) {
    runners.add('cargo-test');
  }
  if (langSet.has('java') || langSet.has('kotlin') || fileSet.has('pom.xml') || fileSet.has('build.gradle') || fileSet.has('build.gradle.kts')) {
    runners.add(detectJvmRunner(absRoot));
  }
  if (langSet.has('csharp') || files.some((f) => f.endsWith('.csproj') || f.endsWith('.sln'))) {
    runners.add('dotnet-test');
  }
  if (langSet.has('ruby') || fileSet.has('Gemfile')) {
    if (files.some((f) => f.endsWith('_spec.rb') || f.startsWith('spec/'))) runners.add('rspec');
    else runners.add('minitest');
  }
  if (langSet.has('php') || fileSet.has('composer.json')) {
    runners.add('phpunit');
  }
  if (langSet.has('c_cpp') || fileSet.has('CMakeLists.txt')) {
    runners.add('ctest');
  }

  return {
    languages: [...langSet].sort(),
    runners: [...runners].sort(),
  };
}

function applyCommandTemplate(template, files) {
  const joined = files.join(' ');
  return String(template).replace(/\{(?:files|tests)\}/g, joined).trim();
}

function buildCommandForGroup(repoRoot, groupLang, files) {
  const list = [...new Set(files.map(toPosixPath))].sort();
  if (groupLang === 'javascript' || groupLang === 'typescript') {
    const runner = detectJsRunner(repoRoot);
    const prefixMap = {
      vitest: 'npx vitest run',
      jest: 'npx jest',
      mocha: 'npx mocha',
      ava: 'npx ava',
      'bun-test': 'bun test',
      'node-test': 'node --test',
    };
    return { language: groupLang, runner, command: `${prefixMap[runner] ?? 'node --test'} ${list.join(' ')}`, tests: list };
  }
  if (groupLang === 'python') {
    return { language: 'python', runner: 'pytest', command: `pytest ${list.join(' ')}`, tests: list };
  }
  if (groupLang === 'go') {
    const dirs = [...new Set(list.map((f) => path.posix.dirname(f)).map((d) => (d === '.' ? '.' : `./${d}`)))].sort();
    return { language: 'go', runner: 'go-test', command: `go test ${dirs.join(' ')}`, tests: list };
  }
  if (groupLang === 'rust') {
    const integTargets = [];
    for (const f of list) {
      const m = f.match(/^tests\/([^/]+)\.rs$/);
      if (m) integTargets.push(`--test ${m[1]}`);
    }
    const cmd = integTargets.length > 0 ? `cargo test ${integTargets.join(' ')}` : 'cargo test';
    return { language: 'rust', runner: 'cargo-test', command: cmd, tests: list };
  }
  if (groupLang === 'java' || groupLang === 'kotlin') {
    const runner = detectJvmRunner(repoRoot);
    const classes = [...new Set(list.map((f) => path.posix.basename(f).replace(/\.(?:java|kt|kts)$/i, '')))].sort();
    if (runner === 'maven') {
      return { language: groupLang, runner: 'maven', command: `mvn test -Dtest=${classes.join(',')}`, tests: list };
    }
    const bin = fs.existsSync(path.join(repoRoot, 'gradlew')) ? './gradlew' : 'gradle';
    return {
      language: groupLang,
      runner: 'gradle',
      command: `${bin} test ${classes.map((c) => `--tests ${c}`).join(' ')}`,
      tests: list,
    };
  }
  if (groupLang === 'csharp') {
    const classes = [...new Set(list.map((f) => path.posix.basename(f, '.cs')))].sort();
    const filter = classes.map((c) => `FullyQualifiedName~${c}`).join('|');
    return { language: 'csharp', runner: 'dotnet-test', command: `dotnet test --filter "${filter}"`, tests: list };
  }
  if (groupLang === 'ruby') {
    const hasSpec = list.some((f) => f.endsWith('_spec.rb'));
    if (hasSpec) {
      const bin = fs.existsSync(path.join(repoRoot, 'Gemfile')) ? 'bundle exec rspec' : 'rspec';
      return { language: 'ruby', runner: 'rspec', command: `${bin} ${list.join(' ')}`, tests: list };
    }
    return { language: 'ruby', runner: 'minitest', command: `ruby -Itest ${list.join(' ')}`, tests: list };
  }
  if (groupLang === 'php') {
    const bin = fs.existsSync(path.join(repoRoot, 'vendor', 'bin', 'phpunit')) ? './vendor/bin/phpunit' : 'phpunit';
    return { language: 'php', runner: 'phpunit', command: `${bin} ${list.join(' ')}`, tests: list };
  }
  if (groupLang === 'c_cpp') {
    const stems = [...new Set(list.map((f) => path.posix.basename(f).replace(/\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/i, '')))].sort();
    return { language: 'c_cpp', runner: 'ctest', command: `ctest --output-on-failure -R "${stems.join('|')}"`, tests: list };
  }
  return null;
}

/**
 * Build selective regression test command(s) across one or more detected languages/runners.
 * @param {string} repoRoot
 * @param {string[]} selectedTestFiles
 * @param {{ testCommandTemplate?: string, testCommandTemplates?: Record<string, string>, detectedRunners?: string[] }} [options]
 */
export function buildSelectiveTestCommands(repoRoot, selectedTestFiles, options = {}) {
  const files = [...new Set((selectedTestFiles ?? []).map(toPosixPath))].sort();
  if (files.length === 0) {
    return {
      primaryRunner: options.detectedRunners?.[0] ?? null,
      commands: [],
      recommendedCommand: null,
    };
  }

  if (options.testCommandTemplate) {
    const cmd = applyCommandTemplate(options.testCommandTemplate, files);
    const firstLang = detectLanguageForFile(files[0]) ?? 'custom';
    return {
      primaryRunner: 'custom',
      commands: [{ language: firstLang, runner: 'custom', command: cmd, tests: files }],
      recommendedCommand: cmd,
    };
  }

  const grouped = new Map();
  for (const f of files) {
    const lang = detectLanguageForFile(f) ?? 'custom';
    const key = (lang === 'javascript' || lang === 'typescript') ? 'js_ts' : (lang === 'java' || lang === 'kotlin') ? 'jvm' : lang;
    if (!grouped.has(key)) grouped.set(key, { rawLangs: new Set(), files: [] });
    grouped.get(key).rawLangs.add(lang);
    grouped.get(key).files.push(f);
  }

  const templates = options.testCommandTemplates ?? {};
  const commands = [];

  for (const key of [...grouped.keys()].sort()) {
    const entry = grouped.get(key);
    let repLang = [...entry.rawLangs].sort()[0];
    if (key === 'js_ts') {
      repLang = entry.rawLangs.size === 1 && entry.rawLangs.has('typescript') ? 'typescript' : 'javascript';
    } else if (key === 'jvm') {
      repLang = entry.rawLangs.size === 1 && entry.rawLangs.has('kotlin') ? 'kotlin' : 'java';
    }

    const customTpl = templates[repLang] ?? (key === 'js_ts' ? (templates.javascript ?? templates.typescript) : null) ?? (key === 'jvm' ? (templates.java ?? templates.kotlin) : null);
    if (customTpl) {
      commands.push({
        language: repLang,
        runner: 'custom',
        command: applyCommandTemplate(customTpl, entry.files.sort()),
        tests: entry.files.sort(),
      });
      continue;
    }

    const built = buildCommandForGroup(repoRoot, repLang, entry.files);
    if (built) commands.push(built);
  }

  return {
    primaryRunner: commands[0]?.runner ?? options.detectedRunners?.[0] ?? null,
    commands,
    recommendedCommand: commands.length > 0 ? commands.map((c) => c.command).join(' && ') : null,
  };
}

/**
 * Extract test file paths, package directories, and test selector symbols from any runner command string.
 * @param {string} commandStr
 * @returns {{ files: string[], dirs: string[], symbols: string[] }}
 */
export function extractCommandTargets(commandStr) {
  if (!commandStr) return { files: [], dirs: [], symbols: [] };
  const cmd = String(commandStr);

  const files = new Set();
  const fileRx = /(?:['"]?)([A-Za-z0-9_./\\-]+\.(?:mjs|cjs|js|jsx|ts|mts|cts|tsx|py|pyi|go|rs|java|kt|kts|cs|rb|php|c|cc|cpp|cxx|h|hh|hpp|hxx|swift|dart|scala|ex|exs|zig))(?:['"]?)/g;
  for (const m of cmd.matchAll(fileRx)) {
    const idx = m.index ?? 0;
    const prefix = cmd.slice(Math.max(0, idx - 8), idx);
    if (/https?:\/\/$/.test(prefix)) continue;
    files.add(toPosixPath(m[1].replace(/^['"]|['"]$/g, '')));
  }

  const dirs = new Set();
  const dirRx = /(?:^|\s)(?:['"]?)(\.\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*(?:\/\.\.\.)?|[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+(?:\/\.\.\.)?|\.\/\.\.\.)(?:['"]?)(?=\s|$)/g;
  for (const m of cmd.matchAll(dirRx)) {
    const raw = m[1].replace(/\/\.\.\.$/, '');
    const clean = toPosixPath(raw);
    if (clean && clean !== '.' && !files.has(clean)) {
      dirs.add(clean);
    }
  }

  const symbols = new Set();
  const addSymExpr = (expr) => {
    for (const part of String(expr).replace(/^['"]|['"]$/g, '').split(/[,|+]/)) {
      const clean = part.replace(/^FullyQualifiedName~/, '').replace(/[^\w$.-]/g, '').trim();
      if (clean && clean !== '*') symbols.add(clean);
    }
  };
  const segments = cmd.split(/(?:&&|\|\||;|\r?\n)/);
  for (const seg of segments) {
    const extractFlag = (rx) => {
      for (const m of seg.matchAll(rx)) {
        const val = m[1] ?? m[2] ?? m[3];
        if (val && !val.includes('/')) addSymExpr(val);
      }
    };
    if (/\bcargo\s+test\b/.test(seg)) {
      extractFlag(/--test(?:\s+|=)(?:"([^"]+)"|'([^']+)'|([^\s]+))/g);
    }
    if (/\bmvn(?:w)?\b/.test(seg)) {
      extractFlag(/-Dtest=(?:"([^"]+)"|'([^']+)'|([^\s]+))/g);
    }
    if (/\b(?:\.\/)?gradlew?\b/.test(seg)) {
      extractFlag(/--tests(?:\s+|=)(?:"([^"]+)"|'([^']+)'|([^\s]+))/g);
    }
    if (/\bpytest\b/.test(seg)) {
      extractFlag(/(?:^|\s)-k(?:\s+|=)(?:"([^"]+)"|'([^']+)'|([^\s]+))/g);
    }
    if (/\bgo\s+test\b/.test(seg)) {
      extractFlag(/(?:^|\s)-run(?:\s+|=)(?:"([^"]+)"|'([^']+)'|([^\s]+))/g);
    }
    if (/\bctest\b/.test(seg)) {
      extractFlag(/(?:^|\s)-R(?:\s+|=)(?:"([^"]+)"|'([^']+)'|([^\s]+))/g);
    }
    if (/\bdotnet\s+test\b/.test(seg)) {
      for (const m of seg.matchAll(/FullyQualifiedName~([A-Za-z0-9_.-]+)/g)) {
        symbols.add(m[1]);
      }
    }
  }

  return {
    files: [...files],
    dirs: [...dirs],
    symbols: [...symbols],
  };
}
