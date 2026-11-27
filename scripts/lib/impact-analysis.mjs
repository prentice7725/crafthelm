import fs from 'node:fs';
import path from 'node:path';
import { runShellCommand } from './exec.mjs';
import { getChangedFiles, getDiffText, getGitHead, isGitRepo, readFileAtRef, runGit } from './git.mjs';
import {
  DEFAULT_IGNORED_DIRS,
  DEFAULT_TEST_PATTERNS_UNIVERSAL,
  GLOBAL_FALLBACK_PATTERNS_UNIVERSAL,
  SUPPORTED_CODE_EXTENSIONS,
  buildRepoContext,
  parseSourceModule,
  tokenizeJsSource,
} from './impact-languages.mjs';
import { matchesAnyGlob, toPosixPath } from './paths.mjs';
import { assertValidSchema } from './schema.mjs';
import { buildSelectiveTestCommands, detectRepoTestRunners } from './test-runners.mjs';

export { tokenizeJsSource };

const DOC_OR_ASSET_EXTS = new Set([
  '.md', '.markdown', '.txt', '.rst', '.adoc', '.png', '.jpg', '.jpeg', '.gif', '.svg',
  '.ico', '.webp', '.woff', '.woff2', '.pdf', '.csv', '.log',
]);

const UNPARSED_SOURCE_EXTS = new Set([
  '.sql', '.proto', '.graphql', '.gql', '.zig', '.hs', '.ex', '.exs', '.erl',
  '.swift', '.dart', '.scala', '.clj', '.lua', '.r', '.m', '.mm',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.yml', '.yaml', '.toml', '.ini',
  // Data that code and tests read: a schema, a fixture, a config. Nothing links it to the tests
  // that load it, so a change to one cannot be called unimpacted.
  '.json', '.jsonc', '.json5', '.jsonl', '.xml', '.xsd', '.avsc',
]);

/**
 * Parse any supported source module into imports, bindings, classes, functions, and calls.
 * @param {string} relPath
 * @param {string} code
 * @param {string} repoRoot
 * @param {object} [repoContext]
 */
export function parseModuleAst(relPath, code, repoRoot, repoContext = null) {
  return parseSourceModule(relPath, code, repoRoot, repoContext);
}

/**
 * Parse unified diff hunks into exact per-file changed line ranges (ignoring unchanged `-U3` context lines).
 * @param {string} diffText
 * @returns {Map<string, Array<{ start: number, end: number }>>}
 */
export function parseDiffChangedLineRanges(diffText) {
  const rangesByFile = new Map();
  let currentFile = null;
  let inHunk = false;
  let newLine = 1;

  const pushChangedLine = (lineNum) => {
    const arr = rangesByFile.get(currentFile);
    const last = arr[arr.length - 1];
    if (last && (last.end === lineNum || last.end + 1 === lineNum)) {
      last.end = Math.max(last.end, lineNum);
    } else {
      arr.push({ start: lineNum, end: lineNum });
    }
  };

  for (const line of String(diffText ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const diffMatch = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (diffMatch) {
      currentFile = toPosixPath(diffMatch[1].trim());
      if (!rangesByFile.has(currentFile)) rangesByFile.set(currentFile, []);
      inHunk = false;
      continue;
    }
    const plusHeader = line.match(/^\+\+\+\s+b\/(.+)$/);
    if (plusHeader) {
      currentFile = toPosixPath(plusHeader[1].trim());
      if (!rangesByFile.has(currentFile)) rangesByFile.set(currentFile, []);
      inHunk = false;
      continue;
    }
    if (line.startsWith('--- ')) {
      inHunk = false;
      continue;
    }
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch && currentFile) {
      newLine = Math.max(1, Number(hunkMatch[1]));
      inHunk = true;
      continue;
    }
    if (!inHunk || !currentFile) continue;

    if (line.startsWith('+')) {
      pushChangedLine(newLine);
      newLine += 1;
    } else if (line.startsWith('-')) {
      pushChangedLine(Math.max(1, newLine));
    } else if (line.startsWith(' ')) {
      newLine += 1;
    }
  }
  return rangesByFile;
}

const HARD_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.crafthelm',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'venv',
]);

function isInsideIgnoredDir(relPath, dirNames) {
  const parts = toPosixPath(relPath).split('/').slice(0, -1);
  return parts.some((p) => dirNames.has(p));
}

