import fs from 'node:fs';
import { peerArtifactHashes } from './lib/task-artifacts.mjs';
import path from 'node:path';
import { summarizeDelegations } from './delegate.mjs';
import { assessEvidenceStrength } from './lib/evidence-strength.mjs';
import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import { evaluateLiteProfile } from './lib/lite-profile.mjs';
import { sha256CanonicalJson, sha256File, sha256Text } from './lib/crypto.mjs';
import { runShellCommand } from './lib/exec.mjs';
import {
  computeSnapshotDigest,
  extractChangedSymbols,
  getChangedFiles,
  getDiffText,
  getGitTreeHash,
  isGitRepo,
  readFileAtRef,
} from './lib/git.mjs';
import {
  getCheckpointPath,
  getContractPath,
  getEvidenceManifestPath,
  getRunDir,
  getVerificationStampPath,
  matchesAnyGlob,
  toPosixPath,
} from './lib/paths.mjs';
import { analyzeImpact } from './lib/impact-analysis.mjs';
import { collectTriedAndFailed } from './lib/handoff.mjs';
import { hasMemorySources, searchMemory } from './lib/memory.mjs';
import { classifyTaskTier } from './lib/model-router.mjs';
import { runMutationProbe } from './lib/mutation-probe.mjs';
import { assertValidSchema } from './lib/schema.mjs';
import { STATES } from './lib/state-machine.mjs';
import { extractCommandTargets } from './lib/test-runners.mjs';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function loadProtectedPolicy(repoRoot, contract, checkpoint, options) {
  const baseRef = contract.verification_policy?.policy_base_ref ?? checkpoint.baseline_git_head;
  const rulesRel = toPosixPath(contract.verification_policy?.reliability_rules_path ?? '.crafthelm/reliability-rules.json');
  const reviewRel = toPosixPath(contract.verification_policy?.review_policy_path ?? 'REVIEW.md');

  let policySource = 'contract_default';
  let reviewPolicyText = null;
  let rulesRaw = null;
  let tamperDetected = false;
  const tamperDetails = [];

  if (options.policyDir) {
    policySource = 'external_protected_dir';
    const extReview = path.join(options.policyDir, path.basename(reviewRel));
    const extRules = path.join(options.policyDir, path.basename(rulesRel));
    if (fs.existsSync(extReview)) reviewPolicyText = fs.readFileSync(extReview, 'utf8').replace(/\r\n/g, '\n');
    if (fs.existsSync(extRules)) rulesRaw = fs.readFileSync(extRules, 'utf8').replace(/\r\n/g, '\n');
  } else if (isGitRepo(repoRoot) && baseRef && baseRef !== 'UNBORN' && baseRef !== 'NO_GIT') {
    policySource = 'base_ref_git_show';
    const reviewAtRef = readFileAtRef(repoRoot, baseRef, reviewRel);
    if (reviewAtRef.exists) reviewPolicyText = reviewAtRef.content;
    const rulesAtRef = readFileAtRef(repoRoot, baseRef, rulesRel);
    if (rulesAtRef.exists) rulesRaw = rulesAtRef.content;

    // Detect if candidate working tree attempted to alter protected policy files
    const workReviewPath = path.join(repoRoot, reviewRel);
    if (fs.existsSync(workReviewPath)) {
      const workReview = fs.readFileSync(workReviewPath, 'utf8').replace(/\r\n/g, '\n');
      if (reviewAtRef.exists && workReview !== reviewAtRef.content) {
        tamperDetected = true;
        tamperDetails.push(`${reviewRel} modified in candidate working tree; enforcing protected base ref copy`);
      } else if (!reviewAtRef.exists) {
        // Check if protected path was added/modified without approval
        if (matchesAnyGlob(reviewRel, contract.scope?.protect ?? [])) {
          tamperDetected = true;
          tamperDetails.push(`${reviewRel} added inside protected path`);
        }
      }
    }

    const workRulesPath = path.join(repoRoot, rulesRel);
    if (fs.existsSync(workRulesPath)) {
      const workRules = fs.readFileSync(workRulesPath, 'utf8').replace(/\r\n/g, '\n');
      if (rulesAtRef.exists && workRules !== rulesAtRef.content) {
        tamperDetected = true;
        tamperDetails.push(`${rulesRel} modified in candidate working tree; enforcing protected base ref copy`);
      }
    }
  } else {
    const workReviewPath = path.join(repoRoot, reviewRel);
    const workRulesPath = path.join(repoRoot, rulesRel);
    if (fs.existsSync(workReviewPath)) reviewPolicyText = fs.readFileSync(workReviewPath, 'utf8').replace(/\r\n/g, '\n');
    if (fs.existsSync(workRulesPath)) rulesRaw = fs.readFileSync(workRulesPath, 'utf8').replace(/\r\n/g, '\n');
  }

  let reliabilityRules = [];
  if (rulesRaw) {
    const parsed = JSON.parse(rulesRaw);
    reliabilityRules = Array.isArray(parsed) ? parsed : (parsed.rules ?? []);
    for (const rule of reliabilityRules) {
      assertValidSchema('reliability-rule', rule, `reliability rule ${rule.id}`);
    }
  }

  const policyDigest = sha256Text(JSON.stringify({
    baseRef,
    reviewPolicyText: reviewPolicyText ?? '',
    rulesRaw: rulesRaw ?? '',
  }));

  return {
    baseRef: baseRef ?? 'NONE',
    policySource,
    policyDigest,
    reviewPolicyText,
    reliabilityRules,
    tamperDetected,
    tamperDetails,
  };
}

