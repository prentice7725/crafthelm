import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { validateAgainstSchema } from '../../scripts/lib/schema.mjs';
import { CRAFTHELM_ROOT } from '../../scripts/lib/paths.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

describe('CraftHelm JSON Schemas', () => {
  it('validates the schemas with valid and invalid fixtures', () => {
    const validExecution = {
      schema_version: '0.3',
      task_id: 'CH-T001',
      request: 'Implement user login',
      project_root: '.',
      host: 'claude',
      change_kind: 'feature',
      methodology: { lifecycle: 'incremental', specification: 'sdd', engineering: 'tdd', execution: 'full' },
      scope: { allow: ['src/**'], protect: ['REVIEW.md'] },
      approval: { contract_approved: true, require_on: ['scope_change'] },
      budgets: { max_worker_retries_per_cause: 3, max_lead_escalations: 3, max_wall_minutes: 60 },
      acceptance: [
        { id: 'AC-01', requirement: 'REQ-01', kind: 'unit', command: 'npm test', expected_exit_code: 0 },
        { id: 'AC-02', requirement: 'REQ-02', kind: 'manual', manual_method: 'Check login screen' },
        { id: 'AC-03', requirement: 'REQ-03', kind: 'e2e', applicable: false, not_applicable_reason: 'CLI only' },
      ],
      source_policy: { authority: ['git-main'], source_refs: ['README.md'] },
    };
    assert.equal(validateAgainstSchema('execution', validExecution).valid, true);

    const invalidExecBudget = structuredClone(validExecution);
    invalidExecBudget.budgets.max_worker_retries_per_cause = 5;
    assert.equal(validateAgainstSchema('execution', invalidExecBudget).valid, false);

    const invalidManualMissingMethod = structuredClone(validExecution);
    invalidManualMissingMethod.acceptance = [{ id: 'AC-M', requirement: 'REQ-M', kind: 'manual' }];
    assert.equal(validateAgainstSchema('execution', invalidManualMissingMethod).valid, false);

    const validCheckpoint = {
      schema_version: '0.3',
      run_id: 'RUN-1',
      task_id: 'CH-T001',
      host: 'claude',
      state: 'READY_FOR_HUMAN_REVIEW',
      current_stage: 'review_package',
      contract_sha256: SHA_A,
      baseline_git_head: 'abc1234',
      target_snapshot_digest: SHA_B,
      repair_rounds: { test_fail: 1 },
      stage_history: [{ stage: 'interview', status: 'completed', recorded_at: '2026-11-19T10:00:00Z' }],
      stage_approvals: {},
      updated_at: '2026-11-19T10:05:00Z',
    };
    assert.equal(validateAgainstSchema('checkpoint', validCheckpoint).valid, true);

    const forbiddenComplete = structuredClone(validCheckpoint);
    forbiddenComplete.state = 'COMPLETE';
    const completeRes = validateAgainstSchema('checkpoint', forbiddenComplete);
    assert.equal(completeRes.valid, false);

    const validEvidence = {
      schema_version: '0.3',
      run_id: 'RUN-1',
      contract_sha256: SHA_A,
      baseline_git_head: 'abc1234',
      final_tree_hash: 'def5678',
      target_snapshot_digest: SHA_B,
      skill_lock_sha256: 'none',
      verification_stamp_file: 'evidence/verification-stamp.json',
      verification_level: 'verified',
      checks: [{ id: 'AC-01', kind: 'unit', status: 'PASS', exit_code: 0 }],
      reliability_checks: [{ id: 'RULE-1', triggered: false, non_trigger_reason: 'no match', policy_mode: 'observe', status: 'SKIPPED' }],
      review: { status: 'NOT_RUN', target_snapshot_digest: null },
      scope: { status: 'PASS', diff_file: 'evidence/changes.patch', changed_files: ['src/a.js'], out_of_scope_files: [], protected_violations: [] },
      technical_status: 'VERIFIED',
      human_review: { status: 'READY_FOR_HUMAN_REVIEW', package_file: 'reports/review-package.md', package_sha256: SHA_C },
    };
    assert.equal(validateAgainstSchema('evidence', validEvidence).valid, true);
    const badEvidence = structuredClone(validEvidence);
    delete badEvidence.target_snapshot_digest;
    assert.equal(validateAgainstSchema('evidence', badEvidence).valid, false);

    const validStamp = {
      schema_version: '0.3',
      run_id: 'RUN-1',
      target_snapshot_digest: SHA_B,
      baseline_git_head: 'abc1234',
      policy_base_ref: 'abc1234',
      policy_digest: SHA_A,
      policy_source: 'base_ref_git_show',
      verification_level: 'verified',
      stale: false,
      checks: [{ id: 'AC-01', kind: 'unit', status: 'PASS', evidence_ref: 'evidence/tests/AC-01.stdout.txt' }],
      reliability_rules_evaluated: [],
      review: { status: 'NOT_RUN', target_snapshot_digest: null },
      unverified: [],
      human_acceptance: 'PENDING',
      stamped_at: '2026-11-19T10:05:00Z',
    };
    assert.equal(validateAgainstSchema('verification-stamp', validStamp).valid, true);
    assert.equal(validateAgainstSchema('verification-stamp', { ...validStamp, schema_version: '0.1' }).valid, false);

    const validEditorial = {
      schema_version: '0.3',
      run_id: 'RUN-1',
      host: 'codex',
      kouetsu_skill_id: 'kouetsu',
      kouetsu_version: '1.1.0',
      kouetsu_digest: SHA_A,
      executed: true,
      status: 'PASS',
      language: 'ko',
      separate_reader_review: 'NOT_RUN_DETERMINISTIC_ONLY',
      layers: { content: 'PASS', clarity: 'PASS', surface: 'PASS' },
      findings: [],
      confirmation_markers: [],
      critical_confirmations: [],
      checked_at: '2026-11-19T10:05:00Z',
    };
    assert.equal(validateAgainstSchema('editorial-report', validEditorial).valid, true);
    assert.equal(validateAgainstSchema('editorial-report', { ...validEditorial, status: 'UNKNOWN' }).valid, false);

    const validDecision = {
      schema_version: '0.2',
      run_id: 'RUN-1',
      task_id: 'CH-T001',
      contract_sha256: SHA_A,
      report_sha256: SHA_C,
      evidence_manifest_sha256: SHA_B,
      target_snapshot_digest: SHA_B,
      decision: 'accepted',
      actor: 'chang',
      recorded_at: '2026-11-19T10:10:00Z',
      rationale: 'Verified diff and E2E output',
      accepted_risks: [],
      verification_type: 'local_explicit_input_not_identity_verified',
    };
    assert.equal(validateAgainstSchema('human-decision', validDecision).valid, true);
    assert.equal(
      validateAgainstSchema('human-decision', { ...validDecision, verification_type: 'cryptographic_sso_verified' }).valid,
      false,
    );
    assert.equal(
      validateAgainstSchema('human-decision', { ...validDecision, verification_type: 'local_tty_confirmed_not_identity_verified' }).valid,
      true,
    );
    const signature = { alg: 'ed25519', public_key_pem: 'PEM', public_key_fingerprint: SHA_A, value: 'c2ln' };
    assert.equal(
      validateAgainstSchema('human-decision', { ...validDecision, verification_type: 'signed_ed25519', signature }).valid,
      true,
    );
    // A signed tier without a signature, or a signature on an unsigned tier, is rejected.
    assert.equal(
      validateAgainstSchema('human-decision', { ...validDecision, verification_type: 'signed_ed25519' }).valid,
      false,
    );
    assert.equal(validateAgainstSchema('human-decision', { ...validDecision, signature }).valid, false);

    const validPackageMeta = {
      schema_version: '0.3',
      run_id: 'RUN-1',
      task_id: 'CH-T001',
      preset: 'executive',
      report_file: 'reports/review-package.md',
      report_sha256: SHA_C,
      target_snapshot_digest: SHA_B,
      verification_stamp_file: 'evidence/verification-stamp.json',
      sections_present: ['1', '2', '3', '4', '5', '6', '7', '8'],
      broken_links: [],
      ac_mismatches: [],
      critical_confirmations: [],
      generated_at: '2026-11-19T10:06:00Z',
    };
    assert.equal(validateAgainstSchema('review-package', validPackageMeta).valid, true);
    assert.equal(validateAgainstSchema('review-package', { ...validPackageMeta, sections_present: ['1', '2'] }).valid, false);

    const validLock = {
      schema_version: '0.3',
      generated_at: '2026-11-19T10:00:00Z',
      host: 'claude',
      skills: [
        {
          id: 'kouetsu',
          version: '1.1.0',
          license: 'MIT',
          upstream_url: 'https://github.com/prentice7725/kouetsu',
          source_path: '/tmp/kouetsu',
          files_digest: SHA_A,
          file_hashes: { 'SKILL.md': SHA_B },
          permission_scope: ['read_markdown'],
          approved_at: '2026-11-19',
        },
      ],
    };
    assert.equal(validateAgainstSchema('skill-lock', validLock).valid, true);
    assert.equal(validateAgainstSchema('skill-lock', { ...validLock, host: 'antigravity' }).valid, true);
    assert.equal(validateAgainstSchema('skill-lock', { ...validLock, host: 'generic' }).valid, true);
    assert.equal(validateAgainstSchema('skill-lock', { ...validLock, host: 'custom-cli' }).valid, true);
    assert.equal(validateAgainstSchema('skill-lock', { ...validLock, host: '' }).valid, false);
    assert.equal(validateAgainstSchema('skill-lock', { ...validLock, host: 'Bad Host!' }).valid, false);

    assert.equal(
      validateAgainstSchema('execution', {
        ...validExecution,
        host: 'custom-cli',
        host_config: {
          cli_command: 'opencode',
          version_args: ['--version'],
          exec_args: ['run'],
          model_flag: '--model',
          supports_json: true,
        },
      }).valid,
      true,
    );
    assert.equal(validateAgainstSchema('execution', { ...validExecution, host: 'Invalid Host' }).valid, false);

    const validRule = {
      id: 'RULE-SESSION-001',
      source: 'incident-2026-01',
      trigger: { paths: ['src/session/**'], changed_symbols: ['resume'] },
      check: { command_id: 'replay-check', command: 'node check.mjs' },
      severity: 'must_fix',
      policy_mode: 'observe',
      status: 'observe',
      owner: 'maintainer',
    };
    assert.equal(validateAgainstSchema('reliability-rule', validRule).valid, true);
    assert.equal(validateAgainstSchema('reliability-rule', { ...validRule, policy_mode: 'bypass' }).valid, false);

    const validImpact = {
      schema_version: '0.3',
      base_ref: 'HEAD',
      directly_changed_files: ['src/auth.mjs'],
      directly_changed_functions: ['src/auth.mjs::AuthService.login'],
      directly_changed_classes: ['src/auth.mjs::AuthService'],
      impacted_functions: ['src/auth.mjs::AuthService.login', 'src/session.mjs::createSession'],
      impacted_files: ['src/auth.mjs', 'src/session.mjs'],
      impacted_features: ['auth', 'session'],
      test_candidates: ['tests/auth.test.mjs', 'tests/billing.test.mjs'],
      selected_tests: [{ file: 'tests/auth.test.mjs', reasons: ['calls impacted symbol src/auth.mjs::AuthService.login'] }],
      unselected_tests: [{ file: 'tests/billing.test.mjs', reason: 'No direct or transitive dependency' }],
      recommended_test_command: 'node --test tests/auth.test.mjs',
      recommended_test_commands: [
        { language: 'javascript', runner: 'node-test', command: 'node --test tests/auth.test.mjs', tests: ['tests/auth.test.mjs'] },
      ],
      fallback_to_full: false,
      fallback_reason: null,
      graph_stats: { files_parsed: 4, functions_indexed: 6, classes_indexed: 1, import_edges: 3, call_edges: 4 },
      languages_detected: ['javascript', 'python'],
      test_runner: 'node-test',
      analyzer_source: 'builtin_polyglot',
      analyzed_at: '2026-11-19T14:00:00Z',
    };
    assert.equal(validateAgainstSchema('impact-analysis', validImpact).valid, true);
    assert.equal(validateAgainstSchema('impact-analysis', { ...validImpact, analyzer_source: 'unknown_source' }).valid, false);
    const badImpact = structuredClone(validImpact);
    delete badImpact.directly_changed_classes;
    assert.equal(validateAgainstSchema('impact-analysis', badImpact).valid, false);

    const validFeedback = {
      schema_version: '0.3',
      run_id: 'RUN-1',
      task_id: 'CH-T001',
      round: 1,
      repair_limit: 3,
      status: 'FAIL',
      failed_checks: [{ id: 'AC-01', kind: 'unit', exit_code: 1, status: 'FAIL', reason: 'AssertionError', error_excerpt: 'expected 2 got 1' }],
      impacted_functions: ['src/auth.mjs::login'],
      impacted_classes: ['src/auth.mjs::AuthService'],
      impacted_features: ['auth'],
      scope_violation: false,
      root_cause_category: 'TEST_FAILURE',
      recommended_tier: 'standard',
      decision_needed: 'repair_existing_scope',
      escalate_to_human: false,
      artifact_refs: ['evidence/changes.patch', 'evidence/impact-analysis.json'],
      tried_and_failed: [{ round: 1, cause_id: 'TEST_FAILURE', check_id: 'AC-01', note: 'first fix failed' }],
      prior_memory_hits: [{ id: 'DEC-001', kind: 'decision', title: 'Rotate token', status: 'active', source_path: '.crafthelm/memory/decisions/DEC-001.md', score: 1.2, decayed: false }],
      generated_at: '2026-11-19T14:00:00Z',
    };
    assert.equal(validateAgainstSchema('feedback-packet', validFeedback).valid, true);
    assert.equal(validateAgainstSchema('feedback-packet', { ...validFeedback, recommended_tier: 'super_model' }).valid, false);

    const validHandoff = {
      schema_version: '0.3',
      run_id: 'RUN-1',
      task_id: 'CH-T001',
      host: 'generic',
      state: 'REPAIRING',
      current_stage: 'technical_verification',
      target_snapshot_digest: SHA_B,
      baseline_git_head: 'abc1234',
      blocked_reason: null,
      tried_and_failed: [{ round: 1, cause_id: 'TEST_FAILURE', check_id: 'AC-01', note: 'tried swapping order' }],
      open_questions: ['Token TTL?'],
      active_decisions: [{ id: 'DEC-002', title: 'Use RS256', status: 'active', supersedes: 'DEC-001', source_path: '.crafthelm/memory/decisions/DEC-002.md' }],
      related_memory_hits: [{ id: 'DEC-002', kind: 'decision', title: 'Use RS256', status: 'active', superseded_by: null, source_path: '.crafthelm/memory/decisions/DEC-002.md', score: 1.5, excerpt: 'RS256...', decayed: false }],
      next_recommended_action: 'Fix claim check without repeating round 1.',
      artifact_refs: ['checkpoint.json', 'evidence/feedback-packet.json'],
      generated_at: '2026-11-21T12:00:00Z',
    };
    assert.equal(validateAgainstSchema('handoff-packet', validHandoff).valid, true);
    assert.equal(validateAgainstSchema('handoff-packet', { ...validHandoff, state: 'COMPLETE' }).valid, false);

    assert.equal(
      validateAgainstSchema('execution', {
        ...validExecution,
        host: 'custom-cli',
        host_config: {
          cli_command: 'opencode',
          version_args: ['--version'],
          exec_args: ['run'],
          model_flag: '--model',
          supports_json: true,
          supports_multi_model: true,
          in_session: true,
        },
        verification_policy: {
          regression_mode: 'selective',
          always_run_kinds: ['e2e'],
          test_file_patterns: ['tests/**/*.test.mjs', 'tests/**/*.py'],
          global_fallback_patterns: ['custom.lock'],
          test_command_template: 'pytest {files}',
          test_command_templates: { python: 'pytest -q {files}' },
          custom_impact_analyzer: 'node analyzer.mjs',
          ignored_dirs: ['.venv', 'dist'],
        },
        model_routing: {
          enabled: true,
          escalate_on_retry: 2,
          model_tiers: { lightweight: 'flash_lite', standard: 'flash', reasoning: 'pro' },
          host_profiles: {
            opencode: { lightweight: 'qwen-7b', standard: 'deepseek-v3', reasoning: 'deepseek-r1' },
          },
        },
        acceptance: [
          {
            id: 'AC-01',
            requirement: 'REQ-01',
            kind: 'unit',
            command: 'node tests/unit.test.mjs',
            target_files: ['tests/unit.test.mjs'],
            always_run: false,
          },
        ],
      }).valid,
      true,
    );

    const skippedEvidence = structuredClone(validEvidence);
    skippedEvidence.checks.push({
      id: 'AC-UNIMP',
      kind: 'unit',
      status: 'SKIPPED_UNIMPACTED',
      selection_reason: 'Unimpacted by changed symbols',
    });
    assert.equal(validateAgainstSchema('evidence', skippedEvidence).valid, true);

    const validDelegation = {
      schema_version: '0.3',
      delegation_id: 'D001',
      run_id: 'RUN-01',
      task_id: 'CH-T001',
      observation: 'observed',
      host: 'claude',
      role: 'builder',
      task_type: 'implement',
      tier: 'standard',
      model_requested: 'sonnet',
      degraded_to_single_model: false,
      status: 'OK',
      exit_code: 0,
      duration_ms: 1200,
      prompt_sha256: SHA_A,
      usage: { status: 'unknown', input_tokens: 'unknown', output_tokens: 'unknown', cache_tokens: 'unknown', cost_usd: 'unknown' },
      output_file: 'delegations/D001.output.txt',
      recorded_at: '2026-11-27T00:00:00.000Z',
    };
    assert.deepEqual(validateAgainstSchema('delegation-record', validDelegation).errors, []);
    assert.equal(validateAgainstSchema('delegation-record', { ...validDelegation, role: 'lead' }).valid, false);
    assert.equal(validateAgainstSchema('delegation-record', { ...validDelegation, delegation_id: 'X1' }).valid, false);
    assert.equal(validateAgainstSchema('delegation-record', { ...validDelegation, usage: { ...validDelegation.usage, cost_usd: 'about 3' } }).valid, false);
    // A self-reported record must carry the worker's result packet.
    assert.equal(validateAgainstSchema('delegation-record', { ...validDelegation, observation: 'self_reported' }).valid, false);

    // Ensure all 13 schema files exist under contracts/schemas/
    const schemaFiles = fs.readdirSync(path.join(CRAFTHELM_ROOT, 'contracts', 'schemas')).filter((f) => f.endsWith('.schema.json'));
    assert.equal(schemaFiles.length, 13);
  });
});
