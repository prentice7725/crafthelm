import fs from 'node:fs';
import path from 'node:path';
import { toPosixPath } from './paths.mjs';

export const LANGUAGE_BY_EXT = new Map([
  ['.js', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.jsx', 'javascript'],
  ['.ts', 'typescript'],
  ['.mts', 'typescript'],
  ['.cts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.py', 'python'],
  ['.pyi', 'python'],
  ['.go', 'go'],
  ['.rs', 'rust'],
  ['.java', 'java'],
  ['.kt', 'kotlin'],
  ['.kts', 'kotlin'],
  ['.cs', 'csharp'],
  ['.c', 'c_cpp'],
  ['.h', 'c_cpp'],
  ['.cc', 'c_cpp'],
  ['.cpp', 'c_cpp'],
  ['.cxx', 'c_cpp'],
  ['.hh', 'c_cpp'],
  ['.hpp', 'c_cpp'],
  ['.hxx', 'c_cpp'],
  ['.rb', 'ruby'],
  ['.php', 'php'],
]);

export const SUPPORTED_CODE_EXTENSIONS = new Set(LANGUAGE_BY_EXT.keys());

export const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.crafthelm',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'venv',
  'target',
  'dist',
  'build',
  'out',
  'bin',
  'obj',
  'vendor',
  '.gradle',
  '.idea',
  '.vscode',
]);

export const GLOBAL_FALLBACK_PATTERNS_UNIVERSAL = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'jsconfig.json',
  'pyproject.toml',
  'requirements*.txt',
  'setup.py',
  'setup.cfg',
  'poetry.lock',
  'uv.lock',
  'pytest.ini',
  'conftest.py',
  '**/conftest.py',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle*',
  '*.csproj',
  '**/*.csproj',
  '*.sln',
  'Directory.Build.props',
  'global.json',
  'Gemfile',
  'Gemfile.lock',
  'composer.json',
  'composer.lock',
  'CMakeLists.txt',
  'Makefile',
  'meson.build',
  'contracts/schemas/**',
  '.crafthelm/reliability-rules.json',
  '.crafthelm/config.json',
  '.crafthelm/zones.json',
  'REVIEW.md',
];

export const DEFAULT_TEST_PATTERNS_UNIVERSAL = [
  'tests/**/*.test.*',
  'tests/**/*.spec.*',
  'tests/**/*.mjs',
  'tests/**/*.js',
  'test/**/*.test.*',
  'test/**/*.spec.*',
  '**/*.test.*',
  '**/*.spec.*',
  '**/*_test.*',
  '**/__tests__/**',
  '**/test_*.py',
  '**/*_test.py',
  'tests/**/*.py',
  'test/**/*.py',
  '**/*_test.go',
  'tests/**/*.rs',
  '**/*_test.rs',
  'src/test/**/*.java',
  'src/test/**/*.kt',
  '**/*Test.java',
  '**/*Tests.java',
  '**/*Spec.java',
  '**/*Test.kt',
  '**/*Tests.cs',
  '**/*Test.cs',
  '**/*.Tests/**/*.cs',
  'spec/**/*_spec.rb',
  'test/**/*_test.rb',
  '**/*_spec.rb',
  'tests/**/*Test.php',
  '**/*Test.php',
  'tests/**/*_test.c',
  'tests/**/*_test.cc',
  'tests/**/*_test.cpp',
  'tests/**/*_test.cxx',
  '**/*_test.c',
  '**/*_test.cc',
  '**/*_test.cpp',
  '**/*_test.cxx',
];

const JS_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'throw', 'try', 'catch', 'finally', 'function', 'class', 'extends', 'super',
  'import', 'export', 'from', 'as', 'default', 'const', 'let', 'var', 'new', 'this',
  'typeof', 'instanceof', 'void', 'delete', 'in', 'of', 'await', 'async', 'yield',
  'true', 'false', 'null', 'undefined', 'static', 'get', 'set', 'implements', 'interface', 'type',
]);
const REGEX_PREV_KEYWORDS = new Set([
  'return', 'case', 'throw', 'else', 'do', 'typeof', 'void', 'delete',
  'in', 'instanceof', 'new', 'yield', 'await', 'of',
]);
const REGEX_PREV_PUNCTS = new Set(['(', '[', '{', ',', ';', ':', '?', '!', '=', '+', '-', '*', '%', '&', '|', '^', '~', '<', '>', '=>']);

const CLIKE_CONTROL_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'throw', 'try', 'catch', 'finally', 'typeof', 'sizeof', 'new', 'delete',
  'synchronized', 'using', 'lock', 'when', 'match', 'loop', 'select', 'defer', 'go',
  'foreach', 'elseif',
]);

/**
 * Detect logical language identifier for a repository relative path.
 * @param {string} relPath
 * @returns {string|null}
 */
export function detectLanguageForFile(relPath) {
  const ext = path.posix.extname(toPosixPath(relPath)).toLowerCase();
  return LANGUAGE_BY_EXT.get(ext) ?? null;
}

/**
 * Scan repository files once to build language/package indexes for fast offline resolution.
 * @param {string} repoRoot
 * @param {string[]} allRepoFiles
 */
export function buildRepoContext(repoRoot, allRepoFiles) {
  const allFileSet = new Set(allRepoFiles.map(toPosixPath));
  let goModule = null;
  const goFilesByDir = new Map();
  let rustCrateName = null;
  const javaKotlinPackageIndex = new Map();
  const javaKotlinClassToFile = new Map();
  const csharpNamespaceIndex = new Map();
  const phpNamespaceIndex = new Map();
  const phpClassToFile = new Map();

  if (allFileSet.has('go.mod')) {
    try {
      const goModText = fs.readFileSync(path.join(repoRoot, 'go.mod'), 'utf8');
      const m = goModText.match(/^\s*module\s+([^\s]+)/m);
      if (m) goModule = m[1].trim();
    } catch {
      // Ignore unreadable go.mod
    }
  }

  if (allFileSet.has('Cargo.toml')) {
    try {
      const cargoText = fs.readFileSync(path.join(repoRoot, 'Cargo.toml'), 'utf8');
      const m = cargoText.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
      if (m) rustCrateName = m[1].trim().replace(/-/g, '_');
    } catch {
      // Ignore unreadable Cargo.toml
    }
  }

  for (const rawRel of allRepoFiles) {
    const rel = toPosixPath(rawRel);
    const ext = path.posix.extname(rel).toLowerCase();
    if (ext === '.go') {
      const dir = path.posix.dirname(rel);
      if (!goFilesByDir.has(dir)) goFilesByDir.set(dir, []);
      goFilesByDir.get(dir).push(rel);
      continue;
    }

    if (ext === '.java' || ext === '.kt' || ext === '.kts') {
      try {
        const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
        const pkgMatch = text.match(/^\s*package\s+([A-Za-z0-9_.]+)\s*;?/m);
        if (pkgMatch) {
          const pkg = pkgMatch[1];
          if (!javaKotlinPackageIndex.has(pkg)) javaKotlinPackageIndex.set(pkg, []);
          javaKotlinPackageIndex.get(pkg).push(rel);
          const stem = path.posix.basename(rel, ext);
          javaKotlinClassToFile.set(`${pkg}.${stem}`, rel);
        }
      } catch {
        // Ignore read error
      }
      continue;
    }

    if (ext === '.cs') {
      try {
        const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
        for (const m of text.matchAll(/^\s*namespace\s+([A-Za-z0-9_.]+)\s*[;{]/gm)) {
          const ns = m[1];
          if (!csharpNamespaceIndex.has(ns)) csharpNamespaceIndex.set(ns, []);
          csharpNamespaceIndex.get(ns).push(rel);
        }
      } catch {
        // Ignore read error
      }
      continue;
    }

    if (ext === '.php') {
      try {
        const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
        const nsMatch = text.match(/^\s*namespace\s+([A-Za-z0-9_\\]+)\s*;/m);
        if (nsMatch) {
          const ns = nsMatch[1].replace(/^\\+|\\+$/g, '');
          if (!phpNamespaceIndex.has(ns)) phpNamespaceIndex.set(ns, []);
          phpNamespaceIndex.get(ns).push(rel);
          const stem = path.posix.basename(rel, ext);
          phpClassToFile.set(`${ns}\\${stem}`, rel);
        }
      } catch {
        // Ignore read error
      }
    }
  }

  return {
    repoRoot,
    allRepoFiles,
    allFileSet,
    goModule,
    goFilesByDir,
    rustCrateName,
    javaKotlinPackageIndex,
    javaKotlinClassToFile,
    csharpNamespaceIndex,
    phpNamespaceIndex,
    phpClassToFile,
  };
}

/**
 * Tokenize JS/TS source code while cleanly ignoring comments, strings, regex literals,
 * and static template text (while still tokenizing expressions inside `${...}`).
 * @param {string} source
 * @returns {Array<{ type: 'ident'|'keyword'|'punct'|'string'|'number', value: string, line: number }>}
 */
export function tokenizeJsSource(source) {
  const code = String(source ?? '').replace(/\r\n/g, '\n');
  const tokens = [];
  const templateBraceStack = [];
  let i = 0;
  let line = 1;

  const canStartRegex = () => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    if (prev.type === 'keyword') return REGEX_PREV_KEYWORDS.has(prev.value);
    if (prev.type === 'punct') return REGEX_PREV_PUNCTS.has(prev.value);
    return false;
  };

  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];

    if (ch === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < code.length && code[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      const quote = ch;
      const startLine = line;
      let val = '';
      i += 1;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\' && i + 1 < code.length) {
          if (code[i + 1] === '\n') line += 1;
          val += code[i + 1];
          i += 2;
          continue;
        }
        if (code[i] === '\n') {
          line += 1;
          break;
        }
        val += code[i];
        i += 1;
      }
      if (code[i] === quote) i += 1;
      tokens.push({ type: 'string', value: val, line: startLine });
      continue;
    }
    if (ch === '`') {
      const startLine = line;
      i += 1;
      let val = '';
      while (i < code.length) {
        if (code[i] === '\\' && i + 1 < code.length) {
          if (code[i + 1] === '\n') line += 1;
          val += code[i + 1];
          i += 2;
          continue;
        }
        if (code[i] === '$' && code[i + 1] === '{') {
          tokens.push({ type: 'string', value: val, line: startLine });
          templateBraceStack.push(1);
          i += 2;
          break;
        }
        if (code[i] === '`') {
          tokens.push({ type: 'string', value: val, line: startLine });
          i += 1;
          break;
        }
        if (code[i] === '\n') line += 1;
        val += code[i];
        i += 1;
      }
      continue;
    }
    if (ch === '}' && templateBraceStack.length > 0) {
      const top = templateBraceStack[templateBraceStack.length - 1] - 1;
      if (top === 0) {
        templateBraceStack.pop();
        i += 1;
        const contLine = line;
        let val = '';
        while (i < code.length) {
          if (code[i] === '\\' && i + 1 < code.length) {
            if (code[i + 1] === '\n') line += 1;
            val += code[i + 1];
            i += 2;
            continue;
          }
          if (code[i] === '$' && code[i + 1] === '{') {
            tokens.push({ type: 'string', value: val, line: contLine });
            templateBraceStack.push(1);
            i += 2;
            break;
          }
          if (code[i] === '`') {
            tokens.push({ type: 'string', value: val, line: contLine });
            i += 1;
            break;
          }
          if (code[i] === '\n') line += 1;
          val += code[i];
          i += 1;
        }
        continue;
      }
      templateBraceStack[templateBraceStack.length - 1] = top;
    } else if (ch === '{' && templateBraceStack.length > 0) {
      templateBraceStack[templateBraceStack.length - 1] += 1;
    }
    if (ch === '/' && canStartRegex()) {
      i += 1;
      let inClass = false;
      while (i < code.length) {
        if (code[i] === '\\' && i + 1 < code.length) {
          i += 2;
          continue;
        }
        if (code[i] === '[') inClass = true;
        else if (code[i] === ']') inClass = false;
        else if (code[i] === '/' && !inClass) {
          i += 1;
          while (i < code.length && /[a-z]/i.test(code[i])) i += 1;
          break;
        } else if (code[i] === '\n') {
          line += 1;
          break;
        }
        i += 1;
      }
      tokens.push({ type: 'punct', value: '<regex>', line });
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1;
      while (end < code.length && /[A-Za-z0-9_$]/.test(code[end])) end += 1;
      const word = code.slice(i, end);
      tokens.push({ type: JS_KEYWORDS.has(word) ? 'keyword' : 'ident', value: word, line });
      i = end;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let end = i + 1;
      while (end < code.length && /[0-9a-fA-FxXoObBn_.]/.test(code[end])) end += 1;
      tokens.push({ type: 'number', value: code.slice(i, end), line });
      i = end;
      continue;
    }
    if (ch === '=' && next === '>') {
      tokens.push({ type: 'punct', value: '=>', line });
      i += 2;
      continue;
    }
    tokens.push({ type: 'punct', value: ch, line });
    i += 1;
  }

  return tokens;
}