function parsePropertyEvidence(stdout, stderr) {
  const combined = `${stdout}\n${stderr}`;
  let seed = null;
  let counterexample = null;

  for (const line of combined.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') {
        if (obj.seed !== undefined) seed = obj.seed;
        if (obj.counterexample !== undefined) counterexample = obj.counterexample;
      }
    } catch {
      // Fall back to line-based extraction
    }
  }

  if (seed === null) {
    const seedMatch = combined.match(/seed\s*[:=]\s*([A-Za-z0-9_-]+)/i);
    if (seedMatch) seed = seedMatch[1];
  }
  if (counterexample === null) {
    const ceMatch = combined.match(/counterexample\s*[:=]\s*(.+)/i);
    if (ceMatch) counterexample = ceMatch[1].trim();
  }
  return { seed, counterexample };
}

function evaluateDifferential(ac, cmdResult, repoRoot) {
  let baselineOutput = ac.baseline ?? '';
  if (ac.baseline_command) {
    const baseRes = runShellCommand(ac.baseline_command, { cwd: repoRoot });
    if (baseRes.exitCode !== 0) {
      return {
        passed: false,
        reason: `Baseline command failed with exit ${baseRes.exitCode}`,
        diffs: [{ type: 'baseline_error', detail: baseRes.stderr || baseRes.stdout }],
      };
    }
    baselineOutput = baseRes.stdout;
  }

  const normOld = String(baselineOutput).replace(/\r\n/g, '\n').trim();
  const normNew = String(cmdResult.stdout).replace(/\r\n/g, '\n').trim();
  if (normOld === normNew) {
    return { passed: true, diffs: [] };
  }

  const allowedPatterns = (ac.allowed_diffs ?? []).map((pat) => new RegExp(pat));
  const diffs = [];

  try {
    const oldJson = JSON.parse(normOld);
    const newJson = JSON.parse(normNew);
    const keys = new Set([...Object.keys(oldJson), ...Object.keys(newJson)]);
    for (const k of [...keys].sort()) {
      const a = JSON.stringify(oldJson[k]);
      const b = JSON.stringify(newJson[k]);
      if (a !== b) {
        const allowed = allowedPatterns.some((rx) => rx.test(k) || rx.test(`${k}:${a}->${b}`));
        if (!allowed) {
          diffs.push({ key: k, old: oldJson[k], new: newJson[k] });
        }
      }
    }
  } catch {
    const oldLines = normOld.split('\n');
    const newLines = normNew.split('\n');
    const maxLen = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
      if (oldLines[i] !== newLines[i]) {
        const summary = `${oldLines[i] ?? ''} -> ${newLines[i] ?? ''}`;
        const allowed = allowedPatterns.some((rx) => rx.test(summary));
        if (!allowed) {
          diffs.push({ line: i + 1, old: oldLines[i] ?? null, new: newLines[i] ?? null });
        }
      }
    }
  }

  return {
    passed: diffs.length === 0,
    reason: diffs.length === 0 ? 'All differences covered by allowed_diffs' : `${diffs.length} unapproved differential mismatch(es)`,
    diffs,
  };
}

function decideSelectiveExecution(ac, impact, contract, selectiveMode) {
  if (!selectiveMode) {
    return { execute: true, reason: 'full_regression_mode' };
  }
  if (ac.always_run === true) {
    return { execute: true, reason: 'always_run_flag' };
  }
  const alwaysRunKinds = contract.verification_policy?.always_run_kinds ?? ['e2e'];
  if (alwaysRunKinds.includes(ac.kind)) {
    return { execute: true, reason: `always_run_kind:${ac.kind}` };
  }
  if (impact.fallback_to_full) {
    return { execute: true, reason: `fallback_to_full:${impact.fallback_reason}` };
  }

  const declaredTargets = (ac.target_files ?? []).map(toPosixPath);
  const cmdTargets = extractCommandTargets(ac.command);
  const totalTargets = declaredTargets.length + cmdTargets.files.length + cmdTargets.dirs.length + cmdTargets.symbols.length;
  if (totalTargets === 0) {
    return { execute: true, reason: 'umbrella_command_executed_for_safety' };
  }

  const selectedFiles = impact.selected_tests.map((t) => t.file);
  const impactedFiles = impact.impacted_files ?? [];
  const selectedSet = new Set(selectedFiles);
  const impactedSet = new Set(impactedFiles);
  const allAffectedFiles = [...new Set([...selectedFiles, ...impactedFiles])];

  const matched = [];
  for (const tf of declaredTargets) {
    if (allAffectedFiles.some((f) => matchesAnyGlob(f, [tf]))) {
      matched.push(tf);
    }
  }
  for (const f of cmdTargets.files) {
    if (selectedSet.has(f) || impactedSet.has(f)) {
      matched.push(f);
    }
  }
  for (const dir of cmdTargets.dirs) {
    if (dir === '.' || allAffectedFiles.some((f) => f === dir || f.startsWith(`${dir}/`))) {
      matched.push(dir);
    }
  }
  if (cmdTargets.symbols.length > 0) {
    const impactedSyms = new Set(
      [...(impact.impacted_functions ?? []), ...(impact.directly_changed_classes ?? [])].flatMap((qn) => {
        const raw = qn.split('::')[1] ?? '';
        const parts = raw.split('.');
        return [raw, parts[0], parts[parts.length - 1]].filter(Boolean);
      }),
    );
    for (const sym of cmdTargets.symbols) {
      const symLower = sym.toLowerCase();
      const hitFile = allAffectedFiles.some((f) => {
        const base = path.posix.basename(f);
        const stem = base.replace(/\.[^.]+$/, '');
        return base.toLowerCase() === symLower || stem.toLowerCase() === symLower;
      });
      if (hitFile || impactedSyms.has(sym)) {
        matched.push(sym);
      }
    }
  }

  if (matched.length > 0) {
    return { execute: true, reason: `impacted_target:${[...new Set(matched)].join(',')}` };
  }
  return {
    execute: false,
    reason: `Unimpacted by changed symbols (${impact.directly_changed_functions.slice(0, 3).join(', ') || 'none'})`,
  };
}