function loadRepoVerificationPolicy(repoRoot, options = {}, baseRef = 'HEAD') {
  if (options.policyDir) {
    const extConfig = path.join(options.policyDir, 'config.json');
    if (fs.existsSync(extConfig)) {
      try {
        return JSON.parse(fs.readFileSync(extConfig, 'utf8'))?.verification_policy ?? {};
      } catch {
        return {};
      }
    }
    return {};
  }

  if (isGitRepo(repoRoot)) {
    const policyRef = options.policyBaseRef ?? baseRef;
    if (policyRef && policyRef !== 'UNBORN' && policyRef !== 'NO_GIT') {
      const baseline = readFileAtRef(repoRoot, policyRef, '.crafthelm/config.json');
      if (!baseline.exists) return {};
      try {
        return JSON.parse(baseline.content)?.verification_policy ?? {};
      } catch {
        return {};
      }
    }
  }

  const configPath = path.join(repoRoot, '.crafthelm', 'config.json');
  if (!fs.existsSync(configPath)) return {};
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return cfg?.verification_policy ?? {};
  } catch {
    return {};
  }
}

function collectRepoFiles(repoRoot, extraIgnoredDirs = []) {
  const walkIgnored = new Set([...DEFAULT_IGNORED_DIRS, ...extraIgnoredDirs]);
  const trackedIgnored = new Set([...HARD_IGNORED_DIRS, ...extraIgnoredDirs]);
  const fileSet = new Set();

  const walk = (dir, prefix) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (walkIgnored.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        fileSet.add(toPosixPath(rel));
      }
    }
  };
  walk(repoRoot, '');

  if (isGitRepo(repoRoot)) {
    const trackedRes = runGit(repoRoot, ['ls-files', '--cached']);
    if (trackedRes.exitCode === 0) {
      for (const line of trackedRes.stdout.split(/\r?\n/)) {
        const rel = toPosixPath(line.trim());
        if (!rel || isInsideIgnoredDir(rel, trackedIgnored)) continue;
        const abs = path.join(repoRoot, rel);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          fileSet.add(rel);
        }
      }
    }
  }

  return [...fileSet].sort();
}