/**
 * Reusable C-style lexer for Go, Rust, Java, Kotlin, C#, C/C++, and PHP.
 */
function tokenizeCLikeSource(source, opts = {}) {
  const code = String(source ?? '').replace(/\r\n/g, '\n');
  const keywords = opts.keywords ?? CLIKE_CONTROL_KEYWORDS;
  const tokens = [];
  let i = 0;
  let line = 1;

  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < code.length && code[i] !== '\n') i += 1;
      continue;
    }
    if (opts.hashLineComments && ch === '#') {
      i += 1;
      while (i < code.length && code[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < code.length && depth > 0) {
        if (opts.nestedBlockComments && code[i] === '/' && code[i + 1] === '*') {
          depth += 1;
          i += 2;
          continue;
        }
        if (code[i] === '*' && code[i + 1] === '/') {
          depth -= 1;
          i += 2;
          continue;
        }
        if (code[i] === '\n') line += 1;
        i += 1;
      }
      continue;
    }
    if (opts.rustRawStrings && ch === 'r' && (next === '"' || next === '#')) {
      let hashes = 0;
      let p = i + 1;
      while (p < code.length && code[p] === '#') {
        hashes += 1;
        p += 1;
      }
      if (code[p] === '"') {
        const startLine = line;
        i = p + 1;
        let val = '';
        while (i < code.length) {
          if (code[i] === '"' && code.slice(i + 1, i + 1 + hashes) === '#'.repeat(hashes)) {
            i += 1 + hashes;
            break;
          }
          if (code[i] === '\n') line += 1;
          val += code[i];
          i += 1;
        }
        tokens.push({ type: 'string', value: val, line: startLine });
        continue;
      }
    }
    if (opts.tripleQuotes && ch === '"' && next === '"' && code[i + 2] === '"') {
      const startLine = line;
      i += 3;
      let val = '';
      while (i < code.length) {
        if (code[i] === '"' && code[i + 1] === '"' && code[i + 2] === '"') {
          i += 3;
          break;
        }
        if (code[i] === '\n') line += 1;
        val += code[i];
        i += 1;
      }
      tokens.push({ type: 'string', value: val, line: startLine });
      continue;
    }
    if (opts.backtickStrings && ch === '`') {
      const startLine = line;
      i += 1;
      let val = '';
      while (i < code.length && code[i] !== '`') {
        if (code[i] === '\n') line += 1;
        val += code[i];
        i += 1;
      }
      if (code[i] === '`') i += 1;
      tokens.push({ type: 'string', value: val, line: startLine });
      continue;
    }
    if (ch === '"' || (ch === '\'' && !opts.rustCharLiterals)) {
      const quote = ch;
      const startLine = line;
      let val = '';
      i += 1;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\' && i + 1 < code.length) {
          if (code[i + 1] === '\n') line += 1;
          val += code[i + 1];
          i += 2;
          continue;
        }
        if (code[i] === '\n') {
          line += 1;
          break;
        }
        val += code[i];
        i += 1;
      }
      if (code[i] === quote) i += 1;
      tokens.push({ type: 'string', value: val, line: startLine });
      continue;
    }
    if (opts.rustCharLiterals && ch === '\'') {
      // Distinguish `'a'` char literal from `'a` lifetime
      const esc = next === '\\' ? 2 : 1;
      if (code[i + esc + 1] === '\'') {
        const startLine = line;
        i += esc + 2;
        tokens.push({ type: 'string', value: '<char>', line: startLine });
        continue;
      }
      tokens.push({ type: 'punct', value: '\'', line });
      i += 1;
      continue;
    }
    if ((ch === '$' && opts.dollarIdentifiers && /[A-Za-z_]/.test(next ?? '')) || /[A-Za-z_]/.test(ch)) {
      let end = i + 1;
      while (end < code.length && /[A-Za-z0-9_]/.test(code[end])) end += 1;
      const word = code.slice(i, end);
      const isControl = CLIKE_CONTROL_KEYWORDS.has(word) || keywords.has(word);
      tokens.push({ type: isControl ? 'keyword' : 'ident', value: word, line });
      i = end;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let end = i + 1;
      while (end < code.length && /[0-9a-fA-FxXoObBuUlLfF_.]/.test(code[end])) end += 1;
      tokens.push({ type: 'number', value: code.slice(i, end), line });
      i = end;
      continue;
    }
    if ((ch === ':' && next === ':') || (ch === '-' && next === '>') || (ch === '=' && next === '>')) {
      tokens.push({ type: 'punct', value: ch + next, line });
      i += 2;
      continue;
    }
    tokens.push({ type: 'punct', value: ch, line });
    i += 1;
  }

  return tokens;
}