function readErrorExcerpt(runDir, stdoutFile, stderrFile) {
  const parts = [];
  for (const rel of [stderrFile, stdoutFile]) {
    if (!rel) continue;
    const abs = path.join(runDir, rel);
    if (fs.existsSync(abs)) {
      const txt = fs.readFileSync(abs, 'utf8').trim();
      if (txt) parts.push(txt);
    }
  }
  return parts.join('\n').slice(0, 400);
}

function classifyFailureCauseCategory(failureReasons) {
  const joined = failureReasons.join(' ');
  if (joined.includes('SCOPE_VIOLATION')) return 'SCOPE_VIOLATION';
  if (joined.includes('PROTECTED_PATH_VIOLATION')) return 'PROTECTED_PATH_VIOLATION';
  if (joined.includes('E2E_FAILED') || joined.includes('E2E_MISSING')) return 'E2E_FAILURE';
  if (joined.includes('LITE_PROFILE_EXCEEDED')) return 'LITE_PROFILE_EXCEEDED';
  if (joined.includes('RELIABILITY_ENFORCE_FAILED')) return 'RELIABILITY_RULE_FAILURE';
  if (joined.includes('REVIEW_STALE')) return 'STALE_REVIEW';
  return 'TEST_FAILURE';
}

/**
 * Record Red-First evidence before implementing a new feature or bugfix.
 */
export function recordRedEvidence(options) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const runId = options.runId;
  const acId = options.acId;
  const checkpointPath = getCheckpointPath(repoRoot, runId);
  const checkpoint = readJson(checkpointPath);
  const contract = readJson(options.contract ? path.resolve(options.contract) : getContractPath(repoRoot, checkpoint.task_id));

  const ac = contract.acceptance.find((a) => a.id === acId);
  if (!ac || !ac.command) {
    throw new Error(`Executable AC "${acId}" not found in contract`);
  }

  const res = runShellCommand(ac.command, { cwd: repoRoot });
  const expectedExit = ac.expected_exit_code ?? 0;
  const testsDir = path.join(getRunDir(repoRoot, runId), 'evidence', 'tests');
  fs.mkdirSync(testsDir, { recursive: true });
  const stdoutRel = `evidence/tests/${acId}.red.stdout.txt`;
  const stderrRel = `evidence/tests/${acId}.red.stderr.txt`;
  fs.writeFileSync(path.join(getRunDir(repoRoot, runId), stdoutRel), res.stdout, 'utf8');
  fs.writeFileSync(path.join(getRunDir(repoRoot, runId), stderrRel), res.stderr, 'utf8');

  if (res.exitCode === expectedExit) {
    return {
      ok: false,
      error_code: 'RED_NOT_OBSERVED',
      message: `AC "${acId}" already passed (exit ${res.exitCode}) before implementation; cannot prove new behavior via RED-First.`,
    };
  }

  checkpoint.red_records = checkpoint.red_records ?? {};
  checkpoint.red_records[acId] = {
    exit_code: res.exitCode,
    snapshot_digest: computeSnapshotDigest(repoRoot),
    stdout_file: stdoutRel,
    stderr_file: stderrRel,
    recorded_at: new Date().toISOString(),
  };
  checkpoint.updated_at = new Date().toISOString();
  assertValidSchema('checkpoint', checkpoint, `checkpoint ${runId}`);
  writeJson(checkpointPath, checkpoint);

  return { ok: true, ac_id: acId, red_exit_code: res.exitCode, stdout_file: stdoutRel };
}

/**
 * Record pre-refactor baseline GREEN evidence (`E03`).
 */
export function recordBaselineGreen(options) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const runId = options.runId;
  const acId = options.acId;
  const checkpointPath = getCheckpointPath(repoRoot, runId);
  const checkpoint = readJson(checkpointPath);
  const contract = readJson(options.contract ? path.resolve(options.contract) : getContractPath(repoRoot, checkpoint.task_id));

  const ac = contract.acceptance.find((a) => a.id === acId);
  if (!ac || !ac.command) {
    throw new Error(`Executable AC "${acId}" not found in contract`);
  }

  const res = runShellCommand(ac.command, { cwd: repoRoot });
  const expectedExit = ac.expected_exit_code ?? 0;
  const testsDir = path.join(getRunDir(repoRoot, runId), 'evidence', 'tests');
  fs.mkdirSync(testsDir, { recursive: true });
  const stdoutRel = `evidence/tests/${acId}.baseline.stdout.txt`;
  const stderrRel = `evidence/tests/${acId}.baseline.stderr.txt`;
  fs.writeFileSync(path.join(getRunDir(repoRoot, runId), stdoutRel), res.stdout, 'utf8');
  fs.writeFileSync(path.join(getRunDir(repoRoot, runId), stderrRel), res.stderr, 'utf8');

  if (res.exitCode !== expectedExit) {
    return {
      ok: false,
      error_code: 'BASELINE_GREEN_FAILED',
      message: `Baseline check "${acId}" failed (exit ${res.exitCode}) before refactoring`,
    };
  }

  checkpoint.baseline_green_records = checkpoint.baseline_green_records ?? {};
  checkpoint.baseline_green_records[acId] = {
    exit_code: res.exitCode,
    snapshot_digest: computeSnapshotDigest(repoRoot),
    stdout_file: stdoutRel,
    stderr_file: stderrRel,
    recorded_at: new Date().toISOString(),
  };
  checkpoint.updated_at = new Date().toISOString();
  assertValidSchema('checkpoint', checkpoint, `checkpoint ${runId}`);
  writeJson(checkpointPath, checkpoint);

  return { ok: true, ac_id: acId, exit_code: res.exitCode, stdout_file: stdoutRel };
}