function evaluateMandatoryFallbacks({ changedFiles, globalPatterns, testCandidates, selectedTests, analyzedFiles, extraIgnoredDirs = [] }) {
  const allIgnoredDirNames = new Set([...DEFAULT_IGNORED_DIRS, ...extraIgnoredDirs]);
  const globalChanged = changedFiles.filter((f) => matchesAnyGlob(f, globalPatterns));
  const nonTestCodeChanged = changedFiles.filter((f) => !testCandidates.includes(f));
  const nonTestSourceChanged = nonTestCodeChanged.filter(
    (f) => !DOC_OR_ASSET_EXTS.has(path.posix.extname(f).toLowerCase()),
  );
  const unparsedCodeChanged = nonTestCodeChanged.filter((f) => {
    if (analyzedFiles?.has(f)) return false;
    const ext = path.posix.extname(f).toLowerCase();
    if (DOC_OR_ASSET_EXTS.has(ext)) return false;
    if (UNPARSED_SOURCE_EXTS.has(ext) || SUPPORTED_CODE_EXTENSIONS.has(ext)) return true;
    if (isInsideIgnoredDir(f, allIgnoredDirNames)) return true;
    return /^(?:src|app|lib|server|api|pkg|cmd|internal|crates|packages|bin)\//i.test(f);
  });

  if (globalChanged.length > 0) {
    return {
      fallback_to_full: true,
      fallback_code: 'GLOBAL_CONFIG_CHANGED',
      fallback_reason: `Global config or schema file changed: ${globalChanged.join(', ')}`,
    };
  }
  if (unparsedCodeChanged.length > 0) {
    return {
      fallback_to_full: true,
      fallback_code: 'UNPARSED_SOURCE_CHANGED',
      fallback_reason: `Unparsed or ignored source files changed requiring full verification: ${unparsedCodeChanged.join(', ')}`,
    };
  }
  if (nonTestSourceChanged.length > 0 && testCandidates.length > 0 && selectedTests.length === 0) {
    return {
      fallback_to_full: true,
      fallback_code: 'NO_TEST_MATCHED',
      fallback_reason: 'Source files changed but zero tests matched statically; falling back to full suite for safety',
    };
  }
  return { fallback_to_full: false, fallback_code: null, fallback_reason: null };
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

function extractFeatureNames(files, qualifiedFunctions) {
  const genericDirs = new Set([
    'src', 'lib', 'app', 'tests', 'test', 'spec', 'scripts', 'utils', 'common',
    'internal', 'pkg', 'cmd', 'main', 'java', 'kotlin', 'crates', 'packages', '.',
  ]);
  const features = new Set();

  for (const file of files) {
    const parts = toPosixPath(file).split('/');
    for (const part of parts.slice(0, -1)) {
      if (!genericDirs.has(part.toLowerCase())) {
        features.add(part);
      }
    }
    let base = path.posix.basename(file).replace(/\.(?:mjs|cjs|js|jsx|ts|mts|cts|tsx|py|pyi|go|rs|java|kt|kts|cs|rb|php|c|cc|cpp|cxx|h|hh|hpp|hxx)$/i, '');
    base = base.replace(/^test_/, '').replace(/\.(?:test|spec)$/i, '').replace(/(?:_test|_spec|Tests?|Spec)$/i, '');
    if (base && !['index', 'mod', 'lib', 'main', 'unit', 'e2e', 'app', '__init__'].includes(base.toLowerCase())) {
      features.add(base);
    }
  }
  for (const qn of qualifiedFunctions) {
    const sym = qn.split('::')[1] ?? '';
    if (sym && sym !== '<module>') {
      features.add(sym.split('.')[0]);
    }
  }
  return [...features].sort();
}

function buildFallbackReport({ baseRef, changedFiles, testCandidates, runnerInfo, reason, analyzerSource }) {
  const report = {
    schema_version: '0.3',
    base_ref: baseRef || 'HEAD',
    directly_changed_files: changedFiles,
    directly_changed_functions: [],
    directly_changed_classes: [],
    impacted_functions: [],
    impacted_files: changedFiles,
    impacted_features: extractFeatureNames(changedFiles, []),
    test_candidates: testCandidates,
    selected_tests: [],
    unselected_tests: testCandidates.map((file) => ({ file, reason: 'Fallback to full test suite' })),
    recommended_test_command: null,
    recommended_test_commands: [],
    fallback_to_full: true,
    fallback_code: 'ANALYSIS_UNAVAILABLE',
    fallback_reason: reason,
    graph_stats: { files_parsed: 0, functions_indexed: 0, classes_indexed: 0, import_edges: 0, call_edges: 0 },
    languages_detected: runnerInfo.languages,
    test_runner: runnerInfo.runners[0] ?? null,
    analyzer_source: analyzerSource,
    analyzed_at: new Date().toISOString(),
  };
  assertValidSchema('impact-analysis', report, 'impact-analysis');
  return report;
}

/**
 * Perform polyglot AST + module import + function/class call-graph impact analysis on any repository.
 * Supports built-in polyglot parsing across JS/TS/Python/Go/Rust/Java/Kotlin/C#/C/C++/Ruby/PHP
 * plus external custom analyzer plugins outputting CraftHelm JSON.
 * @param {string} repoRoot
 * @param {{
 *   baseRef?: string,
 *   changedFiles?: string[],
 *   diffText?: string,
 *   testPatterns?: string[],
 *   globalFallbackPatterns?: string[],
 *   ignoredDirs?: string[],
 *   testCommandTemplate?: string,
 *   testCommandTemplates?: Record<string, string>,
 *   customAnalyzerCmd?: string,
 * }} [options]
 */
export function analyzeImpact(repoRoot, options = {}) {
  const absRepo = path.resolve(repoRoot ?? '.');
  const baseRef = options.baseRef ?? (isGitRepo(absRepo) ? getGitHead(absRepo) : 'HEAD');
  const repoPolicy = loadRepoVerificationPolicy(absRepo, options, baseRef);
  const changedFiles = [...new Set(
    (options.changedFiles ?? (isGitRepo(absRepo) ? getChangedFiles(absRepo, baseRef) : [])).map(toPosixPath),
  )].sort();
  const diffText = options.diffText ?? (isGitRepo(absRepo) ? getDiffText(absRepo, baseRef) : '');
  const diffRanges = parseDiffChangedLineRanges(diffText);

  const testPatterns = options.testPatterns?.length
    ? options.testPatterns
    : (repoPolicy.test_file_patterns?.length ? repoPolicy.test_file_patterns : DEFAULT_TEST_PATTERNS_UNIVERSAL);
  const ignoredDirs = options.ignoredDirs ?? repoPolicy.ignored_dirs ?? [];
  const globalPatterns = [
    ...GLOBAL_FALLBACK_PATTERNS_UNIVERSAL,
    ...(options.globalFallbackPatterns ?? repoPolicy.global_fallback_patterns ?? []),
  ];
  const testCommandTemplate = options.testCommandTemplate ?? repoPolicy.test_command_template;
  const testCommandTemplates = { ...(repoPolicy.test_command_templates ?? {}), ...(options.testCommandTemplates ?? {}) };
  const customAnalyzerCmd = options.customAnalyzerCmd ?? repoPolicy.custom_impact_analyzer;

  const allRepoFiles = collectRepoFiles(absRepo, ignoredDirs);
  const runnerInfo = detectRepoTestRunners(absRepo, allRepoFiles);
  const codeFiles = allRepoFiles.filter((f) => SUPPORTED_CODE_EXTENSIONS.has(path.posix.extname(f).toLowerCase()));
  const extraTestFiles = customAnalyzerCmd
    ? allRepoFiles.filter((f) => matchesAnyGlob(f, testPatterns))
    : [];
  const testCandidates = [...new Set([
    ...codeFiles.filter((f) => matchesAnyGlob(f, testPatterns)),
    ...extraTestFiles,
  ])].sort();

  let analyzerSource = 'builtin_polyglot';
  let customModules = [];

  if (customAnalyzerCmd) {
    const extRes = runShellCommand(customAnalyzerCmd, {
      cwd: absRepo,
      env: {
        ...process.env,
        CRAFTHELM_REPO: absRepo,
        CRAFTHELM_BASE_REF: baseRef || 'HEAD',
        CRAFTHELM_CHANGED_FILES_JSON: JSON.stringify(changedFiles),
      },
    });
    if (extRes.exitCode !== 0) {
      return buildFallbackReport({
        baseRef,
        changedFiles,
        testCandidates,
        runnerInfo,
        analyzerSource: 'custom_analyzer',
        reason: `Custom impact analyzer failed (exit ${extRes.exitCode}): ${(extRes.stderr || extRes.stdout).trim().slice(0, 200)}`,
      });
    }
    try {
      const parsedOut = JSON.parse(extRes.stdout);
      if (parsedOut && parsedOut.schema_version === '0.3' && Array.isArray(parsedOut.selected_tests)) {
        const coveredFiles = new Set([
          ...(parsedOut.directly_changed_files ?? []).map(toPosixPath),
          ...(parsedOut.impacted_files ?? []).map(toPosixPath),
        ]);
        const effectiveChanged = changedFiles.length > 0
          ? changedFiles
          : [...new Set((parsedOut.directly_changed_files ?? []).map(toPosixPath))].sort();
        const mandatory = evaluateMandatoryFallbacks({
          changedFiles: effectiveChanged,
          globalPatterns,
          testCandidates: testCandidates.length > 0 ? testCandidates : (parsedOut.test_candidates ?? []),
          selectedTests: parsedOut.selected_tests,
          analyzedFiles: coveredFiles,
          extraIgnoredDirs: ignoredDirs,
        });
        const forceFull = Boolean(parsedOut.fallback_to_full) || mandatory.fallback_to_full;
        const enriched = {
          languages_detected: runnerInfo.languages,
          test_runner: runnerInfo.runners[0] ?? 'custom',
          recommended_test_commands: [],
          analyzer_source: 'custom_analyzer',
          ...parsedOut,
          ...(mandatory.fallback_to_full
            ? {
                fallback_to_full: true,
                fallback_code: mandatory.fallback_code,
                fallback_reason: mandatory.fallback_reason,
                recommended_test_command: null,
                recommended_test_commands: [],
              }
            : forceFull
              ? { recommended_test_command: null, recommended_test_commands: [] }
              : {}),
        };
        assertValidSchema('impact-analysis', enriched, 'custom impact-analysis');
        return enriched;
      }
      if (parsedOut && Array.isArray(parsedOut.modules)) {
        customModules = parsedOut.modules;
        analyzerSource = 'hybrid';
      } else {
        return buildFallbackReport({
          baseRef,
          changedFiles,
          testCandidates,
          runnerInfo,
          analyzerSource: 'custom_analyzer',
          reason: 'Custom impact analyzer JSON did not contain valid impact-analysis report or modules[]',
        });
      }
    } catch (err) {
      return buildFallbackReport({
        baseRef,
        changedFiles,
        testCandidates,
        runnerInfo,
        analyzerSource: 'custom_analyzer',
        reason: `Custom impact analyzer returned invalid JSON: ${err.message}`,
      });
    }
  }

  const repoContext = buildRepoContext(absRepo, allRepoFiles);
  const parsedModules = new Map();
  let functionsIndexed = 0;
  let classesIndexed = 0;
  let importEdges = 0;

  for (const rel of codeFiles) {
    const abs = path.join(absRepo, rel);
    const code = fs.readFileSync(abs, 'utf8');
    const ast = parseSourceModule(rel, code, absRepo, repoContext);
    parsedModules.set(rel, ast);
  }

  for (const mod of customModules) {
    if (!mod || !mod.file) continue;
    const rel = toPosixPath(mod.file);
    if (!runnerInfo.languages.includes(mod.language ?? 'custom') && mod.language) {
      runnerInfo.languages.push(mod.language);
      runnerInfo.languages.sort();
    }
    parsedModules.set(rel, {
      file: rel,
      language: mod.language ?? 'custom',
      packageKey: mod.packageKey ?? null,
      imports: [...new Set((mod.imports ?? []).map(toPosixPath))].sort(),
      importBindings: mod.importBindings ?? [],
      classes: mod.classes ?? [],
      functions: mod.functions ?? [],
      moduleCalls: mod.moduleCalls ?? [],
    });
  }

  const packageModules = new Map();
  for (const mod of parsedModules.values()) {
    functionsIndexed += mod.functions.length;
    classesIndexed += mod.classes.length;
    importEdges += mod.imports.length;
    if (mod.packageKey) {
      if (!packageModules.has(mod.packageKey)) packageModules.set(mod.packageKey, []);
      packageModules.get(mod.packageKey).push(mod);
    }
  }

  const reverseImports = new Map();
  const reverseCalls = new Map();
  const callersByFile = new Map();
  let callEdges = 0;

  for (const [file, mod] of parsedModules) {
    for (const imp of mod.imports) {
      if (!reverseImports.has(imp)) reverseImports.set(imp, new Set());
      reverseImports.get(imp).add(file);
    }

    const bindMap = new Map();
    for (const b of mod.importBindings) {
      if (!bindMap.has(b.localName)) bindMap.set(b.localName, []);
      bindMap.get(b.localName).push(b);
    }
    const samePkgMods = mod.packageKey ? (packageModules.get(mod.packageKey) ?? []).filter((m) => m.file !== file) : [];

    const resolveCalleeTargets = (call) => {
      const targets = [];
      const selfMod = mod;
      const pushMatchingFns = (targetMod, name, classHint = null) => {
        for (const fn of targetMod.functions) {
          if (classHint && fn.class_name === classHint && fn.name === name) {
            targets.push(fn.qualified_name);
          } else if (!classHint && fn.name === name) {
            targets.push(fn.qualified_name);
          }
        }
        if (classHint) {
          for (const cls of targetMod.classes) {
            if (cls.name === classHint) {
              for (const fn of targetMod.functions) {
                if (fn.class_name === cls.name && fn.name === name) targets.push(fn.qualified_name);
              }
            }
          }
        }
      };

      const pushClassConstructors = (targetMod, className) => {
        for (const fn of targetMod.functions) {
          if (
            fn.class_name === className &&
            (fn.name === 'constructor' || fn.name === '__init__' || fn.name === 'new' || fn.name === className)
          ) {
            targets.push(fn.qualified_name);
          }
        }
      };

      if (call.kind === 'ref') {
        const bindings = bindMap.get(call.name) ?? [];
        for (const b of bindings) {
          const targetMod = parsedModules.get(b.targetFile);
          if (!targetMod) continue;
          const lookupName = b.importedName === 'default' || b.importedName === '*' ? call.name : b.importedName;
          pushMatchingFns(targetMod, lookupName);
        }
        for (const pkgMod of samePkgMods) {
          pushMatchingFns(pkgMod, call.name);
        }
      } else if (call.kind === 'direct' || call.kind === 'construct') {
        const bindings = bindMap.get(call.name) ?? [];
        for (const b of bindings) {
          const targetMod = parsedModules.get(b.targetFile);
          if (!targetMod) continue;
          const lookupName = b.importedName === 'default' || b.importedName === '*' ? call.name : b.importedName;
          pushMatchingFns(targetMod, lookupName);
          pushClassConstructors(targetMod, lookupName);
        }
        pushMatchingFns(selfMod, call.name);
        pushClassConstructors(selfMod, call.name);
        for (const pkgMod of samePkgMods) {
          pushMatchingFns(pkgMod, call.name);
          pushClassConstructors(pkgMod, call.name);
        }
        if (targets.length === 0) {
          for (const impFile of selfMod.imports) {
            const targetMod = parsedModules.get(impFile);
            if (targetMod) {
              pushMatchingFns(targetMod, call.name);
              pushClassConstructors(targetMod, call.name);
            }
          }
        }
      } else if (call.kind === 'member') {
        const objBindings = bindMap.get(call.object) ?? [];
        for (const b of objBindings) {
          const targetMod = parsedModules.get(b.targetFile);
          if (targetMod) pushMatchingFns(targetMod, call.name);
        }
        pushMatchingFns(selfMod, call.name);
        for (const pkgMod of samePkgMods) {
          pushMatchingFns(pkgMod, call.name, call.object);
          pushMatchingFns(pkgMod, call.name);
        }
        for (const impFile of selfMod.imports) {
          const targetMod = parsedModules.get(impFile);
          if (targetMod) {
            for (const fn of targetMod.functions) {
              if (fn.name === call.name && Boolean(fn.class_name)) {
                targets.push(fn.qualified_name);
              }
            }
          }
        }
      }
      return [...new Set(targets)];
    };

    const addCallerEdges = (callerQn, calls) => {
      for (const call of calls) {
        const targets = resolveCalleeTargets(call);
        for (const targetQn of targets) {
          if (!reverseCalls.has(targetQn)) reverseCalls.set(targetQn, new Set());
          if (!reverseCalls.get(targetQn).has(callerQn)) {
            reverseCalls.get(targetQn).add(callerQn);
            callEdges += 1;
          }
          const targetFile = targetQn.split('::')[0];
          if (!callersByFile.has(targetFile)) callersByFile.set(targetFile, new Set());
          callersByFile.get(targetFile).add(file);
        }
      }
    };

    for (const fn of mod.functions) {
      addCallerEdges(fn.qualified_name, fn.calls);
    }
    addCallerEdges(`${file}::<module>`, mod.moduleCalls);
  }

  const directlyChangedFunctions = new Set();
  const directlyChangedClasses = new Set();
  const changedModuleLevelFiles = new Set();

  for (const file of changedFiles) {
    const mod = parsedModules.get(file);
    if (!mod) continue;
    const hunks = diffRanges.get(file) ?? [];

    if (hunks.length === 0) {
      for (const cls of mod.classes) directlyChangedClasses.add(cls.qualified_name);
      for (const fn of mod.functions) directlyChangedFunctions.add(fn.qualified_name);
      changedModuleLevelFiles.add(file);
      continue;
    }

    let matchedInsideSymbol = false;
    for (const cls of mod.classes) {
      if (hunks.some((h) => rangesOverlap(h.start, h.end, cls.start_line, cls.end_line))) {
        directlyChangedClasses.add(cls.qualified_name);
        matchedInsideSymbol = true;
      }
    }
    for (const fn of mod.functions) {
      if (hunks.some((h) => rangesOverlap(h.start, h.end, fn.start_line, fn.end_line))) {
        directlyChangedFunctions.add(fn.qualified_name);
        matchedInsideSymbol = true;
      }
    }
    if (!matchedInsideSymbol) {
      directlyChangedFunctions.add(`${file}::<module>`);
      changedModuleLevelFiles.add(file);
    }
  }

  const impactedFunctions = new Set(directlyChangedFunctions);
  const impactedFiles = new Set(changedFiles);
  const reasonMap = new Map();

  const addReason = (file, reason) => {
    if (!reasonMap.has(file)) reasonMap.set(file, new Set());
    reasonMap.get(file).add(reason);
  };

  for (const f of changedFiles) {
    if (testCandidates.includes(f)) addReason(f, 'test file directly modified');
  }

  const fnQueue = [...directlyChangedFunctions];
  const visitedFn = new Set(fnQueue);
  while (fnQueue.length > 0) {
    const curQn = fnQueue.shift();
    const curFile = curQn.split('::')[0];
    impactedFiles.add(curFile);

    for (const callerQn of reverseCalls.get(curQn) ?? []) {
      const callerFile = callerQn.split('::')[0];
      impactedFunctions.add(callerQn);
      impactedFiles.add(callerFile);
      if (testCandidates.includes(callerFile)) {
        addReason(callerFile, `calls impacted symbol ${curQn}`);
      }
      if (!visitedFn.has(callerQn)) {
        visitedFn.add(callerQn);
        fnQueue.push(callerQn);
      }
    }
  }

  const fileQueue = [...changedModuleLevelFiles];
  for (const clsQn of directlyChangedClasses) {
    const clsFile = clsQn.split('::')[0];
    if (!fileQueue.includes(clsFile)) fileQueue.push(clsFile);
  }
  const visitedFiles = new Set(fileQueue);
  while (fileQueue.length > 0) {
    const curFile = fileQueue.shift();
    const curMod = parsedModules.get(curFile);
    const samePkgSiblings = curMod?.packageKey
      ? (packageModules.get(curMod.packageKey) ?? []).map((m) => m.file).filter((f) => f !== curFile)
      : [];
    const neighbors = new Set([...(reverseImports.get(curFile) ?? []), ...samePkgSiblings]);
    for (const importerFile of neighbors) {
      impactedFiles.add(importerFile);
      if (testCandidates.includes(importerFile)) {
        addReason(importerFile, `imports or shares package with changed module ${curFile}`);
      }
      if (!visitedFiles.has(importerFile)) {
        visitedFiles.add(importerFile);
        fileQueue.push(importerFile);
      }
    }
  }

  for (const testFile of testCandidates) {
    if (reasonMap.has(testFile)) continue;
    const testMod = parsedModules.get(testFile);
    if (!testMod) continue;
    const hasTopLevelOrTestCalls = testMod.moduleCalls.length > 0 || testMod.functions.length > 0;
    if (!hasTopLevelOrTestCalls) continue;
    for (const imp of testMod.imports) {
      if (changedModuleLevelFiles.has(imp)) {
        addReason(testFile, `imports module with top-level changes (${imp})`);
      }
    }
  }

  const selectedTests = [];
  const unselectedTests = [];
  for (const testFile of testCandidates) {
    if (reasonMap.has(testFile)) {
      selectedTests.push({ file: testFile, reasons: [...reasonMap.get(testFile)].sort() });
    } else {
      unselectedTests.push({ file: testFile, reason: 'No direct or transitive dependency on changed code' });
    }
  }

  const { fallback_to_full: fallbackToFull, fallback_code: fallbackCode, fallback_reason: fallbackReason } = evaluateMandatoryFallbacks({
    changedFiles,
    globalPatterns,
    testCandidates,
    selectedTests,
    analyzedFiles: parsedModules,
    extraIgnoredDirs: ignoredDirs,
  });

  const cmdPlan = !fallbackToFull && selectedTests.length > 0
    ? buildSelectiveTestCommands(absRepo, selectedTests.map((t) => t.file), {
        testCommandTemplate,
        testCommandTemplates,
        detectedRunners: runnerInfo.runners,
      })
    : { primaryRunner: runnerInfo.runners[0] ?? null, commands: [], recommendedCommand: null };

  const result = {
    schema_version: '0.3',
    base_ref: baseRef || 'HEAD',
    directly_changed_files: changedFiles,
    directly_changed_functions: [...directlyChangedFunctions].sort(),
    directly_changed_classes: [...directlyChangedClasses].sort(),
    impacted_functions: [...impactedFunctions].sort(),
    impacted_files: [...impactedFiles].sort(),
    impacted_features: extractFeatureNames(impactedFiles, impactedFunctions),
    test_candidates: testCandidates,
    selected_tests: selectedTests,
    unselected_tests: unselectedTests,
    recommended_test_command: cmdPlan.recommendedCommand,
    recommended_test_commands: cmdPlan.commands,
    fallback_to_full: fallbackToFull,
    fallback_code: fallbackCode,
    fallback_reason: fallbackReason,
    graph_stats: {
      files_parsed: parsedModules.size,
      functions_indexed: functionsIndexed,
      classes_indexed: classesIndexed,
      import_edges: importEdges,
      call_edges: callEdges,
    },
    languages_detected: runnerInfo.languages,
    test_runner: cmdPlan.primaryRunner,
    analyzer_source: analyzerSource,
    analyzed_at: new Date().toISOString(),
  };

  assertValidSchema('impact-analysis', result, 'impact-analysis');
  return result;
}