function findMatchingDelim(tokens, openIdx, openVal, closeVal) {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    if (tokens[i].value === openVal) depth += 1;
    else if (tokens[i].value === closeVal) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipAngleBrackets(tokens, idx) {
  if (tokens[idx]?.value !== '<') return idx;
  let depth = 0;
  for (let i = idx; i < Math.min(tokens.length, idx + 80); i++) {
    const v = tokens[i].value;
    if (v === '<') depth += 1;
    else if (v === '>') {
      depth -= 1;
      if (depth === 0) return i + 1;
    } else if (v === '{' || v === '}' || v === ';') {
      return idx;
    }
  }
  return idx;
}

function findFunctionBodyOpenBrace(tokens, afterCloseParenIdx, maxScan = 60) {
  let angleDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let i = afterCloseParenIdx; i < Math.min(tokens.length, afterCloseParenIdx + maxScan); i++) {
    const v = tokens[i].value;
    if (v === '(') parenDepth += 1;
    else if (v === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (v === '[') bracketDepth += 1;
    else if (v === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (v === '<') angleDepth += 1;
    else if (v === '>' && angleDepth > 0) angleDepth -= 1;
    else if (parenDepth === 0 && bracketDepth === 0 && angleDepth === 0) {
      if (v === '{') return i;
      if (v === ';' || v === '=>') return -1;
    }
  }
  return -1;
}

function fileExistsInContext(relPosix, repoRoot, repoContext) {
  if (repoContext?.allFileSet) {
    return repoContext.allFileSet.has(relPosix);
  }
  const abs = path.join(repoRoot, relPosix);
  return fs.existsSync(abs) && fs.statSync(abs).isFile();
}

function resolveJsImportSpecifier(fromRelPath, specifier, repoRoot, repoContext) {
  if (!specifier || (!specifier.startsWith('./') && !specifier.startsWith('../'))) {
    return null;
  }
  const fromDir = path.posix.dirname(toPosixPath(fromRelPath));
  const rawTarget = path.posix.normalize(path.posix.join(fromDir, specifier));
  if (rawTarget.startsWith('..')) return null;

  const altTargets = [rawTarget];
  if (rawTarget.endsWith('.js')) altTargets.push(rawTarget.replace(/\.js$/, '.ts'), rawTarget.replace(/\.js$/, '.tsx'));
  if (rawTarget.endsWith('.mjs')) altTargets.push(rawTarget.replace(/\.mjs$/, '.mts'));
  if (rawTarget.endsWith('.cjs')) altTargets.push(rawTarget.replace(/\.cjs$/, '.cts'));

  const exts = ['', '.mjs', '.js', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'];
  const indexExts = ['/index.mjs', '/index.js', '/index.ts', '/index.tsx'];
  for (const base of altTargets) {
    for (const ext of exts) {
      const cand = `${base}${ext}`;
      if (fileExistsInContext(cand, repoRoot, repoContext)) return cand;
    }
    for (const idxExt of indexExts) {
      const cand = `${base}${idxExt}`;
      if (fileExistsInContext(cand, repoRoot, repoContext)) return cand;
    }
  }
  return null;
}

function isExportedAt(tokens, idx) {
  for (let back = 1; back <= 3; back++) {
    const t = tokens[idx - back];
    if (!t) break;
    if (t.value === 'export') return true;
    if (t.value === ';' || t.value === '}') break;
  }
  return false;
}

function parseJsImportClause(clauseTokens, targetFile, outBindings) {
  let i = 0;
  while (i < clauseTokens.length) {
    const t = clauseTokens[i];
    if (t.value === '*' && clauseTokens[i + 1]?.value === 'as' && clauseTokens[i + 2]?.type === 'ident') {
      outBindings.push({ localName: clauseTokens[i + 2].value, targetFile, importedName: '*', kind: 'namespace' });
      i += 3;
      continue;
    }
    if (t.value === '{') {
      i += 1;
      while (i < clauseTokens.length && clauseTokens[i].value !== '}') {
        if (clauseTokens[i].type === 'ident') {
          const importedName = clauseTokens[i].value;
          if (clauseTokens[i + 1]?.value === 'as' && clauseTokens[i + 2]?.type === 'ident') {
            outBindings.push({ localName: clauseTokens[i + 2].value, targetFile, importedName, kind: 'named' });
            i += 3;
            continue;
          }
          outBindings.push({ localName: importedName, targetFile, importedName, kind: 'named' });
        }
        i += 1;
      }
      i += 1;
      continue;
    }
    if (t.type === 'ident' && t.value !== 'type') {
      outBindings.push({ localName: t.value, targetFile, importedName: 'default', kind: 'default' });
    }
    i += 1;
  }
}

function parseJsTsModule(posixPath, language, code, repoRoot, repoContext) {
  const tokens = tokenizeJsSource(code);
  const imports = new Set();
  const importBindings = [];
  const classes = [];
  const functions = [];
  const moduleCalls = [];
  const pendingFunctionBody = new Map();

  let braceDepth = 0;
  const classStack = [];
  const funcStack = [];
  let pendingExprArrow = null;

  const recordCall = (callObj) => {
    const activeFn = pendingExprArrow?.fn ?? funcStack[funcStack.length - 1];
    if (activeFn) activeFn.calls.push(callObj);
    else moduleCalls.push(callObj);
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if (pendingExprArrow) {
      if (tok.value === '(') pendingExprArrow.parenDepth += 1;
      else if (tok.value === ')') pendingExprArrow.parenDepth = Math.max(0, pendingExprArrow.parenDepth - 1);
      else if (tok.value === '[') pendingExprArrow.bracketDepth += 1;
      else if (tok.value === ']') pendingExprArrow.bracketDepth = Math.max(0, pendingExprArrow.bracketDepth - 1);
      else if (
        tok.value === ';' &&
        braceDepth === pendingExprArrow.startBraceDepth &&
        pendingExprArrow.parenDepth === 0 &&
        pendingExprArrow.bracketDepth === 0
      ) {
        pendingExprArrow.fn.end_line = tok.line;
        pendingExprArrow = null;
      } else if (
        braceDepth === pendingExprArrow.startBraceDepth &&
        pendingExprArrow.parenDepth === 0 &&
        pendingExprArrow.bracketDepth === 0 &&
        tok.type === 'keyword' &&
        (tok.value === 'export' || tok.value === 'const' || tok.value === 'let' || tok.value === 'var' || tok.value === 'function' || tok.value === 'class')
      ) {
        pendingExprArrow.fn.end_line = tokens[i - 1]?.line ?? pendingExprArrow.fn.start_line;
        pendingExprArrow = null;
      }
    }

    if (tok.type === 'keyword' && (tok.value === 'import' || tok.value === 'export')) {
      const nextTok = tokens[i + 1];
      if (tok.value === 'import' && nextTok?.value === '(') {
        const argTok = tokens[i + 2];
        if (argTok?.type === 'string') {
          const target = resolveJsImportSpecifier(posixPath, argTok.value, repoRoot, repoContext);
          if (target) {
            imports.add(target);
            importBindings.push({ localName: '*', targetFile: target, importedName: '*', kind: 'namespace' });
          }
        }
      } else if (tok.value === 'import' && nextTok?.type === 'string') {
        const target = resolveJsImportSpecifier(posixPath, nextTok.value, repoRoot, repoContext);
        if (target) {
          imports.add(target);
          importBindings.push({ localName: '*', targetFile: target, importedName: '*', kind: 'side_effect' });
        }
      } else if (tok.value === 'import' || (tok.value === 'export' && (nextTok?.value === '{' || nextTok?.value === '*'))) {
        let j = i + 1;
        while (j < tokens.length && tokens[j].value !== ';' && tokens[j].value !== 'from' && tokens[j].line - tok.line <= 25) {
          j += 1;
        }
        if (tokens[j]?.value === 'from' && tokens[j + 1]?.type === 'string') {
          const target = resolveJsImportSpecifier(posixPath, tokens[j + 1].value, repoRoot, repoContext);
          if (target) {
            imports.add(target);
            parseJsImportClause(tokens.slice(i + 1, j), target, importBindings);
          }
          i = j + 1;
          continue;
        }
      }
    }

    if (tok.type === 'ident' && tok.value === 'require' && tokens[i + 1]?.value === '(' && tokens[i + 2]?.type === 'string') {
      const target = resolveJsImportSpecifier(posixPath, tokens[i + 2].value, repoRoot, repoContext);
      if (target) {
        imports.add(target);
        if (i >= 2 && tokens[i - 1].value === '=' && tokens[i - 2].type === 'ident') {
          importBindings.push({ localName: tokens[i - 2].value, targetFile: target, importedName: '*', kind: 'namespace' });
        } else {
          importBindings.push({ localName: '*', targetFile: target, importedName: '*', kind: 'namespace' });
        }
      }
    }

    if (tok.type === 'keyword' && tok.value === 'class' && tokens[i + 1]?.type === 'ident') {
      const className = tokens[i + 1].value;
      const exported = isExportedAt(tokens, i);
      let openBraceIdx = i + 2;
      while (openBraceIdx < tokens.length && tokens[openBraceIdx].value !== '{' && tokens[openBraceIdx].value !== ';') {
        openBraceIdx += 1;
      }
      if (tokens[openBraceIdx]?.value === '{') {
        const cls = {
          name: className,
          qualified_name: `${posixPath}::${className}`,
          file: posixPath,
          start_line: tok.line,
          end_line: tok.line,
          exported,
          bodyDepth: braceDepth + 1,
          methods: [],
        };
        classes.push(cls);
        classStack.push(cls);
      }
    }

    if (tok.type === 'keyword' && tok.value === 'function') {
      let nameIdx = i + 1;
      if (tokens[nameIdx]?.value === '*') nameIdx += 1;
      if (tokens[nameIdx]?.type === 'ident') {
        const parenStart = skipAngleBrackets(tokens, nameIdx + 1);
        if (tokens[parenStart]?.value === '(') {
          const fnName = tokens[nameIdx].value;
          const closeParen = findMatchingDelim(tokens, parenStart, '(', ')');
          const openBraceIdx = closeParen !== -1 ? findFunctionBodyOpenBrace(tokens, closeParen + 1) : -1;
          if (openBraceIdx !== -1) {
            const startLine = tokens[i - 1]?.value === 'async' ? tokens[i - 1].line : tok.line;
            const fn = {
              name: fnName,
              qualified_name: `${posixPath}::${fnName}`,
              class_name: null,
              file: posixPath,
              start_line: startLine,
              end_line: startLine,
              exported: isExportedAt(tokens, i),
              calls: [],
            };
            functions.push(fn);
            pendingFunctionBody.set(openBraceIdx, fn);
          }
        }
      }
    }

    if (tok.type === 'keyword' && (tok.value === 'const' || tok.value === 'let' || tok.value === 'var')) {
      const nameTok = tokens[i + 1];
      if (nameTok?.type === 'ident') {
        let eqIdx = i + 2;
        if (tokens[eqIdx]?.value === ':') {
          let angleD = 0;
          let parenD = 0;
          let braceD = 0;
          eqIdx += 1;
          while (eqIdx < tokens.length && eqIdx < i + 40) {
            const tv = tokens[eqIdx].value;
            if (tv === '<') angleD += 1;
            else if (tv === '>' && angleD > 0) angleD -= 1;
            else if (tv === '(') parenD += 1;
            else if (tv === ')') parenD = Math.max(0, parenD - 1);
            else if (tv === '{') braceD += 1;
            else if (tv === '}') braceD = Math.max(0, braceD - 1);
            else if (angleD === 0 && parenD === 0 && braceD === 0 && (tv === '=' || tv === ';')) break;
            eqIdx += 1;
          }
        }
        if (tokens[eqIdx]?.value === '=') {
          let rhs = eqIdx + 1;
          if (tokens[rhs]?.value === 'async') rhs += 1;
          rhs = skipAngleBrackets(tokens, rhs);
          if (tokens[rhs]?.value === '(') {
            const closeP = findMatchingDelim(tokens, rhs, '(', ')');
            let arrowIdx = closeP + 1;
            if (closeP !== -1) {
              while (arrowIdx < tokens.length && arrowIdx < closeP + 30 && tokens[arrowIdx].value !== '=>' && tokens[arrowIdx].value !== ';' && tokens[arrowIdx].value !== '{') {
                arrowIdx += 1;
              }
            }
            if (closeP !== -1 && tokens[arrowIdx]?.value === '=>') {
              const fn = {
                name: nameTok.value,
                qualified_name: `${posixPath}::${nameTok.value}`,
                class_name: null,
                file: posixPath,
                start_line: tok.line,
                end_line: tok.line,
                exported: isExportedAt(tokens, i),
                calls: [],
              };
              functions.push(fn);
              if (tokens[arrowIdx + 1]?.value === '{') {
                pendingFunctionBody.set(arrowIdx + 1, fn);
              } else {
                pendingExprArrow = { fn, startBraceDepth: braceDepth, parenDepth: 0, bracketDepth: 0 };
              }
            }
          } else if (tokens[rhs]?.type === 'ident' && tokens[rhs + 1]?.value === '=>') {
            const fn = {
              name: nameTok.value,
              qualified_name: `${posixPath}::${nameTok.value}`,
              class_name: null,
              file: posixPath,
              start_line: tok.line,
              end_line: tok.line,
              exported: isExportedAt(tokens, i),
              calls: [],
            };
            functions.push(fn);
            if (tokens[rhs + 2]?.value === '{') {
              pendingFunctionBody.set(rhs + 2, fn);
            } else {
              pendingExprArrow = { fn, startBraceDepth: braceDepth, parenDepth: 0, bracketDepth: 0 };
            }
          } else if (tokens[rhs]?.value === 'function') {
            let pIdx = tokens[rhs + 1]?.type === 'ident' ? rhs + 2 : rhs + 1;
            pIdx = skipAngleBrackets(tokens, pIdx);
            if (tokens[pIdx]?.value === '(') {
              const closeP = findMatchingDelim(tokens, pIdx, '(', ')');
              const openBraceIdx = closeP !== -1 ? findFunctionBodyOpenBrace(tokens, closeP + 1) : -1;
              if (openBraceIdx !== -1) {
                const fn = {
                  name: nameTok.value,
                  qualified_name: `${posixPath}::${nameTok.value}`,
                  class_name: null,
                  file: posixPath,
                  start_line: tok.line,
                  end_line: tok.line,
                  exported: isExportedAt(tokens, i),
                  calls: [],
                };
                functions.push(fn);
                pendingFunctionBody.set(openBraceIdx, fn);
              }
            }
          }
        }
      }
    }

    const activeClass = classStack[classStack.length - 1];
    if (
      activeClass &&
      braceDepth === activeClass.bodyDepth &&
      tok.type === 'ident' &&
      (tokens[i + 1]?.value === '(' || tokens[i + 1]?.value === '<') &&
      tokens[i - 1]?.value !== '.' &&
      tokens[i - 1]?.value !== 'new' &&
      tokens[i - 1]?.value !== 'function'
    ) {
      const parenStart = skipAngleBrackets(tokens, i + 1);
      if (tokens[parenStart]?.value === '(') {
        const closeP = findMatchingDelim(tokens, parenStart, '(', ')');
        const openBraceIdx = closeP !== -1 ? findFunctionBodyOpenBrace(tokens, closeP + 1) : -1;
        if (openBraceIdx !== -1) {
          const methodName = tok.value;
          const fn = {
            name: methodName,
            qualified_name: `${posixPath}::${activeClass.name}.${methodName}`,
            class_name: activeClass.name,
            file: posixPath,
            start_line: tok.line,
            end_line: tok.line,
            exported: activeClass.exported,
            calls: [],
          };
          activeClass.methods.push(methodName);
          functions.push(fn);
          pendingFunctionBody.set(openBraceIdx, fn);
        }
      }
    }

    if (tok.type === 'ident' && tokens[i + 1]?.value === '(') {
      const prevVal = tokens[i - 1]?.value;
      const isDecl = prevVal === 'function' || prevVal === 'class' || (activeClass && braceDepth === activeClass.bodyDepth);
      if (!isDecl) {
        if (prevVal === '.' && tokens[i - 2]?.type === 'ident') {
          recordCall({ kind: 'member', object: tokens[i - 2].value, name: tok.value, line: tok.line });
        } else if (prevVal === 'new') {
          recordCall({ kind: 'construct', object: null, name: tok.value, line: tok.line });
        } else {
          recordCall({ kind: 'direct', object: null, name: tok.value, line: tok.line });
        }
      }
    } else if (
      tok.type === 'ident' &&
      tokens[i - 1]?.value !== '.' &&
      tokens[i + 1]?.value !== ':' &&
      tokens[i - 1]?.value !== 'function' &&
      tokens[i - 1]?.value !== 'class'
    ) {
      recordCall({ kind: 'ref', object: null, name: tok.value, line: tok.line });
    }

    if (tok.value === '{') {
      braceDepth += 1;
      const fnStarting = pendingFunctionBody.get(i);
      if (fnStarting) {
        fnStarting.bodyDepth = braceDepth;
        funcStack.push(fnStarting);
      }
    } else if (tok.value === '}') {
      const activeFn = funcStack[funcStack.length - 1];
      if (activeFn && braceDepth === activeFn.bodyDepth) {
        activeFn.end_line = tok.line;
        funcStack.pop();
      }
      if (activeClass && braceDepth === activeClass.bodyDepth) {
        activeClass.end_line = tok.line;
        classStack.pop();
      }
      braceDepth = Math.max(0, braceDepth - 1);
    }
  }

  if (pendingExprArrow) {
    pendingExprArrow.fn.end_line = tokens[tokens.length - 1]?.line ?? pendingExprArrow.fn.start_line;
  }

  return {
    file: posixPath,
    language,
    packageKey: null,
    imports: [...imports].sort(),
    importBindings,
    classes,
    functions,
    moduleCalls,
  };
}

/**
 * Mask Python comments and string literals while keeping exact line breaks and code structure.
 */
function stripPythonStringsAndComments(source) {
  const code = String(source ?? '').replace(/\r\n/g, '\n');
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '#') {
      while (i < code.length && code[i] !== '\n') i += 1;
      continue;
    }
    const isTriple = (code[i] === '\'' || code[i] === '"') && code[i + 1] === code[i] && code[i + 2] === code[i];
    if (isTriple) {
      const q = code[i];
      i += 3;
      out += '""';
      while (i < code.length) {
        if (code[i] === '\\' && i + 1 < code.length) {
          if (code[i + 1] === '\n') out += '\n';
          i += 2;
          continue;
        }
        if (code[i] === q && code[i + 1] === q && code[i + 2] === q) {
          i += 3;
          break;
        }
        if (code[i] === '\n') out += '\n';
        i += 1;
      }
      continue;
    }
    if (ch === '\'' || ch === '"') {
      const q = ch;
      i += 1;
      out += '""';
      while (i < code.length && code[i] !== q) {
        if (code[i] === '\\' && i + 1 < code.length) {
          if (code[i + 1] === '\n') out += '\n';
          i += 2;
          continue;
        }
        if (code[i] === '\n') break;
        i += 1;
      }
      if (code[i] === q) i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function resolvePythonModulePath(fromRelPath, modSpec, subItem, repoRoot, repoContext) {
  const cleanFrom = toPosixPath(fromRelPath);
  const fromDir = path.posix.dirname(cleanFrom);
  const subCandidates = [];
  const modCandidates = [];

  const dotMatch = modSpec.match(/^(\.+)(.*)$/);
  if (dotMatch) {
    const dots = dotMatch[1].length;
    const rest = dotMatch[2].replace(/\./g, '/');
    let baseDir = fromDir;
    for (let k = 1; k < dots; k++) {
      baseDir = path.posix.dirname(baseDir);
    }
    const targetBase = rest ? (baseDir === '.' ? rest : path.posix.normalize(`${baseDir}/${rest}`)) : baseDir;
    if (!targetBase.startsWith('..')) {
      if (subItem) {
        const subBase = targetBase === '.' ? subItem : `${targetBase}/${subItem}`;
        subCandidates.push(`${subBase}.py`, `${subBase}.pyi`, `${subBase}/__init__.py`);
      }
      if (targetBase && targetBase !== '.') {
        modCandidates.push(`${targetBase}.py`, `${targetBase}.pyi`, `${targetBase}/__init__.py`);
      }
    }
  } else {
    const relMod = modSpec.replace(/\./g, '/');
    for (const rootPrefix of ['', 'src', 'lib', 'app']) {
      const base = rootPrefix ? `${rootPrefix}/${relMod}` : relMod;
      if (subItem) {
        subCandidates.push(`${base}/${subItem}.py`, `${base}/${subItem}.pyi`, `${base}/${subItem}/__init__.py`);
      }
      modCandidates.push(`${base}.py`, `${base}.pyi`, `${base}/__init__.py`);
    }
  }

  for (const cand of modCandidates) {
    const norm = path.posix.normalize(cand);
    if (fileExistsInContext(norm, repoRoot, repoContext)) return { targetFile: norm, isSubmodule: false };
  }
  for (const cand of subCandidates) {
    const norm = path.posix.normalize(cand);
    if (fileExistsInContext(norm, repoRoot, repoContext)) return { targetFile: norm, isSubmodule: true };
  }
  return null;
}

function extractCallsFromText(text, lineNum, keywordsSet, recordCall) {
  const rx = /(?:([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.|::|->)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*(\()?/g;
  for (const m of text.matchAll(rx)) {
    const obj = m[1] ?? null;
    const name = m[2];
    const isCall = m[3] === '(';
    if (keywordsSet.has(name)) continue;
    if (obj && isCall) {
      recordCall({ kind: 'member', object: obj, name, line: lineNum });
    } else if (isCall) {
      recordCall({ kind: 'direct', object: null, name, line: lineNum });
    } else if (!obj) {
      recordCall({ kind: 'ref', object: null, name, line: lineNum });
    }
  }
}

const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
  'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global',
  'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
  'try', 'while', 'with', 'yield', 'self', 'cls',
]);

function parsePythonModule(posixPath, code, repoRoot, repoContext) {
  const cleaned = stripPythonStringsAndComments(code);
  const lines = cleaned.split('\n');
  const imports = new Set();
  const importBindings = [];
  const classes = [];
  const functions = [];
  const moduleCalls = [];
  const scopeStack = []; // { kind: 'class'|'function', indent, obj }

  let parenDepth = 0;
  let logicalBuf = '';
  let logicalStartLine = 1;
  let logicalIndent = 0;
  let lastCodeLine = 1;

  const countParens = (str) => {
    let delta = 0;
    for (const ch of str) {
      if (ch === '(' || ch === '[' || ch === '{') delta += 1;
      else if (ch === ')' || ch === ']' || ch === '}') delta -= 1;
    }
    return delta;
  };

  const closeScopesAtIndent = (indent, closedEndLine) => {
    while (scopeStack.length > 0 && indent <= scopeStack[scopeStack.length - 1].indent) {
      const top = scopeStack.pop();
      top.obj.end_line = Math.max(top.obj.start_line, closedEndLine);
    }
  };

  const activeFn = () => {
    for (let k = scopeStack.length - 1; k >= 0; k--) {
      if (scopeStack[k].kind === 'function') return scopeStack[k].obj;
    }
    return null;
  };

  const activeClass = () => {
    for (let k = scopeStack.length - 1; k >= 0; k--) {
      if (scopeStack[k].kind === 'class') return scopeStack[k].obj;
    }
    return null;
  };

  const processLogicalLine = (stmt, startLine, indent) => {
    const trimmed = stmt.trim();
    if (!trimmed) return;

    closeScopesAtIndent(indent, Math.max(1, startLine - 1));

    const fromMatch = trimmed.match(/^from\s+(\.+[A-Za-z0-9_.]*|[A-Za-z0-9_.]+)\s+import\s+(.+)$/);
    if (fromMatch) {
      const modSpec = fromMatch[1].trim();
      const itemsPart = fromMatch[2].replace(/[()]/g, '').trim();
      for (const piece of itemsPart.split(',')) {
        const cleanPiece = piece.trim();
        if (!cleanPiece) continue;
        if (cleanPiece === '*') {
          const resolved = resolvePythonModulePath(posixPath, modSpec, null, repoRoot, repoContext);
          if (resolved) {
            imports.add(resolved.targetFile);
            importBindings.push({ localName: '*', targetFile: resolved.targetFile, importedName: '*', kind: 'namespace' });
          }
          continue;
        }
        const aliasMatch = cleanPiece.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/);
        if (aliasMatch) {
          const importedName = aliasMatch[1];
          const localName = aliasMatch[2] ?? importedName;
          const resolved = resolvePythonModulePath(posixPath, modSpec, importedName, repoRoot, repoContext);
          if (resolved) {
            imports.add(resolved.targetFile);
            importBindings.push({
              localName,
              targetFile: resolved.targetFile,
              importedName: resolved.isSubmodule ? '*' : importedName,
              kind: resolved.isSubmodule ? 'namespace' : 'named',
            });
          }
        }
      }
      return;
    }

    if (trimmed.startsWith('import ')) {
      const rest = trimmed.slice('import '.length);
      for (const piece of rest.split(',')) {
        const m = piece.trim().match(/^([A-Za-z0-9_.]+)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/);
        if (m) {
          const resolved = resolvePythonModulePath(posixPath, m[1], null, repoRoot, repoContext);
          if (resolved) {
            imports.add(resolved.targetFile);
            const localName = m[2] ?? m[1].split('.')[0];
            importBindings.push({ localName, targetFile: resolved.targetFile, importedName: '*', kind: 'namespace' });
          }
        }
      }
      return;
    }

    const clsMatch = trimmed.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (clsMatch) {
      const className = clsMatch[1];
      const cls = {
        name: className,
        qualified_name: `${posixPath}::${className}`,
        file: posixPath,
        start_line: startLine,
        end_line: startLine,
        exported: !className.startsWith('_'),
        methods: [],
      };
      classes.push(cls);
      scopeStack.push({ kind: 'class', indent, obj: cls });
      return;
    }

    const defMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (defMatch) {
      const fnName = defMatch[1];
      const parentCls = activeClass();
      const fn = {
        name: fnName,
        qualified_name: parentCls ? `${posixPath}::${parentCls.name}.${fnName}` : `${posixPath}::${fnName}`,
        class_name: parentCls ? parentCls.name : null,
        file: posixPath,
        start_line: startLine,
        end_line: startLine,
        exported: !fnName.startsWith('_'),
        calls: [],
      };
      if (parentCls) parentCls.methods.push(fnName);
      functions.push(fn);
      scopeStack.push({ kind: 'function', indent, obj: fn });
      return;
    }

    const targetCalls = activeFn()?.calls ?? moduleCalls;
    extractCallsFromText(trimmed, startLine, PYTHON_KEYWORDS, (c) => targetCalls.push(c));
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    const lineNum = idx + 1;
    const trimmed = raw.trim();
    if (!trimmed && parenDepth === 0) continue;
    if (trimmed) lastCodeLine = lineNum;

    if (parenDepth === 0) {
      logicalIndent = raw.match(/^\s*/)[0].length;
      logicalStartLine = lineNum;
      logicalBuf = trimmed;
    } else {
      logicalBuf += ` ${trimmed}`;
    }

    parenDepth = Math.max(0, parenDepth + countParens(trimmed));
    if (parenDepth === 0 && logicalBuf) {
      processLogicalLine(logicalBuf, logicalStartLine, logicalIndent);
      logicalBuf = '';
    }
  }
  if (logicalBuf) {
    processLogicalLine(logicalBuf, logicalStartLine, logicalIndent);
  }
  closeScopesAtIndent(-1, lastCodeLine);

  return {
    file: posixPath,
    language: 'python',
    packageKey: null,
    imports: [...imports].sort(),
    importBindings,
    classes,
    functions,
    moduleCalls,
  };
}

const GO_KEYWORDS = new Set([
  'break', 'default', 'func', 'interface', 'select', 'case', 'defer', 'go', 'map', 'struct',
  'chan', 'else', 'goto', 'package', 'switch', 'const', 'fallthrough', 'if', 'range', 'type',
  'continue', 'for', 'import', 'return', 'var', 'true', 'false', 'nil',
]);

function resolveGoImportFiles(impPath, repoContext) {
  if (!impPath) return [];
  if (repoContext.goModule) {
    if (impPath === repoContext.goModule) {
      return (repoContext.goFilesByDir.get('.') ?? []).filter((f) => !f.endsWith('_test.go'));
    }
    if (impPath.startsWith(`${repoContext.goModule}/`)) {
      const relDir = impPath.slice(repoContext.goModule.length + 1);
      return (repoContext.goFilesByDir.get(relDir) ?? []).filter((f) => !f.endsWith('_test.go'));
    }
  }
  for (const [dir, files] of repoContext.goFilesByDir.entries()) {
    if (dir !== '.' && (impPath === dir || impPath.endsWith(`/${dir}`))) {
      return files.filter((f) => !f.endsWith('_test.go'));
    }
  }
  return [];
}

function parseGoModule(posixPath, code, repoContext) {
  const tokens = tokenizeCLikeSource(code, { keywords: GO_KEYWORDS, backtickStrings: true });
  const imports = new Set();
  const importBindings = [];
  const classes = [];
  const functions = [];
  const moduleCalls = [];
  const pendingFunctionBody = new Map();

  let packageName = 'main';
  for (let i = 0; i < Math.min(tokens.length, 30); i++) {
    if (tokens[i].value === 'package' && tokens[i + 1]?.type === 'ident') {
      packageName = tokens[i + 1].value;
      break;
    }
  }
  const dir = path.posix.dirname(posixPath);
  const packageKey = `go:${dir}::${packageName}`;

  let braceDepth = 0;
  const funcStack = [];
  const recordCall = (callObj) => {
    const activeFn = funcStack[funcStack.length - 1];
    if (activeFn) activeFn.calls.push(callObj);
    else moduleCalls.push(callObj);
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if (braceDepth === 0 && tok.value === 'import') {
      if (tokens[i + 1]?.value === '(') {
        let j = i + 2;
        while (j < tokens.length && tokens[j].value !== ')') {
          if (tokens[j].type === 'string') {
            const impPath = tokens[j].value;
            const maybeAlias = tokens[j - 1];
            const alias = maybeAlias && maybeAlias.line === tokens[j].line && (maybeAlias.type === 'ident' || maybeAlias.value === '.')
              ? maybeAlias.value
              : path.posix.basename(impPath);
            for (const f of resolveGoImportFiles(impPath, repoContext)) {
              imports.add(f);
              importBindings.push({ localName: alias === '.' ? '*' : alias, targetFile: f, importedName: '*', kind: 'namespace' });
            }
          }
          j += 1;
        }
        i = j;
        continue;
      }
      const strTok = tokens[i + 1]?.type === 'string' ? tokens[i + 1] : (tokens[i + 2]?.type === 'string' ? tokens[i + 2] : null);
      if (strTok) {
        const alias = tokens[i + 1]?.type === 'string' ? path.posix.basename(strTok.value) : tokens[i + 1].value;
        for (const f of resolveGoImportFiles(strTok.value, repoContext)) {
          imports.add(f);
          importBindings.push({ localName: alias === '.' ? '*' : alias, targetFile: f, importedName: '*', kind: 'namespace' });
        }
      }
    }

    if (braceDepth === 0 && tok.value === 'type' && tokens[i + 1]?.type === 'ident' && (tokens[i + 2]?.value === 'struct' || tokens[i + 2]?.value === 'interface')) {
      const typeName = tokens[i + 1].value;
      const openB = tokens[i + 3]?.value === '{' ? i + 3 : -1;
      let endLine = tok.line;
      if (openB !== -1) {
        const closeB = findMatchingDelim(tokens, openB, '{', '}');
        if (closeB !== -1) endLine = tokens[closeB].line;
      }
      classes.push({
        name: typeName,
        qualified_name: `${posixPath}::${typeName}`,
        file: posixPath,
        start_line: tok.line,
        end_line: endLine,
        exported: /^[A-Z]/.test(typeName),
        methods: [],
      });
    }

    if (braceDepth === 0 && tok.value === 'func') {
      let ptr = i + 1;
      let recvType = null;
      if (tokens[ptr]?.value === '(') {
        const recvClose = findMatchingDelim(tokens, ptr, '(', ')');
        if (recvClose !== -1) {
          for (let k = recvClose - 1; k > ptr; k--) {
            if (tokens[k].type === 'ident') {
              recvType = tokens[k].value;
              break;
            }
          }
          ptr = recvClose + 1;
        }
      }
      if (tokens[ptr]?.type === 'ident' && tokens[ptr + 1]?.value === '(') {
        const fnName = tokens[ptr].value;
        const paramClose = findMatchingDelim(tokens, ptr + 1, '(', ')');
        let openBrace = -1;
        if (paramClose !== -1) {
          for (let k = paramClose + 1; k < Math.min(tokens.length, paramClose + 25); k++) {
            const v = tokens[k].value;
            if (v === '{') {
              if (tokens[k - 1]?.value === 'interface' || tokens[k - 1]?.value === 'struct') {
                const skipEnd = findMatchingDelim(tokens, k, '{', '}');
                if (skipEnd !== -1) {
                  k = skipEnd;
                  continue;
                }
              }
              openBrace = k;
              break;
            }
            if (v === ';') break;
          }
        }
        if (openBrace !== -1) {
          const fn = {
            name: fnName,
            qualified_name: recvType ? `${posixPath}::${recvType}.${fnName}` : `${posixPath}::${fnName}`,
            class_name: recvType,
            file: posixPath,
            start_line: tok.line,
            end_line: tok.line,
            exported: /^[A-Z]/.test(fnName),
            calls: [],
          };
          functions.push(fn);
          pendingFunctionBody.set(openBrace, fn);
        }
      }
    }

    if (tok.type === 'ident' && tokens[i + 1]?.value === '(') {
      const prevVal = tokens[i - 1]?.value;
      const isDecl = braceDepth === 0 && (prevVal === 'func' || tokens[i - 1]?.value === ')');
      if (!isDecl) {
        if (prevVal === '.' && tokens[i - 2]?.type === 'ident') {
          recordCall({ kind: 'member', object: tokens[i - 2].value, name: tok.value, line: tok.line });
        } else {
          recordCall({ kind: 'direct', object: null, name: tok.value, line: tok.line });
        }
      }
    } else if (tok.type === 'ident' && tokens[i - 1]?.value !== '.' && tokens[i - 1]?.value !== 'type' && tokens[i - 1]?.value !== 'package') {
      recordCall({ kind: 'ref', object: null, name: tok.value, line: tok.line });
    }

    if (tok.value === '{') {
      braceDepth += 1;
      const fnStarting = pendingFunctionBody.get(i);
      if (fnStarting) {
        fnStarting.bodyDepth = braceDepth;
        funcStack.push(fnStarting);
      }
    } else if (tok.value === '}') {
      const activeFn = funcStack[funcStack.length - 1];
      if (activeFn && braceDepth === activeFn.bodyDepth) {
        activeFn.end_line = tok.line;
        funcStack.pop();
      }
      braceDepth = Math.max(0, braceDepth - 1);
    }
  }

  return {
    file: posixPath,
    language: 'go',
    packageKey,
    imports: [...imports].sort(),
    importBindings,
    classes,
    functions,
    moduleCalls,
  };
}

const RUST_KEYWORDS = new Set([
  'as', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'extern', 'false', 'fn', 'for',
  'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return',
  'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use',
  'where', 'while', 'async', 'await', 'dyn',
]);

function flattenRustUseTokens(tokens, prefixSegments = []) {
  const results = [];
  let segs = [...prefixSegments];
  let i = 0;
  while (i < tokens.length) {
    const v = tokens[i].value;
    if (v === '{') {
      const closeIdx = findMatchingDelim(tokens, i, '{', '}');
      if (closeIdx === -1) break;
      const inner = tokens.slice(i + 1, closeIdx);
      results.push(...flattenRustUseTokens(inner, segs));
      segs = [...prefixSegments];
      i = closeIdx + 1;
      continue;
    }
    if (v === ',') {
      if (segs.length > prefixSegments.length) results.push({ path: segs, alias: null });
      segs = [...prefixSegments];
      i += 1;
      continue;
    }
    if (v === 'as' && tokens[i + 1]?.type === 'ident') {
      results.push({ path: segs, alias: tokens[i + 1].value });
      segs = [...prefixSegments];
      i += 2;
      continue;
    }
    if (v === '::') {
      i += 1;
      continue;
    }
    if (tokens[i].type === 'ident' || v === 'crate' || v === 'self' || v === 'super' || v === '*') {
      segs.push(v);
    }
    i += 1;
  }
  if (segs.length > prefixSegments.length) {
    results.push({ path: segs, alias: null });
  }
  return results;
}

function resolveRustModulePath(fromPosix, segs, repoRoot, repoContext) {
  if (!segs.length) return null;
  let baseDir = '';
  let rest = segs;
  const fromDir = path.posix.dirname(fromPosix);
  const fromStem = path.posix.basename(fromPosix, '.rs');

  if (segs[0] === 'crate' || (repoContext.rustCrateName && segs[0] === repoContext.rustCrateName)) {
    baseDir = fileExistsInContext('src/lib.rs', repoRoot, repoContext) || fileExistsInContext('src/main.rs', repoRoot, repoContext)
      ? 'src'
      : '';
    rest = segs.slice(1);
  } else if (segs[0] === 'self') {
    baseDir = (fromStem === 'mod' || fromStem === 'lib' || fromStem === 'main')
      ? fromDir
      : (fromDir === '.' ? fromStem : `${fromDir}/${fromStem}`);
    rest = segs.slice(1);
  } else if (segs[0] === 'super') {
    let cur = fromDir;
    let idx = 0;
    while (rest[idx] === 'super') {
      if (idx === 0 && (fromStem !== 'mod' && fromStem !== 'lib' && fromStem !== 'main')) {
        // Parent of `a/b.rs` is `a` (fromDir)
      } else {
        cur = path.posix.dirname(cur);
      }
      idx += 1;
    }
    baseDir = cur;
    rest = segs.slice(idx);
  } else {
    baseDir = (fromStem === 'mod' || fromStem === 'lib' || fromStem === 'main')
      ? (fromDir === '.' ? '' : fromDir)
      : (fileExistsInContext('src/lib.rs', repoRoot, repoContext) ? 'src' : '');
  }

  for (let len = rest.length; len >= 1; len--) {
    const modPath = rest.slice(0, len).join('/');
    const prefix = baseDir && baseDir !== '.' ? `${baseDir}/${modPath}` : modPath;
    for (const cand of [`${prefix}.rs`, `${prefix}/mod.rs`]) {
      const norm = path.posix.normalize(cand);
      if (fileExistsInContext(norm, repoRoot, repoContext)) {
        return {
          targetFile: norm,
          importedName: len < rest.length ? rest[len] : '*',
        };
      }
    }
  }
  const crateRoot = fileExistsInContext('src/lib.rs', repoRoot, repoContext) ? 'src/lib.rs' : null;
  if (crateRoot && (segs[0] === 'crate' || segs[0] === repoContext.rustCrateName) && rest[0]) {
    return { targetFile: crateRoot, importedName: rest[0] };
  }
  return null;
}

function parseRustModule(posixPath, code, repoRoot, repoContext) {
  const tokens = tokenizeCLikeSource(code, { keywords: RUST_KEYWORDS, nestedBlockComments: true, rustRawStrings: true, rustCharLiterals: true });
  const imports = new Set();
  const importBindings = [];
  const classes = [];
  const functions = [];
  const moduleCalls = [];
  const pendingFunctionBody = new Map();
  const typeStack = [];
  const funcStack = [];
  let braceDepth = 0;

  const recordCall = (callObj) => {
    const activeFn = funcStack[funcStack.length - 1];
    if (activeFn) activeFn.calls.push(callObj);
    else moduleCalls.push(callObj);
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if (tok.value === 'mod' && tokens[i + 1]?.type === 'ident' && tokens[i + 2]?.value === ';') {
      const modName = tokens[i + 1].value;
      const fromDir = path.posix.dirname(posixPath);
      const cands = [
        fromDir === '.' ? `${modName}.rs` : `${fromDir}/${modName}.rs`,
        fromDir === '.' ? `${modName}/mod.rs` : `${fromDir}/${modName}/mod.rs`,
      ];
      for (const c of cands) {
        if (fileExistsInContext(c, repoRoot, repoContext)) {
          imports.add(c);
          importBindings.push({ localName: modName, targetFile: c, importedName: '*', kind: 'namespace' });
          break;
        }
      }
    }

    if (tok.value === 'use') {
      let j = i + 1;
      while (j < tokens.length && tokens[j].value !== ';') j += 1;
      for (const item of flattenRustUseTokens(tokens.slice(i + 1, j))) {
        const resolved = resolveRustModulePath(posixPath, item.path, repoRoot, repoContext);
        if (resolved) {
          imports.add(resolved.targetFile);
          const itemName = resolved.importedName;
          const localName = item.alias ?? (itemName === '*' ? item.path[item.path.length - 1] : itemName);
          importBindings.push({
            localName,
            targetFile: resolved.targetFile,
            importedName: itemName,
            kind: itemName === '*' ? 'namespace' : 'named',
          });
        }
      }
      i = j;
      continue;
    }

    if (tok.value === 'struct' || tok.value === 'enum' || tok.value === 'trait' || tok.value === 'impl') {
      let ptr = i + 1;
      if (tok.value === 'impl' && tokens[ptr]?.value === '<') ptr = skipAngleBrackets(tokens, ptr);
      let typeName = tokens[ptr]?.type === 'ident' ? tokens[ptr].value : null;
      let k = ptr + 1;
      while (k < tokens.length && tokens[k].value !== '{' && tokens[k].value !== ';') {
        if (tok.value === 'impl' && tokens[k].value === 'for' && tokens[k + 1]?.type === 'ident') {
          typeName = tokens[k + 1].value;
        }
        k += 1;
      }
      if (typeName && tokens[k]?.value === '{') {
        const cls = {
          name: typeName,
          qualified_name: `${posixPath}::${typeName}`,
          file: posixPath,
          start_line: tok.line,
          end_line: tok.line,
          exported: tokens[i - 1]?.value === 'pub',
          bodyDepth: braceDepth + 1,
          methods: [],
        };
        classes.push(cls);
        typeStack.push(cls);
      }
    }

    if (tok.value === 'fn' && tokens[i + 1]?.type === 'ident') {
      const fnName = tokens[i + 1].value;
      const parenStart = skipAngleBrackets(tokens, i + 2);
      if (tokens[parenStart]?.value === '(') {
        const closeP = findMatchingDelim(tokens, parenStart, '(', ')');
        const openBraceIdx = closeP !== -1 ? findFunctionBodyOpenBrace(tokens, closeP + 1, 80) : -1;
        if (openBraceIdx !== -1) {
          const activeType = typeStack[typeStack.length - 1];
          const inImpl = activeType && braceDepth === activeType.bodyDepth ? activeType : null;
          const fn = {
            name: fnName,
            qualified_name: inImpl ? `${posixPath}::${inImpl.name}.${fnName}` : `${posixPath}::${fnName}`,
            class_name: inImpl ? inImpl.name : null,
            file: posixPath,
            start_line: tok.line,
            end_line: tok.line,
            exported: tokens[i - 1]?.value === 'pub' || Boolean(inImpl?.exported),
            calls: [],
          };
          if (inImpl) inImpl.methods.push(fnName);
          functions.push(fn);
          pendingFunctionBody.set(openBraceIdx, fn);
        }
      }
    }

    if (tok.type === 'ident' && tokens[i + 1]?.value === '(' && tokens[i - 1]?.value !== 'fn') {
      const prevVal = tokens[i - 1]?.value;
      if ((prevVal === '.' || prevVal === '::') && tokens[i - 2]?.type === 'ident') {
        recordCall({ kind: 'member', object: tokens[i - 2].value, name: tok.value, line: tok.line });
      } else {
        recordCall({ kind: 'direct', object: null, name: tok.value, line: tok.line });
      }
    } else if (tok.type === 'ident' && tokens[i - 1]?.value !== '.' && tokens[i - 1]?.value !== 'fn' && tokens[i - 1]?.value !== 'struct') {
      recordCall({ kind: 'ref', object: null, name: tok.value, line: tok.line });
    }

    if (tok.value === '{') {
      braceDepth += 1;
      const fnStarting = pendingFunctionBody.get(i);
      if (fnStarting) {
        fnStarting.bodyDepth = braceDepth;
        funcStack.push(fnStarting);
      }
    } else if (tok.value === '}') {
      const activeFn = funcStack[funcStack.length - 1];
      if (activeFn && braceDepth === activeFn.bodyDepth) {
        activeFn.end_line = tok.line;
        funcStack.pop();
      }
      const activeType = typeStack[typeStack.length - 1];
      if (activeType && braceDepth === activeType.bodyDepth) {
        activeType.end_line = tok.line;
        typeStack.pop();
      }
      braceDepth = Math.max(0, braceDepth - 1);
    }
  }

  return {
    file: posixPath,
    language: 'rust',
    packageKey: null,
    imports: [...imports].sort(),
    importBindings,
    classes,
    functions,
    moduleCalls,
  };
}

const JVM_CS_MODIFIERS = new Set([
  'public', 'private', 'protected', 'internal', 'static', 'final', 'abstract', 'override',
  'virtual', 'sealed', 'readonly', 'async', 'open', 'suspend', 'inline', 'operator', 'extern',
]);

function parseJvmModule(posixPath, language, code, repoContext) {
  const tokens = tokenizeCLikeSource(code, { tripleQuotes: true });
  const imports = new Set();
  const importBindings = [];
  const classes = [];
  const functions = [];
  const moduleCalls = [];
  const pendingFunctionBody = new Map();
  const classStack = [];
  const funcStack = [];
  let braceDepth = 0;
  let packageName = null;

  const recordCall = (callObj) => {
    const activeFn = funcStack[funcStack.length - 1];
    if (activeFn) activeFn.calls.push(callObj);
    else moduleCalls.push(callObj);
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if (braceDepth === 0 && tok.value === 'package') {
      const segs = [];
      let j = i + 1;
      while (j < tokens.length && tokens[j].line === tok.line && tokens[j].value !== ';') {
        if (tokens[j].type === 'ident') segs.push(tokens[j].value);
        j += 1;
      }
      if (segs.length) packageName = segs.join('.');
      i = j;
      continue;
    }

    if (braceDepth === 0 && tok.value === 'import') {
      let j = i + 1;
      if (tokens[j]?.value === 'static') j += 1;
      const segs = [];
      let alias = null;
      while (j < tokens.length && tokens[j].line === tok.line && tokens[j].value !== ';') {
        if (tokens[j].value === 'as' && tokens[j + 1]?.type === 'ident') {
          alias = tokens[j + 1].value;
          j += 2;
          break;
        }
        if (tokens[j].type === 'ident' || tokens[j].value === '*') segs.push(tokens[j].value);
        j += 1;
      }
      const fqn = segs.join('.');
      const last = segs[segs.length - 1];
      if (last === '*' && segs.length >= 2) {
        const pkg = segs.slice(0, -1).join('.');
        for (const f of repoContext.javaKotlinPackageIndex.get(pkg) ?? []) {
          imports.add(f);
          importBindings.push({ localName: '*', targetFile: f, importedName: '*', kind: 'namespace' });
        }
      } else if (repoContext.javaKotlinClassToFile.has(fqn)) {
        const f = repoContext.javaKotlinClassToFile.get(fqn);
        imports.add(f);
        importBindings.push({ localName: alias ?? last, targetFile: f, importedName: '*', kind: 'namespace' });
      } else if (segs.length >= 2) {
        const parentFqn = segs.slice(0, -1).join('.');
        const f = repoContext.javaKotlinClassToFile.get(parentFqn);
        if (f) {
          imports.add(f);
          importBindings.push({ localName: alias ?? last, targetFile: f, importedName: last, kind: 'named' });
        }
      }
      i = j;
      continue;
    }

    if (tok.value === 'class' || tok.value === 'interface' || tok.value === 'record' || tok.value === 'enum' || (language === 'kotlin' && tok.value === 'object')) {
      const nameTok = tokens[i + 1];
      if (nameTok?.type === 'ident') {
        let openB = i + 2;
        while (openB < tokens.length && tokens[openB].value !== '{' && tokens[openB].value !== ';') openB += 1;
        if (tokens[openB]?.value === '{') {
          const cls = {
            name: nameTok.value,
            qualified_name: `${posixPath}::${nameTok.value}`,
            file: posixPath,
            start_line: tok.line,
            end_line: tok.line,
            exported: tokens[i - 1]?.value === 'public' || language === 'kotlin',
            bodyDepth: braceDepth + 1,
            methods: [],
          };
          classes.push(cls);
          classStack.push(cls);
        }
      }
    }

    const activeClass = classStack[classStack.length - 1];
    if (language === 'kotlin' && tok.value === 'fun') {
      let ptr = skipAngleBrackets(tokens, i + 1);
      if (tokens[ptr]?.type === 'ident' && tokens[ptr + 1]?.value === '.' && tokens[ptr + 2]?.type === 'ident') ptr += 2;
      if (tokens[ptr]?.type === 'ident') {
        const fnName = tokens[ptr].value;
        const pIdx = skipAngleBrackets(tokens, ptr + 1);
        if (tokens[pIdx]?.value === '(') {
          const closeP = findMatchingDelim(tokens, pIdx, '(', ')');
          const openB = closeP !== -1 ? findFunctionBodyOpenBrace(tokens, closeP + 1) : -1;
          if (openB !== -1) {
            const clsOwner = activeClass && braceDepth === activeClass.bodyDepth ? activeClass : null;
            const fn = {
              name: fnName,
              qualified_name: clsOwner ? `${posixPath}::${clsOwner.name}.${fnName}` : `${posixPath}::${fnName}`,
              class_name: clsOwner ? clsOwner.name : null,
              file: posixPath,
              start_line: tok.line,
              end_line: tok.line,
              exported: true,
              calls: [],
            };
            if (clsOwner) clsOwner.methods.push(fnName);
            functions.push(fn);
            pendingFunctionBody.set(openB, fn);
          }
        }
      }
    } else if (
      activeClass &&
      braceDepth === activeClass.bodyDepth &&
      tok.type === 'ident' &&
      !JVM_CS_MODIFIERS.has(tok.value) &&
      tokens[i + 1]?.value === '(' &&
      tokens[i - 1]?.value !== '.' &&
      tokens[i - 1]?.value !== 'new' &&
      tokens[i - 1]?.value !== '@'
    ) {
      const closeP = findMatchingDelim(tokens, i + 1, '(', ')');
      const openB = closeP !== -1 ? findFunctionBodyOpenBrace(tokens, closeP + 1, 20) : -1;
      if (openB !== -1) {
        const fn = {
          name: tok.value,
          qualified_name: `${posixPath}::${activeClass.name}.${tok.value}`,
          class_name: activeClass.name,
          file: posixPath,
          start_line: tok.line,
          end_line: tok.line,
          exported: activeClass.exported,
          calls: [],
        };
        activeClass.methods.push(tok.value);
        functions.push(fn);
        pendingFunctionBody.set(openB, fn);
      }
    }

    if (tok.type === 'ident' && tokens[i + 1]?.value === '(' && !(activeClass && braceDepth === activeClass.bodyDepth) && tokens[i - 1]?.value !== 'fun') {
      const prevVal = tokens[i - 1]?.value;
      if (prevVal === '.' && tokens[i - 2]?.type === 'ident') {
        recordCall({ kind: 'member', object: tokens[i - 2].value, name: tok.value, line: tok.line });
      } else if (prevVal === 'new') {
        recordCall({ kind: 'construct', object: null, name: tok.value, line: tok.line });
      } else {
        recordCall({ kind: 'direct', object: null, name: tok.value, line: tok.line });
      }
    } else if (tok.type === 'ident' && tokens[i - 1]?.value !== '.' && tokens[i - 1]?.value !== 'package') {
      recordCall({ kind: 'ref', object: null, name: tok.value, line: tok.line });
    }

    if (tok.value === '{') {
      braceDepth += 1;
      const fnStarting = pendingFunctionBody.get(i);
      if (fnStarting) {
        fnStarting.bodyDepth = braceDepth;
        funcStack.push(fnStarting);
      }
    } else if (tok.value === '}') {
      const activeFn = funcStack[funcStack.length - 1];
      if (activeFn && braceDepth === activeFn.bodyDepth) {
        activeFn.end_line = tok.line;
        funcStack.pop();
      }
      if (activeClass && braceDepth === activeClass.bodyDepth) {
        activeClass.end_line = tok.line;
        classStack.pop();
      }
      braceDepth = Math.max(0, braceDepth - 1);
    }
  }

  return {
    file: posixPath,
    language,
    packageKey: packageName ? `jvm:${packageName}` : null,
    imports: [...imports].sort(),
    importBindings,
    classes,
    functions,
    moduleCalls,
  };
}

function parseCsharpModule(posixPath, code, repoContext) {
  const tokens = tokenizeCLikeSource(code, { tripleQuotes: true });
  const imports = new Set();
  const importBindings = [];
  const classes = [];
  const functions = [];
  const moduleCalls = [];
  const pendingFunctionBody = new Map();
  const classStack = [];
  const funcStack = [];
  let braceDepth = 0;
  let namespaceName = null;

  const recordCall = (callObj) => {
    const activeFn = funcStack[funcStack.length - 1];
    if (activeFn) activeFn.calls.push(callObj);
    else moduleCalls.push(callObj);
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if (tok.value === 'using' && tokens[i + 1]?.value !== '(') {
      let j = i + 1;
      if (tokens[j]?.value === 'static') j += 1;
      let alias = null;
      if (tokens[j]?.type === 'ident' && tokens[j + 1]?.value === '=') {
        alias = tokens[j].value;
        j += 2;
      }
      const segs = [];
      while (j < tokens.length && tokens[j].value !== ';') {
        if (tokens[j].type === 'ident') segs.push(tokens[j].value);
        j += 1;
      }
      const ns = segs.join('.');
      for (const f of repoContext.csharpNamespaceIndex.get(ns) ?? []) {
        imports.add(f);
        importBindings.push({ localName: alias ?? '*', targetFile: f, importedName: '*', kind: 'namespace' });
      }
      i = j;
      continue;
    }

    if (tok.value === 'namespace' && tokens[i + 1]?.type === 'ident') {
      const segs = [];
      let j = i + 1;
      while (j < tokens.length && tokens[j].value !== '{' && tokens[j].value !== ';') {
        if (tokens[j].type === 'ident') segs.push(tokens[j].value);
        j += 1;
      }
      if (segs.length) namespaceName = segs.join('.');
    }

    if (tok.value === 'class' || tok.value === 'struct' || tok.value === 'record' || tok.value === 'interface') {
      const nameTok = tokens[i + 1];
      if (nameTok?.type === 'ident') {
        let openB = i + 2;
        while (openB < tokens.length && tokens[openB].value !== '{' && tokens[openB].value !== ';') openB += 1;
        if (tokens[openB]?.value === '{') {
          const cls = {
            name: nameTok.value,
            qualified_name: `${posixPath}::${nameTok.value}`,
            file: posixPath,
            start_line: tok.line,
            end_line: tok.line,
            exported: tokens[i - 1]?.value === 'public',
            bodyDepth: braceDepth + 1,
            methods: [],
          };
          classes.push(cls);
          classStack.push(cls);
        }
      }
    }

    const activeClass = classStack[classStack.length - 1];
    if (
      activeClass &&
      braceDepth === activeClass.bodyDepth &&
      tok.type === 'ident' &&
      !JVM_CS_MODIFIERS.has(tok.value) &&
      (tokens[i + 1]?.value === '(' || tokens[i + 1]?.value === '<') &&
      tokens[i - 1]?.value !== '.' &&
      tokens[i - 1]?.value !== 'new'
    ) {
      const pIdx = skipAngleBrackets(tokens, i + 1);
      if (tokens[pIdx]?.value === '(') {
        const closeP = findMatchingDelim(tokens, pIdx, '(', ')');
        const openB = closeP !== -1 ? findFunctionBodyOpenBrace(tokens, closeP + 1, 20) : -1;
        if (openB !== -1) {
          const fn = {
            name: tok.value,
            qualified_name: `${posixPath}::${activeClass.name}.${tok.value}`,
            class_name: activeClass.name,
            file: posixPath,
            start_line: tok.line,
            end_line: tok.line,
            exported: activeClass.exported,
            calls: [],
          };
          activeClass.methods.push(tok.value);
          functions.push(fn);
          pendingFunctionBody.set(openB, fn);
        }
      }
    }

    if (tok.type === 'ident' && tokens[i + 1]?.value === '(' && !(activeClass && braceDepth === activeClass.bodyDepth)) {
      const prevVal = tokens[i - 1]?.value;
      if (prevVal === '.' && tokens[i - 2]?.type === 'ident') {
        recordCall({ kind: 'member', object: tokens[i - 2].value, name: tok.value, line: tok.line });
      } else if (prevVal === 'new') {
        recordCall({ kind: 'construct', object: null, name: tok.value, line: tok.line });
      } else {
        recordCall({ kind: 'direct', object: null, name: tok.value, line: tok.line });
      }
    } else if (tok.type === 'ident' && tokens[i - 1]?.value !== '.' && tokens[i - 1]?.value !== 'namespace') {
      recordCall({ kind: 'ref', object: null, name: tok.value, line: tok.line });
    }

    if (tok.value === '{') {
      braceDepth += 1;
      const fnStarting = pendingFunctionBody.get(i);
      if (fnStarting) {
        fnStarting.bodyDepth = braceDepth;
        funcStack.push(fnStarting);
      }
    } else if (tok.value === '}') {
      const activeFn = funcStack[funcStack.length - 1];
      if (activeFn && braceDepth === activeFn.bodyDepth) {
        activeFn.end_line = tok.line;
        funcStack.pop();
      }
      if (activeClass && braceDepth === activeClass.bodyDepth) {
        activeClass.end_line = tok.line;
        classStack.pop();
      }
      braceDepth = Math.max(0, braceDepth - 1);
    }
  }

  return {
    file: posixPath,
    language: 'csharp',
    packageKey: namespaceName ? `cs:${namespaceName}` : null,
    imports: [...imports].sort(),
    importBindings,
    classes,
    functions,
    moduleCalls,
  };
}

function resolveCppIncludes(posixPath, code, repoRoot, repoContext) {
  const imports = new Set();
  const importBindings = [];
  const fromDir = path.posix.dirname(posixPath);
  const codeExts = ['.c', '.cc', '.cpp', '.cxx'];

  for (const m of String(code).matchAll(/^\s*#\s*include\s*["<]([^">]+)[">]/gm)) {
    const inc = toPosixPath(m[1].trim());
    const dirCands = [
      fromDir === '.' ? inc : path.posix.normalize(`${fromDir}/${inc}`),
      inc,
      `include/${inc}`,
      `src/${inc}`,
    ];
    for (const cand of dirCands) {
      if (cand.startsWith('..')) continue;
      if (fileExistsInContext(cand, repoRoot, repoContext)) {
        imports.add(cand);
        importBindings.push({ localName: '*', targetFile: cand, importedName: '*', kind: 'namespace' });
        const ext = path.posix.extname(cand).toLowerCase();
        if (ext === '.h' || ext === '.hh' || ext === '.hpp' || ext === '.hxx') {
          const stem = cand.slice(0, cand.length - ext.length);
          const implBases = [stem, stem.replace(/^include\//, 'src/'), stem.replace(/^include\//, 'lib/')];
          for (const base of implBases) {
            for (const cExt of codeExts) {
              const implCand = `${base}${cExt}`;
              if (fileExistsInContext(implCand, repoRoot, repoContext)) {
                imports.add(implCand);
                importBindings.push({ localName: '*', targetFile: implCand, importedName: '*', kind: 'namespace' });
              }
            }
          }
        }
        break;
      }
    }
  }
  return { imports, importBindings };
}

function parseCppModule(posixPath, code, repoRoot, repoContext) {
  const { imports, importBindings } = resolveCppIncludes(posixPath, code, repoRoot, repoContext);
  const tokens = tokenizeCLikeSource(code, { hashLineComments: true });
  const classes = [];
  const functions = [];
  const moduleCalls = [];
  const pendingFunctionBody = new Map();
  const classStack = [];
  const funcStack = [];
  let braceDepth = 0;

  const recordCall = (callObj) => {
    const activeFn = funcStack[funcStack.length - 1];
    if (activeFn) activeFn.calls.push(callObj);
    else moduleCalls.push(callObj);
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if ((tok.value === 'class' || tok.value === 'struct') && tokens[i + 1]?.type === 'ident') {
      let openB = i + 2;
      while (openB < tokens.length && tokens[openB].value !== '{' && tokens[openB].value !== ';') openB += 1;
      if (tokens[openB]?.value === '{') {
        const cls = {
          name: tokens[i + 1].value,
          qualified_name: `${posixPath}::${tokens[i + 1].value}`,
          file: posixPath,
          start_line: tok.line,
          end_line: tok.line,
          exported: true,
          bodyDepth: braceDepth + 1,
          methods: [],
        };
        classes.push(cls);
        classStack.push(cls);
      }
    }

    const activeClass = classStack[classStack.length - 1];
    const inDeclDepth = braceDepth === 0 || (activeClass && braceDepth === activeClass.bodyDepth);
    if (inDeclDepth && tok.type === 'ident' && tokens[i + 1]?.value === '(') {
      const prevVal = tokens[i - 1]?.value;
      const isOutOfLineMethod = prevVal === '::' && tokens[i - 2]?.type === 'ident';
      const looksLikeFuncHeader = !activeClass || braceDepth === activeClass.bodyDepth || isOutOfLineMethod || (prevVal && prevVal !== '.' && prevVal !== '->' && prevVal !== 'new' && prevVal !== '=');
      if (looksLikeFuncHeader && tokens[i - 1]?.value !== '.') {
        const closeP = findMatchingDelim(tokens, i + 1, '(', ')');
        const openB = closeP !== -1 ? findFunctionBodyOpenBrace(tokens, closeP + 1, 15) : -1;
        if (openB !== -1) {
          const owner = isOutOfLineMethod ? tokens[i - 2].value : (activeClass && braceDepth === activeClass.bodyDepth ? activeClass.name : null);
          const fn = {
            name: tok.value,
            qualified_name: owner ? `${posixPath}::${owner}.${tok.value}` : `${posixPath}::${tok.value}`,
            class_name: owner,
            file: posixPath,
            start_line: tok.line,
            end_line: tok.line,
            exported: true,
            calls: [],
          };
          if (activeClass && braceDepth === activeClass.bodyDepth) activeClass.methods.push(tok.value);
          functions.push(fn);
          pendingFunctionBody.set(openB, fn);
        }
      }
    }

    if (tok.type === 'ident' && tokens[i + 1]?.value === '(' && !pendingFunctionBody.has(findMatchingDelim(tokens, i + 1, '(', ')') + 1)) {
      const prevVal = tokens[i - 1]?.value;
      if ((prevVal === '.' || prevVal === '->' || prevVal === '::') && tokens[i - 2]?.type === 'ident') {
        recordCall({ kind: 'member', object: tokens[i - 2].value, name: tok.value, line: tok.line });
      } else if (prevVal === 'new') {
        recordCall({ kind: 'construct', object: null, name: tok.value, line: tok.line });
      } else {
        recordCall({ kind: 'direct', object: null, name: tok.value, line: tok.line });
      }
    } else if (tok.type === 'ident' && tokens[i - 1]?.value !== '.' && tokens[i - 1]?.value !== '->') {
      recordCall({ kind: 'ref', object: null, name: tok.value, line: tok.line });
    }

    if (tok.value === '{') {
      braceDepth += 1;
      const fnStarting = pendingFunctionBody.get(i);
      if (fnStarting) {
        fnStarting.bodyDepth = braceDepth;
        funcStack.push(fnStarting);
      }
    } else if (tok.value === '}') {
      const activeFn = funcStack[funcStack.length - 1];
      if (activeFn && braceDepth === activeFn.bodyDepth) {
        activeFn.end_line = tok.line;
        funcStack.pop();
      }
      if (activeClass && braceDepth === activeClass.bodyDepth) {
        activeClass.end_line = tok.line;
        classStack.pop();
      }
      braceDepth = Math.max(0, braceDepth - 1);
    }
  }

  return {
    file: posixPath,
    language: 'c_cpp',
    packageKey: null,
    imports: [...imports].sort(),
    importBindings,
    classes,
    functions,
    moduleCalls,
  };
}

const RUBY_KEYWORDS = new Set([
  'alias', 'and', 'begin', 'break', 'case', 'class', 'def', 'defined?', 'do', 'else', 'elsif',
  'end', 'ensure', 'false', 'for', 'if', 'in', 'module', 'next', 'nil', 'not', 'or', 'redo',
  'rescue', 'retry', 'return', 'self', 'super', 'then', 'true', 'undef', 'unless', 'until',
  'when', 'while', 'yield', 'require', 'require_relative',
]);

function parseRubyModule(posixPath, code, repoRoot, repoContext) {
  const lines = String(code ?? '').replace(/\r\n/g, '\n').split('\n');
  const fromDir = path.posix.dirname(posixPath);
  const imports = new Set();
  const importBindings = [];
  const classes = [];
  const functions = [];
  const moduleCalls = [];
  const scopeStack = []; // { kind: 'class'|'def'|'block', obj? }

  const activeFn = () => {
    for (let k = scopeStack.length - 1; k >= 0; k--) {
      if (scopeStack[k].kind === 'def') return scopeStack[k].obj;
    }
    return null;
  };
  const activeClass = () => {
    for (let k = scopeStack.length - 1; k >= 0; k--) {
      if (scopeStack[k].kind === 'class') return scopeStack[k].obj;
    }
    return null;
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNum = idx + 1;
    const noComment = lines[idx].replace(/#.*$/, '').trim();
    if (!noComment) continue;

    const reqRel = noComment.match(/^\s*require_relative\s*\(?\s*['"]([^'"]+)['"]\s*\)?/);
    if (reqRel) {
      const base = fromDir === '.' ? reqRel[1] : path.posix.normalize(`${fromDir}/${reqRel[1]}`);
      for (const c of [base, `${base}.rb`]) {
        if (fileExistsInContext(c, repoRoot, repoContext)) {
          imports.add(c);
          importBindings.push({ localName: '*', targetFile: c, importedName: '*', kind: 'namespace' });
          break;
        }
      }
      continue;
    }

    const reqAbs = noComment.match(/^\s*require\s*\(?\s*['"]([^'"]+)['"]\s*\)?/);
    if (reqAbs) {
      for (const pfx of ['lib', 'app', 'src', '']) {
        const base = pfx ? `${pfx}/${reqAbs[1]}` : reqAbs[1];
        for (const c of [base, `${base}.rb`]) {
          if (fileExistsInContext(c, repoRoot, repoContext)) {
            imports.add(c);
            importBindings.push({ localName: '*', targetFile: c, importedName: '*', kind: 'namespace' });
            break;
          }
        }
      }
      continue;
    }

    const clsMatch = noComment.match(/^(?:class|module)\s+([A-Z][A-Za-z0-9_:]*)/);
    if (clsMatch) {
      const clsName = clsMatch[1].split('::').pop();
      const cls = {
        name: clsName,
        qualified_name: `${posixPath}::${clsName}`,
        file: posixPath,
        start_line: lineNum,
        end_line: lineNum,
        exported: true,
        methods: [],
      };
      classes.push(cls);
      scopeStack.push({ kind: 'class', obj: cls });
      continue;
    }

    const defMatch = noComment.match(/^def\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_?!]*)/);
    if (defMatch) {
      const fnName = defMatch[1];
      const clsOwner = activeClass();
      const fn = {
        name: fnName,
        qualified_name: clsOwner ? `${posixPath}::${clsOwner.name}.${fnName}` : `${posixPath}::${fnName}`,
        class_name: clsOwner ? clsOwner.name : null,
        file: posixPath,
        start_line: lineNum,
        end_line: lineNum,
        exported: true,
        calls: [],
      };
      if (clsOwner) clsOwner.methods.push(fnName);
      functions.push(fn);
      if (!/(?:^|;)\s*end\b\s*$/.test(noComment)) {
        scopeStack.push({ kind: 'def', obj: fn });
      }
      continue;
    }

    const codeLine = noComment.replace(/(['"])(?:\\.|(?!\1).)*\1/g, '""');
    const opensBlock =
      /^(?:if|unless|case|begin|while|until|for)\b/.test(codeLine) ||
      /\breturn\s+begin\b/.test(codeLine) ||
      /[=(,;]\s*(?:if|unless|case|begin|while|until|for)\b/.test(codeLine) ||
      /\bdo\b(?:\s*\|[^|]*\|)?\s*$/.test(codeLine);
    if (opensBlock && !/(?:^|;|\s)end\b\s*$/.test(codeLine)) {
      scopeStack.push({ kind: 'block' });
    }
    if (!opensBlock && /^end\b/.test(codeLine)) {
      const popped = scopeStack.pop();
      if (popped?.obj) popped.obj.end_line = lineNum;
      continue;
    }

    const targetCalls = activeFn()?.calls ?? moduleCalls;
    extractCallsFromText(codeLine, lineNum, RUBY_KEYWORDS, (c) => targetCalls.push(c));
  }

  return {
    file: posixPath,
    language: 'ruby',
    packageKey: null,
    imports: [...imports].sort(),
    importBindings,
    classes,
    functions,
    moduleCalls,
  };
}

function parsePhpModule(posixPath, code, repoRoot, repoContext) {
  const tokens = tokenizeCLikeSource(code, { hashLineComments: true, dollarIdentifiers: true });
  const imports = new Set();
  const importBindings = [];
  const classes = [];
  const functions = [];
  const moduleCalls = [];
  const pendingFunctionBody = new Map();
  const classStack = [];
  const funcStack = [];
  let braceDepth = 0;
  let namespaceName = null;

  const recordCall = (callObj) => {
    const activeFn = funcStack[funcStack.length - 1];
    if (activeFn) activeFn.calls.push(callObj);
    else moduleCalls.push(callObj);
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if (tok.value === 'namespace' && braceDepth === 0) {
      const segs = [];
      let j = i + 1;
      while (j < tokens.length && tokens[j].value !== ';' && tokens[j].value !== '{') {
        if (tokens[j].type === 'ident') segs.push(tokens[j].value);
        j += 1;
      }
      if (segs.length) namespaceName = segs.join('\\');
    }

    if (tok.value === 'use' && braceDepth === 0) {
      const segs = [];
      let alias = null;
      let j = i + 1;
      while (j < tokens.length && tokens[j].value !== ';') {
        if (tokens[j].value === 'as' && tokens[j + 1]?.type === 'ident') {
          alias = tokens[j + 1].value;
          j += 2;
          break;
        }
        if (tokens[j].type === 'ident') segs.push(tokens[j].value);
        j += 1;
      }
      const fqn = segs.join('\\');
      if (repoContext.phpClassToFile.has(fqn)) {
        const f = repoContext.phpClassToFile.get(fqn);
        imports.add(f);
        importBindings.push({ localName: alias ?? segs[segs.length - 1], targetFile: f, importedName: '*', kind: 'namespace' });
      }
      i = j;
      continue;
    }

    if ((tok.value === 'require' || tok.value === 'require_once' || tok.value === 'include' || tok.value === 'include_once') && tokens[i + 1]?.type === 'string') {
      const fromDir = path.posix.dirname(posixPath);
      const raw = toPosixPath(tokens[i + 1].value);
      for (const cand of [fromDir === '.' ? raw : path.posix.normalize(`${fromDir}/${raw}`), raw]) {
        if (!cand.startsWith('..') && fileExistsInContext(cand, repoRoot, repoContext)) {
          imports.add(cand);
          importBindings.push({ localName: '*', targetFile: cand, importedName: '*', kind: 'namespace' });
          break;
        }
      }
    }

    if ((tok.value === 'class' || tok.value === 'interface' || tok.value === 'trait') && tokens[i + 1]?.type === 'ident') {
      let openB = i + 2;
      while (openB < tokens.length && tokens[openB].value !== '{' && tokens[openB].value !== ';') openB += 1;
      if (tokens[openB]?.value === '{') {
        const cls = {
          name: tokens[i + 1].value,
          qualified_name: `${posixPath}::${tokens[i + 1].value}`,
          file: posixPath,
          start_line: tok.line,
          end_line: tok.line,
          exported: true,
          bodyDepth: braceDepth + 1,
          methods: [],
        };
        classes.push(cls);
        classStack.push(cls);
      }
    }

    const activeClass = classStack[classStack.length - 1];
    if (tok.value === 'function' && tokens[i + 1]?.type === 'ident' && tokens[i + 2]?.value === '(') {
      const closeP = findMatchingDelim(tokens, i + 2, '(', ')');
      const openB = closeP !== -1 ? findFunctionBodyOpenBrace(tokens, closeP + 1, 15) : -1;
      if (openB !== -1) {
        const clsOwner = activeClass && braceDepth === activeClass.bodyDepth ? activeClass : null;
        const fn = {
          name: tokens[i + 1].value,
          qualified_name: clsOwner ? `${posixPath}::${clsOwner.name}.${tokens[i + 1].value}` : `${posixPath}::${tokens[i + 1].value}`,
          class_name: clsOwner ? clsOwner.name : null,
          file: posixPath,
          start_line: tok.line,
          end_line: tok.line,
          exported: true,
          calls: [],
        };
        if (clsOwner) clsOwner.methods.push(tokens[i + 1].value);
        functions.push(fn);
        pendingFunctionBody.set(openB, fn);
      }
    }

    if (tok.type === 'ident' && tokens[i + 1]?.value === '(' && tokens[i - 1]?.value !== 'function') {
      const prevVal = tokens[i - 1]?.value;
      if ((prevVal === '->' || prevVal === '::') && tokens[i - 2]?.type === 'ident') {
        recordCall({ kind: 'member', object: tokens[i - 2].value, name: tok.value, line: tok.line });
      } else if (prevVal === 'new') {
        recordCall({ kind: 'construct', object: null, name: tok.value, line: tok.line });
      } else {
        recordCall({ kind: 'direct', object: null, name: tok.value, line: tok.line });
      }
    } else if (tok.type === 'ident' && tokens[i - 1]?.value !== '->' && tokens[i - 1]?.value !== 'function' && tokens[i - 1]?.value !== 'class') {
      recordCall({ kind: 'ref', object: null, name: tok.value, line: tok.line });
    }

    if (tok.value === '{') {
      braceDepth += 1;
      const fnStarting = pendingFunctionBody.get(i);
      if (fnStarting) {
        fnStarting.bodyDepth = braceDepth;
        funcStack.push(fnStarting);
      }
    } else if (tok.value === '}') {
      const activeFn = funcStack[funcStack.length - 1];
      if (activeFn && braceDepth === activeFn.bodyDepth) {
        activeFn.end_line = tok.line;
        funcStack.pop();
      }
      if (activeClass && braceDepth === activeClass.bodyDepth) {
        activeClass.end_line = tok.line;
        classStack.pop();
      }
      braceDepth = Math.max(0, braceDepth - 1);
    }
  }

  return {
    file: posixPath,
    language: 'php',
    packageKey: namespaceName ? `php:${namespaceName}` : null,
    imports: [...imports].sort(),
    importBindings,
    classes,
    functions,
    moduleCalls,
  };
}

/**
 * Parse any supported source module into a normalized CraftHelm AST + call-graph record.
 * @param {string} relPath
 * @param {string} code
 * @param {string} repoRoot
 * @param {ReturnType<typeof buildRepoContext>} [repoContext]
 */
export function parseSourceModule(relPath, code, repoRoot, repoContext = null) {
  const posixPath = toPosixPath(relPath);
  const language = detectLanguageForFile(posixPath);
  const ctx = repoContext ?? buildRepoContext(repoRoot, []);

  if (language === 'javascript' || language === 'typescript') {
    return parseJsTsModule(posixPath, language, code, repoRoot, ctx);
  }
  if (language === 'python') {
    return parsePythonModule(posixPath, code, repoRoot, ctx);
  }
  if (language === 'go') {
    return parseGoModule(posixPath, code, ctx);
  }
  if (language === 'rust') {
    return parseRustModule(posixPath, code, repoRoot, ctx);
  }
  if (language === 'java' || language === 'kotlin') {
    return parseJvmModule(posixPath, language, code, ctx);
  }
  if (language === 'csharp') {
    return parseCsharpModule(posixPath, code, ctx);
  }
  if (language === 'c_cpp') {
    return parseCppModule(posixPath, code, repoRoot, ctx);
  }
  if (language === 'ruby') {
    return parseRubyModule(posixPath, code, repoRoot, ctx);
  }
  if (language === 'php') {
    return parsePhpModule(posixPath, code, repoRoot, ctx);
  }

  return {
    file: posixPath,
    language: language ?? 'unknown',
    packageKey: null,
    imports: [],
    importBindings: [],
    classes: [],
    functions: [],
    moduleCalls: [],
  };
}
