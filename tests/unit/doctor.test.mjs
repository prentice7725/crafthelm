import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runDoctor } from '../../scripts/doctor.mjs';

describe('Doctor Single-Provider Isolation & Capability Probe (E10)', () => {
  it('Claude-only mode never invokes codex CLI', () => {
    const invoked = [];
    const report = runDoctor({
      host: 'claude',
      runner: (cmd, args) => {
        invoked.push([cmd, ...args]);
        if (cmd === 'git') return { exitCode: 0, stdout: 'git version 2.54.0', stderr: '' };
        if (cmd === 'claude' && args[0] === '--version') return { exitCode: 0, stdout: '2.1.311 (Claude Code)\n', stderr: '' };
        if (cmd === 'claude' && args[0] === '--help') return { exitCode: 0, stdout: '--agents --output-format --print --model --permission-mode', stderr: '' };
        throw new Error(`Unexpected command: ${cmd}`);
      },
      resolve: (cmd) => ({ found: cmd === 'claude' || cmd === 'git', path: cmd, kind: 'exe' }),
    });

    assert.equal(report.ok, true);
    assert.equal(report.hosts.claude.status, 'AVAILABLE');
    assert.equal(report.hosts.codex, undefined);
    assert.equal(invoked.some(([c]) => c.toLowerCase().includes('codex')), false);
  });

  it('Codex-only mode never invokes claude CLI', () => {
    const invoked = [];
    const report = runDoctor({
      host: 'codex',
      runner: (cmd, args) => {
        invoked.push([cmd, ...args]);
        if (cmd === 'git') return { exitCode: 0, stdout: 'git version 2.54.0', stderr: '' };
        if (cmd === 'codex' && args[0] === '--version') return { exitCode: 0, stdout: 'codex-cli 0.169.0\n', stderr: '' };
        if (cmd === 'codex' && args[0] === '--help') return { exitCode: 0, stdout: 'exec review agents sandbox', stderr: '' };
        if (cmd === 'codex' && args[0] === 'exec') return { exitCode: 0, stdout: '-m, --model', stderr: '' };
        throw new Error(`Unexpected command: ${cmd}`);
      },
      resolve: (cmd) => ({ found: cmd === 'codex' || cmd === 'git', path: cmd, kind: 'cmd' }),
    });

    assert.equal(report.ok, true);
    assert.equal(report.hosts.codex.status, 'AVAILABLE');
    assert.equal(report.hosts.codex.supports_agents, true);
    assert.equal(report.hosts.claude, undefined);
    assert.equal(invoked.some(([c]) => c.toLowerCase().includes('claude')), false);
  });

  it('reports UNAVAILABLE honestly when host CLI is missing', () => {
    const report = runDoctor({
      host: 'claude',
      runner: (cmd) => (cmd === 'git' ? { exitCode: 0, stdout: 'git 2.54', stderr: '' } : { exitCode: 127, stdout: '', stderr: 'not found' }),
      resolve: (cmd) => ({ found: cmd === 'git', path: cmd === 'git' ? 'git' : null, kind: null }),
    });
    assert.equal(report.ok, false);
    assert.equal(report.status, 'UNAVAILABLE');
    assert.equal(report.hosts.claude.status, 'UNAVAILABLE');
  });

  it('marks single-model limitations explicitly without claiming cross-model review', () => {
    const report = runDoctor({
      host: 'codex',
      singleModel: true,
      runner: (cmd, args) => {
        if (cmd === 'git') return { exitCode: 0, stdout: 'git 2.54', stderr: '' };
        if (cmd === 'codex' && args[0] === '--version') return { exitCode: 0, stdout: 'codex-cli 0.138.0', stderr: '' };
        return { exitCode: 0, stdout: 'exec review sandbox --model', stderr: '' };
      },
      resolve: () => ({ found: true, path: 'codex.exe', kind: 'exe' }),
    });

    assert.equal(report.ok, true);
    assert.equal(report.hosts.codex.supports_agents, false);
    assert.equal(report.hosts.codex.supports_multi_model, false);
    assert.equal(report.hosts.codex.worker_roles.reviewer.execution_mode, 'sequential_single_model');
    assert.equal(report.hosts.codex.worker_roles.reviewer.independent_cross_model_review, 'UNVERIFIED');
  });

  it('Antigravity mode detects agy flags without invoking claude or codex', () => {
    const invoked = [];
    const report = runDoctor({
      host: 'agy',
      runner: (cmd, args) => {
        invoked.push([cmd, ...args]);
        if (cmd === 'git') return { exitCode: 0, stdout: 'git version 2.54.0', stderr: '' };
        if (cmd === 'agy' && args[0] === '--version') return { exitCode: 0, stdout: '1.5.12\n', stderr: '' };
        if (cmd === 'agy' && args[0] === '--help') {
          return { exitCode: 0, stdout: '-p --print --output-format --model --agent --effort --mode --sandbox --json-schema agents', stderr: '' };
        }
        throw new Error(`Unexpected command: ${cmd}`);
      },
      resolve: (cmd) => ({ found: cmd === 'agy' || cmd === 'git', path: cmd, kind: 'exe' }),
    });

    assert.equal(report.ok, true);
    assert.equal(report.requested_host, 'antigravity');
    assert.equal(report.hosts.antigravity.status, 'AVAILABLE');
    assert.equal(report.hosts.antigravity.supports_print_json, true);
    assert.equal(report.hosts.antigravity.supports_subagents, true);
    assert.equal(report.hosts.antigravity.supports_sandbox, true);
    assert.equal(report.hosts.antigravity.supports_json_schema, true);
    assert.equal(invoked.some(([c]) => /claude|codex/i.test(c)), false);
  });

  it('Antigravity falls back to host_native_session when --in-session is active and agy CLI is missing', () => {
    const missingAgy = runDoctor({
      host: 'antigravity',
      runner: (cmd) => (cmd === 'git' ? { exitCode: 0, stdout: 'git 2.54', stderr: '' } : { exitCode: 127, stdout: '', stderr: 'not found' }),
      resolve: (cmd) => ({ found: cmd === 'git', path: cmd === 'git' ? 'git' : null, kind: null }),
    });
    assert.equal(missingAgy.ok, false);
    assert.equal(missingAgy.hosts.antigravity.status, 'UNAVAILABLE');

    const sessionAgy = runDoctor({
      host: 'antigravity',
      inSession: true,
      runner: (cmd) => (cmd === 'git' ? { exitCode: 0, stdout: 'git 2.54', stderr: '' } : { exitCode: 127, stdout: '', stderr: 'not found' }),
      resolve: (cmd) => ({ found: cmd === 'git', path: cmd === 'git' ? 'git' : null, kind: null }),
    });
    assert.equal(sessionAgy.ok, true);
    assert.equal(sessionAgy.hosts.antigravity.execution_mode, 'host_native_session');
    assert.ok(sessionAgy.hosts.antigravity.limitations.includes('agy_cli_unavailable_using_host_session'));
  });

  it('Generic mode supports in-session execution and custom CLI probes without vendor leakage', () => {
    const genericSession = runDoctor({
      host: 'generic',
      runner: (cmd) => {
        if (cmd === 'git') return { exitCode: 0, stdout: 'git 2.54', stderr: '' };
        throw new Error(`Unexpected vendor CLI call: ${cmd}`);
      },
      resolve: (cmd) => ({ found: cmd === 'git', path: 'git', kind: 'exe' }),
    });
    assert.equal(genericSession.ok, true);
    assert.equal(genericSession.hosts.generic.execution_mode, 'host_native_session');
    assert.equal(genericSession.hosts.generic.kouetsu.status, 'VERIFIED');

    const customFound = runDoctor({
      host: 'opencode',
      cli: 'opencode',
      runner: (cmd, args) => {
        if (cmd === 'git') return { exitCode: 0, stdout: 'git 2.54', stderr: '' };
        if (cmd === 'opencode' && args[0] === '--version') return { exitCode: 0, stdout: 'opencode 0.9.0\n', stderr: '' };
        if (cmd === 'opencode' && args[0] === '--help') return { exitCode: 0, stdout: '--model', stderr: '' };
        throw new Error(`Unexpected command: ${cmd}`);
      },
      resolve: (cmd) => ({ found: cmd === 'opencode' || cmd === 'git', path: cmd, kind: 'exe' }),
    });
    assert.equal(customFound.ok, true);
    assert.equal(customFound.hosts.opencode.execution_mode, 'custom_cli');
    assert.equal(customFound.hosts.opencode.cli_version, 'opencode 0.9.0');

    const customMissing = runDoctor({
      host: 'opencode',
      cli: 'opencode',
      runner: (cmd) => (cmd === 'git' ? { exitCode: 0, stdout: 'git 2.54', stderr: '' } : { exitCode: 127, stdout: '', stderr: 'not found' }),
      resolve: (cmd) => ({ found: cmd === 'git', path: cmd === 'git' ? 'git' : null, kind: null }),
    });
    assert.equal(customMissing.ok, false);
    assert.equal(customMissing.hosts.opencode.status, 'UNAVAILABLE');
  });
});
