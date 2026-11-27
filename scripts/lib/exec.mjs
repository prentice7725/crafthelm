import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Looking a program up spawns `where`/`which`. git alone is looked up dozens of times per verify,
// so a found path is remembered for the search path it was found on. Misses are not cached:
// a tool can be installed while a long session runs.
const resolvedCache = new Map();

/**
 * Resolve an executable on the current platform (handling Windows .exe/.cmd/.ps1).
 * @param {string} name
 * @param {{ env?: NodeJS.ProcessEnv, runner?: Function }} [options]
 * @returns {{ found: boolean, path: string|null, kind: string|null }}
 */
export function resolveExecutable(name, options = {}) {
  const env = options.env ?? process.env;
  if (typeof options.resolve === 'function') {
    return options.resolve(name, env);
  }
  if (path.isAbsolute(name) && fs.existsSync(name)) {
    return { found: true, path: name, kind: classifyExtension(name) };
  }
  const cacheKey = [process.platform, name, env.PATH ?? env.Path ?? '', env.PATHEXT ?? ''].join('\u0000');
  const cached = resolvedCache.get(cacheKey);
  if (cached) return { ...cached };
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [name], {
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout) {
    return { found: false, path: null, kind: null };
  }
  const candidates = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (candidates.length === 0) {
    return { found: false, path: null, kind: null };
  }

  // On Windows, prefer .exe -> .cmd -> .bat -> .ps1 -> extensionless shim
  const order = ['.exe', '.cmd', '.bat', '.ps1', ''];
  candidates.sort((a, b) => {
    const extA = path.extname(a).toLowerCase();
    const extB = path.extname(b).toLowerCase();
    const idxA = order.includes(extA) ? order.indexOf(extA) : 99;
    const idxB = order.includes(extB) ? order.indexOf(extB) : 99;
    return idxA - idxB;
  });

  const chosen = candidates[0];
  const located = { found: true, path: chosen, kind: classifyExtension(chosen) };
  resolvedCache.set(cacheKey, located);
  return { ...located };
}

function classifyExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') return 'cmd';
  if (ext === '.ps1') return 'ps1';
  if (ext === '.exe') return 'exe';
  return 'bin';
}

/**
 * Run a command cleanly across Windows (.exe/.cmd/.ps1) and POSIX.
 * Supports dependency injection via `options.runner` for tests.
 * @param {string} cmd
 * @param {string[]} [args]
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, input?: string, runner?: Function, resolve?: Function }} [options]
 * @returns {{ exitCode: number, stdout: string, stderr: string, durationMs: number, error?: string, resolvedPath?: string|null }}
 */
export function runCommand(cmd, args = [], options = {}) {
  const started = Date.now();
  if (typeof options.runner === 'function') {
    const res = options.runner(cmd, args, options);
    return {
      exitCode: res.exitCode ?? res.status ?? 0,
      stdout: String(res.stdout ?? ''),
      stderr: String(res.stderr ?? ''),
      durationMs: res.durationMs ?? Math.max(0, Date.now() - started),
      error: res.error,
      resolvedPath: res.resolvedPath ?? cmd,
    };
  }

  const env = options.env ?? process.env;
  const resolved = resolveExecutable(cmd, { env, resolve: options.resolve });
  let targetCmd = cmd;
  let targetArgs = args;

  if (process.platform === 'win32' && resolved.found && resolved.path) {
    if (resolved.kind === 'cmd') {
      targetCmd = env.ComSpec || 'cmd.exe';
      targetArgs = ['/d', '/c', resolved.path, ...args];
    } else if (resolved.kind === 'ps1') {
      const pwsh = resolveExecutable('pwsh', { env }).found ? 'pwsh' : 'powershell.exe';
      targetCmd = pwsh;
      targetArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved.path, ...args];
    } else {
      targetCmd = resolved.path;
    }
  }

  const res = spawnSync(targetCmd, targetArgs, {
    cwd: options.cwd,
    env,
    input: options.input,
    timeout: options.timeoutMs ?? 60_000,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });

  const durationMs = Math.max(0, Date.now() - started);
  const exitCode = typeof res.status === 'number' ? res.status : (res.error ? 127 : 1);
  return {
    exitCode,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? (res.error ? res.error.message : ''),
    durationMs,
    error: res.error ? res.error.message : undefined,
    resolvedPath: resolved.path ?? null,
  };
}

// The exit code `timeout(1)` uses; 127 would read as "command not found".
export const TIMEOUT_EXIT_CODE = 124;

/**
 * Run a shell command string (used for contract acceptance commands).
 * @param {string} commandString
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} [options]
 * @returns {{ exitCode: number, stdout: string, stderr: string, durationMs: number, timedOut: boolean, timeoutMs: number, error?: string }}
 *   A command stopped at its time limit comes back with `timedOut` and exit code 124.
 */
export function runShellCommand(commandString, options = {}) {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const res = spawnSync(commandString, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: true,
    timeout: timeoutMs,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  const durationMs = Math.max(0, Date.now() - started);
  const timedOut = res.error?.code === 'ETIMEDOUT';
  const exitCode = timedOut ? TIMEOUT_EXIT_CODE : (typeof res.status === 'number' ? res.status : (res.error ? 127 : 1));
  // spawnSync reports a timeout or a failed spawn in `error` and leaves stderr an empty string,
  // so the reason is appended: a stored log must say why the command produced no result.
  const note = timedOut
    ? `[crafthelm] Stopped after ${timeoutMs} ms: the command did not finish within its time limit.`
    : (res.error ? `[crafthelm] ${res.error.message}` : '');
  const stderr = res.stderr ?? '';
  return {
    exitCode,
    stdout: res.stdout ?? '',
    stderr: note ? `${stderr}${stderr && !stderr.endsWith('\n') ? '\n' : ''}${note}\n` : stderr,
    durationMs,
    timedOut,
    timeoutMs,
    error: res.error ? res.error.message : undefined,
  };
}