/**
 * Execute deterministic verification on the frozen snapshot using protected base-ref policies.
 */
export function runVerify(options) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const runId = options.runId;
  const runDir = getRunDir(repoRoot, runId);
  const checkpointPath = getCheckpointPath(repoRoot, runId);
  const checkpoint = readJson(checkpointPath);
  const contractPath = options.contract ? path.resolve(options.contract) : getContractPath(repoRoot, checkpoint.task_id);
  const contract = readJson(contractPath);
  assertValidSchema('execution', contract, contractPath);

  const contractSha = sha256CanonicalJson(contract);
  const failureReasons = [];
  if (contractSha !== checkpoint.contract_sha256) {
    failureReasons.push('CONTRACT_HASH_MISMATCH: execution contract modified without replan');
  }

  const targetSnapshotDigest = computeSnapshotDigest(repoRoot);
  const finalTreeHash = isGitRepo(repoRoot) ? getGitTreeHash(repoRoot) : 'NO_GIT';
  const policy = loadProtectedPolicy(repoRoot, contract, checkpoint, options);
  if (policy.tamperDetected) {
    failureReasons.push(...policy.tamperDetails);
  }

  // Scope & protected path analysis
  const rawChangedFiles = isGitRepo(repoRoot) ? getChangedFiles(repoRoot, checkpoint.baseline_git_head) : [];
  const baselineCraftHelm = checkpoint.baseline_crafthelm_files ?? {};
  const peerHashes = peerArtifactHashes(repoRoot, checkpoint.task_id);
  const changedFiles = rawChangedFiles.filter((rel) => {
    // A sibling task must never exempt changes to this run's own or protected files.
    const baseline = Object.hasOwn(baselineCraftHelm, rel)
      ? baselineCraftHelm[rel]
      : !matchesAnyGlob(rel, contract.scope.protect) && peerHashes.get(rel);
    if (!baseline) return true;
    const abs = path.join(repoRoot, rel);
    return !fs.existsSync(abs) || sha256File(abs) !== baseline;
  });

  const outOfScopeFiles = changedFiles.filter((rel) => !matchesAnyGlob(rel, contract.scope.allow));
  const protectedViolations = new Set(changedFiles.filter((rel) => matchesAnyGlob(rel, contract.scope.protect)));

  for (const [protRel, oldHash] of Object.entries(checkpoint.protected_file_hashes ?? {})) {
    const abs = path.join(repoRoot, protRel);
    const curHash = fs.existsSync(abs) ? sha256File(abs) : 'DELETED';
    if (curHash !== oldHash) {
      protectedViolations.add(protRel);
    }
  }
  if (policy.tamperDetected) {
    for (const detail of policy.tamperDetails) {
      const firstToken = detail.split(' ')[0];
      if (firstToken) protectedViolations.add(firstToken);
    }
  }

  const diffText = isGitRepo(repoRoot) ? getDiffText(repoRoot, checkpoint.baseline_git_head) : '';
  const diffRel = 'evidence/changes.patch';
  fs.mkdirSync(path.join(runDir, 'evidence', 'tests'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'evidence', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(runDir, diffRel), diffText, 'utf8');

  const impact = analyzeImpact(repoRoot, {
    baseRef: checkpoint.baseline_git_head,
    policyBaseRef: policy.baseRef,
    policyDir: options.policyDir,
    changedFiles,
    diffText,
    testPatterns: contract.verification_policy?.test_file_patterns,
    globalFallbackPatterns: contract.verification_policy?.global_fallback_patterns,
    testCommandTemplate: contract.verification_policy?.test_command_template,
    testCommandTemplates: contract.verification_policy?.test_command_templates,
    customAnalyzerCmd: contract.verification_policy?.custom_impact_analyzer,
    ignoredDirs: contract.verification_policy?.ignored_dirs,
  });
  const impactRel = 'evidence/impact-analysis.json';
  writeJson(path.join(runDir, impactRel), impact);

  const selectiveRequested = Boolean(options.selective) || contract.verification_policy?.regression_mode === 'selective';
  const effectiveRegressionMode = !selectiveRequested
    ? 'full'
    : impact.fallback_to_full
      ? 'fallback_to_full'
      : 'selective';

  const scopeStatus = outOfScopeFiles.length === 0 && protectedViolations.size === 0 && !policy.tamperDetected ? 'PASS' : 'FAIL';
  if (outOfScopeFiles.length > 0) {
    failureReasons.push(`SCOPE_VIOLATION: Out-of-scope file changes: ${outOfScopeFiles.join(', ')}`);
  }
  if (protectedViolations.size > 0) {
    failureReasons.push(`PROTECTED_PATH_VIOLATION: Protected files altered: ${[...protectedViolations].join(', ')}`);
  }

  // Execute Acceptance Criteria
  const checks = [];
  const unverified = [];
  let hasBlocked = false;

  for (const ac of contract.acceptance) {
    if (ac.applicable === false) {
      checks.push({
        id: ac.id,
        requirement: ac.requirement,
        kind: ac.kind,
        status: 'NOT_APPLICABLE',
        reason: ac.not_applicable_reason,
      });
      continue;
    }

    if (ac.kind === 'manual') {
      checks.push({
        id: ac.id,
        requirement: ac.requirement,
        kind: ac.kind,
        status: 'UNVERIFIED',
        reason: ac.manual_method,
      });
      unverified.push(`${ac.id} (manual: ${ac.manual_method})`);
      continue;
    }

    const selection = decideSelectiveExecution(ac, impact, contract, selectiveRequested);
    if (!selection.execute) {
      checks.push({
        id: ac.id,
        requirement: ac.requirement,
        kind: ac.kind,
        command: ac.command,
        exit_code: null,
        status: 'SKIPPED_UNIMPACTED',
        reason: 'Skipped unimpacted check under selective regression mode',
        selection_reason: selection.reason,
      });
      continue;
    }

    if (options.progress) {
      process.stderr.write(`[verify] Running ${ac.id} (${ac.kind}): ${ac.command}\n`);
    }
    const res = runShellCommand(ac.command, { cwd: repoRoot });
    const stdoutRel = `evidence/tests/${ac.id}.stdout.txt`;
    const stderrRel = `evidence/tests/${ac.id}.stderr.txt`;
    fs.writeFileSync(path.join(runDir, stdoutRel), res.stdout, 'utf8');
    fs.writeFileSync(path.join(runDir, stderrRel), res.stderr, 'utf8');

    const expectedExit = ac.expected_exit_code ?? 0;
    let status = res.exitCode === expectedExit ? 'PASS' : 'FAIL';
    let reason = status === 'PASS' ? 'Exit code matched expected' : `Expected exit ${expectedExit}, got ${res.exitCode}`;
    let counterexampleFile;
    let seed = null;
    let diffReportFile;

    if (ac.require_red_first && !checkpoint.red_records?.[ac.id]) {
      status = 'FAIL';
      reason = 'RED-First evidence missing for AC requiring pre-implementation failure proof';
    }

    if (ac.kind === 'property' && status === 'FAIL') {
      const prop = parsePropertyEvidence(res.stdout, res.stderr);
      seed = prop.seed;
      counterexampleFile = `evidence/tests/${ac.id}.counterexample.json`;
      writeJson(path.join(runDir, counterexampleFile), {
        ac_id: ac.id,
        command: ac.command,
        seed: prop.seed,
        counterexample: prop.counterexample,
        exit_code: res.exitCode,
        recorded_at: new Date().toISOString(),
      });
    }

    if (ac.kind === 'differential' && res.exitCode === expectedExit) {
      const diffEval = evaluateDifferential(ac, res, repoRoot);
      diffReportFile = `evidence/tests/${ac.id}.diff.json`;
      writeJson(path.join(runDir, diffReportFile), {
        ac_id: ac.id,
        passed: diffEval.passed,
        reason: diffEval.reason,
        allowed_diffs: ac.allowed_diffs ?? [],
        unapproved_diffs: diffEval.diffs,
      });
      if (!diffEval.passed) {
        status = 'FAIL';
        reason = diffEval.reason;
      }
    }

    if (options.progress) {
      process.stderr.write(`[verify] ${ac.id} -> ${status} (${res.durationMs}ms)\n`);
    }
    if (status === 'FAIL') {
      failureReasons.push(`AC_FAILED:${ac.id}: ${reason}`);
    } else if (status === 'BLOCKED') {
      hasBlocked = true;
      failureReasons.push(`AC_BLOCKED:${ac.id}: ${reason}`);
    }

    checks.push({
      id: ac.id,
      requirement: ac.requirement,
      kind: ac.kind,
      command: ac.command,
      exit_code: res.exitCode,
      status,
      reason,
      duration_ms: res.durationMs,
      stdout_file: stdoutRel,
      stderr_file: stderrRel,
      ...(selectiveRequested ? { selection_reason: selection.reason } : {}),
      ...(counterexampleFile ? { counterexample_file: counterexampleFile, seed } : {}),
      ...(diffReportFile ? { diff_report_file: diffReportFile } : {}),
    });
  }

  // V01 / E15: Functional feature/bugfix requires executed & passing E2E smoke
  const isFunctional =
    (contract.change_kind === 'feature' || contract.change_kind === 'bugfix' || !contract.change_kind) &&
    contract.verification_policy?.require_e2e_for_functional !== false;

  // Optional mutation probe: break changed lines one at a time and expect a passing check to fail.
  // It runs before the lite decision so that surviving mutants count against the exemption.
  const probeRequested = Boolean(options.mutationProbe) || contract.verification_policy?.mutation_probe === true;
  let mutationProbe = null;
  let mutationProbeRel = null;
  if (probeRequested) {
    if (hasBlocked || failureReasons.length > 0) {
      const reason = hasBlocked ? 'an acceptance check is BLOCKED' : `verification already failed (${failureReasons[0].split(':')[0]})`;
      mutationProbe = { status: 'SKIPPED', reason, total: 0, killed: 0, survived: 0, score: null, mutants: [] };
    } else {
      const probeKinds = new Set(['fast', 'unit', 'test', 'e2e', 'property']);
      const acById = new Map(contract.acceptance.map((ac) => [ac.id, ac]));
      if (options.progress) process.stderr.write('[verify] Running mutation probe on changed lines\n');
      mutationProbe = runMutationProbe({
        repoRoot,
        journalDir: path.join(runDir, 'evidence'),
        diffText,
        sourceFiles: assessEvidenceStrength({ contract, checks, impact, changedFiles }).changed_source_files,
        commands: checks
          .filter((c) => c.status === 'PASS' && c.command && probeKinds.has(c.kind))
          .map((c) => ({ id: c.id, command: c.command, expected_exit_code: acById.get(c.id)?.expected_exit_code ?? 0 })),
        maxMutants: options.maxMutants ?? contract.verification_policy?.mutation_probe_max_mutants,
      });
      if (options.progress) {
        process.stderr.write(`[verify] Mutation probe -> ${mutationProbe.status} (killed ${mutationProbe.killed}/${mutationProbe.total})\n`);
      }
    }
    mutationProbeRel = 'evidence/mutation-probe.json';
    writeJson(path.join(runDir, mutationProbeRel), mutationProbe);
  }

  const evidenceStrength = assessEvidenceStrength({ contract, checks, impact, changedFiles, mutationProbe });

  // Lite profile: the E2E requirement is waived only while the real diff stays small and well-tested.
  // The strength already includes the mutation probe, so weak probe results revoke the exemption.
  const liteProfile = evaluateLiteProfile({ contract, strength: evidenceStrength, diffText });
  let e2eExempted = false;

  if (isFunctional) {
    const e2eChecks = checks.filter((c) => c.kind === 'e2e' && c.status !== 'NOT_APPLICABLE');
    if (e2eChecks.length === 0 && liteProfile.profile === 'lite' && liteProfile.eligible) {
      e2eExempted = true;
      unverified.push('E2E smoke not executed (waived by lite profile)');
    } else if (e2eChecks.length === 0 && liteProfile.profile === 'lite') {
      failureReasons.push(
        `LITE_PROFILE_EXCEEDED: ${liteProfile.violations.join('; ')}. Add an e2e acceptance check or re-plan the task with the full profile.`,
      );
      unverified.push('E2E smoke missing: change no longer qualifies for the lite profile');
    } else if (e2eChecks.length === 0) {
      failureReasons.push('E2E_MISSING: Functional feature/bugfix requires at least one executed e2e check');
      unverified.push('E2E smoke missing for functional change');
    } else if (e2eChecks.some((c) => c.status !== 'PASS')) {
      failureReasons.push('E2E_FAILED: E2E execution failed; unit tests alone cannot grant technical pass');
    }
  }

  // V05 / V08: Diff-Triggered Reliability Rules
  const changedSymbols = extractChangedSymbols(diffText);
  const reliabilityChecks = [];
  for (const rule of policy.reliabilityRules) {
    const pathMatched = changedFiles.some((f) => matchesAnyGlob(f, rule.trigger.paths));
    const reqSymbols = rule.trigger.changed_symbols ?? [];
    const symbolMatched = reqSymbols.length === 0 || reqSymbols.some((sym) => changedSymbols.includes(sym));
    const triggered = pathMatched && symbolMatched;

    if (!triggered) {
      const nonTriggerReason = !pathMatched
        ? `No changed file matched trigger.paths (${rule.trigger.paths.join(', ')})`
        : `Changed symbols (${changedSymbols.join(', ') || 'none'}) did not match trigger.changed_symbols (${reqSymbols.join(', ')})`;
      reliabilityChecks.push({
        id: rule.id,
        triggered: false,
        non_trigger_reason: nonTriggerReason,
        policy_mode: rule.policy_mode,
        severity: rule.severity,
        status: 'SKIPPED',
      });
      continue;
    }

    if (rule.policy_mode === 'off') {
      reliabilityChecks.push({
        id: rule.id,
        triggered: true,
        non_trigger_reason: 'Rule policy_mode is off',
        policy_mode: rule.policy_mode,
        severity: rule.severity,
        status: 'SKIPPED',
      });
      continue;
    }

    let ruleRes = { exitCode: 0, stdout: 'Rule command not specified; marked observed', stderr: '' };
    if (rule.check.command) {
      ruleRes = runShellCommand(rule.check.command, { cwd: repoRoot });
    }
    const evidenceRel = `evidence/rules/${rule.id}.json`;
    const passed = ruleRes.exitCode === 0;
    let ruleStatus = passed ? 'PASS' : (rule.policy_mode === 'observe' ? 'OBSERVED_FAIL' : 'FAIL');
    writeJson(path.join(runDir, evidenceRel), {
      id: rule.id,
      command_id: rule.check.command_id,
      command: rule.check.command ?? null,
      policy_mode: rule.policy_mode,
      severity: rule.severity,
      exit_code: ruleRes.exitCode,
      status: ruleStatus,
      stdout: ruleRes.stdout,
      stderr: ruleRes.stderr,
    });

    if (!passed && rule.policy_mode === 'enforce' && rule.severity === 'must_fix') {
      failureReasons.push(`RELIABILITY_ENFORCE_FAILED:${rule.id}`);
    }

    reliabilityChecks.push({
      id: rule.id,
      triggered: true,
      policy_mode: rule.policy_mode,
      severity: rule.severity,
      status: ruleStatus,
      evidence_file: evidenceRel,
    });
  }

  // Independent advisory review check + snapshot stale detection (V03 / E19)
  let reviewInfo = { status: 'NOT_RUN', target_snapshot_digest: null };
  const reviewPath = options.reviewFile
    ? path.resolve(options.reviewFile)
    : path.join(runDir, 'evidence', 'review.json');

  if (fs.existsSync(reviewPath)) {
    const rev = readJson(reviewPath);
    const reviewFindingsRel = 'evidence/review.json';
    if (path.resolve(reviewPath) !== path.join(runDir, reviewFindingsRel)) {
      writeJson(path.join(runDir, reviewFindingsRel), rev);
    }
    const isStale = rev.target_snapshot_digest && rev.target_snapshot_digest !== targetSnapshotDigest;
    reviewInfo = {
      status: isStale ? 'STALE' : (rev.status ?? 'PASS'),
      findings_file: reviewFindingsRel,
      target_snapshot_digest: rev.target_snapshot_digest ?? null,
      independent_cross_model: Boolean(rev.independent_cross_model ?? false),
    };
    if (isStale) {
      failureReasons.push('REVIEW_STALE: Advisory review snapshot digest does not match current target snapshot');
    } else if (rev.status === 'FINDINGS') {
      failureReasons.push('REVIEW_FINDINGS: Independent reviewer reported unresolved findings');
    }
  } else if (options.requireReview) {
    unverified.push('AI independent review not recorded');
  }

  const anyCheckBlocked = hasBlocked;
  const anyFailure = failureReasons.length > 0;
  let technicalStatus = 'VERIFIED';
  let verificationLevel = 'verified';

  if (reviewInfo.status === 'STALE') {
    technicalStatus = 'STALE';
    verificationLevel = 'none';
  } else if (anyCheckBlocked) {
    technicalStatus = 'BLOCKED';
    verificationLevel = 'partial';
  } else if (anyFailure) {
    technicalStatus = 'FAILED';
    verificationLevel = checks.some((c) => c.status === 'PASS') ? 'partial' : 'none';
  } else if (unverified.length > 0) {
    technicalStatus = 'PARTIAL';
    verificationLevel = 'partial';
  }

  const stamp = {
    schema_version: '0.3',
    run_id: runId,
    target_snapshot_digest: targetSnapshotDigest,
    baseline_git_head: checkpoint.baseline_git_head,
    policy_base_ref: policy.baseRef,
    policy_digest: policy.policyDigest,
    policy_source: policy.policySource,
    verification_level: verificationLevel,
    stale: reviewInfo.status === 'STALE',
    impact_analysis_file: impactRel,
    regression_mode: effectiveRegressionMode,
    checks: checks.map((c) => ({
      id: c.id,
      kind: c.kind,
      status: c.status,
      evidence_ref: c.stdout_file ?? null,
    })),
    reliability_rules_evaluated: reliabilityChecks.map((r) => ({
      id: r.id,
      triggered: r.triggered,
      ...(r.non_trigger_reason ? { non_trigger_reason: r.non_trigger_reason } : {}),
      policy_mode: r.policy_mode,
      status: r.status,
      evidence_ref: r.evidence_file ?? null,
    })),
    review: {
      status: reviewInfo.status,
      target_snapshot_digest: reviewInfo.target_snapshot_digest,
    },
    unverified,
    human_acceptance: 'PENDING',
    stamped_at: new Date().toISOString(),
  };

  assertValidSchema('verification-stamp', stamp, `verification-stamp ${runId}`);
  const stampRel = 'evidence/verification-stamp.json';
  writeJson(path.join(runDir, stampRel), stamp);

  let feedbackPacketRel = null;
  if (technicalStatus === 'FAILED' || technicalStatus === 'BLOCKED' || technicalStatus === 'STALE') {
    const causeCategory = classifyFailureCauseCategory(failureReasons);
    const currentRound = checkpoint.repair_rounds?.[causeCategory] ?? 0;
    const repairLimit = Math.min(3, contract.budgets?.max_worker_retries_per_cause ?? 3);
    const nextRound = currentRound + 1;
    const tierDecision = classifyTaskTier({
      task_type: 'repair',
      retry_round: nextRound,
      impacted_files_count: impact.impacted_files.length,
      escalate_on_retry: contract.model_routing?.escalate_on_retry ?? 2,
    });
    const failedChecks = checks
      .filter((c) => c.status === 'FAIL' || c.status === 'BLOCKED')
      .map((c) => ({
        id: c.id,
        kind: c.kind,
        exit_code: c.exit_code ?? null,
        status: c.status,
        reason: c.reason ?? 'check failed',
        error_excerpt: readErrorExcerpt(runDir, c.stdout_file, c.stderr_file),
      }));
    const triedAndFailed = collectTriedAndFailed(repoRoot, runId).map((t) => ({
      round: t.round,
      cause_id: t.cause_id,
      ...(t.check_id ? { check_id: t.check_id } : {}),
      ...(t.repro_command ? { repro_command: t.repro_command } : {}),
      ...(t.note ? { note: t.note } : {}),
      ...(t.recorded_at ? { recorded_at: t.recorded_at } : {}),
    }));
    let priorMemoryHits = [];
    if (hasMemorySources(repoRoot)) {
      const memQuery = [
        causeCategory,
        contract.request ?? '',
        ...failedChecks.map((f) => `${f.id} ${f.reason}`),
        ...impact.impacted_features,
      ].join(' ').trim();
      if (memQuery) {
        priorMemoryHits = searchMemory({ repo: repoRoot, query: memQuery, limit: 5 }).hits.map((h) => ({
          id: h.id,
          kind: h.kind,
          title: h.title,
          status: h.status,
          source_path: h.source_path,
          score: h.score,
          excerpt: h.excerpt,
          decayed: h.decayed,
        }));
      }
    }

    const packet = {
      schema_version: '0.3',
      run_id: runId,
      task_id: contract.task_id,
      round: currentRound,
      repair_limit: repairLimit,
      status: currentRound >= repairLimit ? 'ESCALATED' : 'FAIL',
      failed_checks: failedChecks,
      impacted_functions: impact.impacted_functions,
      impacted_classes: impact.directly_changed_classes,
      impacted_features: impact.impacted_features,
      scope_violation: scopeStatus === 'FAIL',
      root_cause_category: causeCategory,
      recommended_tier: tierDecision.tier,
      decision_needed: currentRound >= repairLimit ? 'escalate_to_human' : 'repair_existing_scope',
      escalate_to_human: currentRound >= repairLimit,
      artifact_refs: [
        diffRel,
        impactRel,
        ...failedChecks.map((f) => checks.find((c) => c.id === f.id)?.stderr_file).filter(Boolean),
      ],
      tried_and_failed: triedAndFailed,
      prior_memory_hits: priorMemoryHits,
      generated_at: new Date().toISOString(),
    };
    assertValidSchema('feedback-packet', packet, `feedback-packet ${runId}`);
    feedbackPacketRel = 'evidence/feedback-packet.json';
    writeJson(path.join(runDir, feedbackPacketRel), packet);
  }

  const executedCount = checks.filter((c) => !['NOT_APPLICABLE', 'UNVERIFIED', 'SKIPPED_UNIMPACTED'].includes(c.status)).length;
  const skippedCount = checks.filter((c) => c.status === 'SKIPPED_UNIMPACTED').length;


  const manifest = {
    schema_version: '0.3',
    run_id: runId,
    contract_sha256: contractSha,
    baseline_git_head: checkpoint.baseline_git_head,
    final_tree_hash: finalTreeHash,
    target_snapshot_digest: targetSnapshotDigest,
    skill_lock_sha256: checkpoint.skill_lock_sha256 ?? 'none',
    verification_stamp_file: stampRel,
    verification_level: verificationLevel,
    checks,
    reliability_checks: reliabilityChecks,
    review: reviewInfo,
    scope: {
      status: scopeStatus,
      diff_file: diffRel,
      changed_files: changedFiles,
      out_of_scope_files: outOfScopeFiles,
      protected_violations: [...protectedViolations].sort(),
      policy_tamper_detected: policy.tamperDetected,
    },
    technical_status: technicalStatus,
    evidence_strength: evidenceStrength,
    delegation: summarizeDelegations(repoRoot, runId),
    process_profile: {
      profile: liteProfile.profile,
      e2e_exempted: e2eExempted,
      violations: liteProfile.violations,
      limits: liteProfile.limits,
      observed: liteProfile.observed,
    },
    mutation_probe: mutationProbe
      ? {
          status: mutationProbe.status,
          total: mutationProbe.total,
          killed: mutationProbe.killed,
          survived: mutationProbe.survived,
          score: mutationProbe.score,
          evidence_file: mutationProbeRel,
        }
      : { status: 'NOT_REQUESTED', total: 0, killed: 0, survived: 0, score: null, evidence_file: null },
    failure_reasons: failureReasons,
    impact_analysis_file: impactRel,
    feedback_packet_file: feedbackPacketRel,
    regression_selection: {
      mode: effectiveRegressionMode,
      fallback_to_full: impact.fallback_to_full,
      fallback_reason: impact.fallback_reason,
      total_checks: checks.length,
      executed_count: executedCount,
      skipped_count: skippedCount,
      selected_tests: impact.selected_tests.map((t) => t.file),
      unselected_tests: impact.unselected_tests.map((t) => t.file),
    },
    human_review: {
      status: 'PENDING',
      package_file: null,
      package_sha256: null,
      editorial_report_file: null,
    },
  };

  assertValidSchema('evidence', manifest, `evidence-manifest ${runId}`);
  writeJson(getEvidenceManifestPath(repoRoot, runId), manifest);

  checkpoint.target_snapshot_digest = targetSnapshotDigest;
  checkpoint.current_stage = 'technical_verification';
  checkpoint.state = technicalStatus === 'FAILED' || technicalStatus === 'STALE'
    ? STATES.REPAIRING
    : technicalStatus === 'BLOCKED'
      ? STATES.BLOCKED
      : STATES.VERIFYING;
  checkpoint.updated_at = new Date().toISOString();
  assertValidSchema('checkpoint', checkpoint, `checkpoint ${runId}`);
  writeJson(checkpointPath, checkpoint);

  return {
    ok: technicalStatus === 'VERIFIED' || technicalStatus === 'PARTIAL',
    run_id: runId,
    technical_status: technicalStatus,
    verification_level: verificationLevel,
    target_snapshot_digest: targetSnapshotDigest,
    policy_source: policy.policySource,
    policy_digest: policy.policyDigest,
    scope_status: scopeStatus,
    evidence_strength: evidenceStrength.level,
    evidence_strength_signals: evidenceStrength.signals.map((s) => s.code),
    mutation_probe: manifest.mutation_probe,
    process_profile: manifest.process_profile,
    failure_reasons: failureReasons,
    impact_analysis_file: impactRel,
    feedback_packet_file: feedbackPacketRel,
    regression_selection: manifest.regression_selection,
    manifest_file: 'evidence-manifest.json',
    stamp_file: stampRel,
  };
}

function printUsage() {
  process.stdout.write(
    [
      'CraftHelm Verification CLI (Execute AC Checks, E2E/Property/Diff, Reliability Rules)',
      '',
      'Usage:',
      '  verify.mjs --repo <path> --run-id <id> [--contract <path>] [--selective] [--review-file <path>] [--policy-dir <dir>] [--quiet]',
      '  verify.mjs --repo <path> --run-id <id> --record-red <ac-id> [--contract <path>]',
      '  verify.mjs --repo <path> --run-id <id> --record-baseline-green <ac-id> [--contract <path>]',
      '',
    ].join('\n'),
  );
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (isHelpRequested(argv)) {
    printUsage();
    process.exit(0);
  }
  const args = parseArgs(argv);
  try {
    let res;
    if (args['record-red']) {
      res = recordRedEvidence({
        repo: args.repo,
        runId: args['run-id'],
        acId: args['record-red'],
        contract: args.contract,
      });
    } else if (args['record-baseline-green']) {
      res = recordBaselineGreen({
        repo: args.repo,
        runId: args['run-id'],
        acId: args['record-baseline-green'],
        contract: args.contract,
      });
    } else {
      res = runVerify({
        repo: args.repo,
        runId: args['run-id'],
        contract: args.contract,
        reviewFile: args['review-file'],
        policyDir: args['policy-dir'],
        selective: Boolean(args.selective),
        mutationProbe: Boolean(args['mutation-probe']),
        maxMutants: args['max-mutants'] ? Number(args['max-mutants']) : undefined,
        progress: !args.quiet,
      });
    }
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    if (!res.ok) process.exit(1);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
