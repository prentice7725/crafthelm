import fs from 'node:fs';
import path from 'node:path';
import { getHostAdapter, normalizeHostId } from '../../hosts/registry.mjs';

export const MODEL_TIERS = Object.freeze({
  DETERMINISTIC: 'deterministic',
  LIGHTWEIGHT: 'lightweight',
  STANDARD: 'standard',
  REASONING: 'reasoning',
});

export const TASK_TYPE_TO_TIER = Object.freeze({
  verify: MODEL_TIERS.DETERMINISTIC,
  impact_analysis: MODEL_TIERS.DETERMINISTIC,
  scope_check: MODEL_TIERS.DETERMINISTIC,
  schema_validate: MODEL_TIERS.DETERMINISTIC,
  test_select: MODEL_TIERS.DETERMINISTIC,
  hash_check: MODEL_TIERS.DETERMINISTIC,

  classify: MODEL_TIERS.LIGHTWEIGHT,
  triage: MODEL_TIERS.LIGHTWEIGHT,
  summarize: MODEL_TIERS.LIGHTWEIGHT,
  log_digest: MODEL_TIERS.LIGHTWEIGHT,
  search: MODEL_TIERS.LIGHTWEIGHT,
  explore: MODEL_TIERS.LIGHTWEIGHT,
  question_draft: MODEL_TIERS.LIGHTWEIGHT,
  label: MODEL_TIERS.LIGHTWEIGHT,
  editorial_surface: MODEL_TIERS.LIGHTWEIGHT,

  implement: MODEL_TIERS.STANDARD,
  refactor: MODEL_TIERS.STANDARD,
  write_tests: MODEL_TIERS.STANDARD,
  plan_draft: MODEL_TIERS.STANDARD,
  repair: MODEL_TIERS.STANDARD,
  review_standard: MODEL_TIERS.STANDARD,
  docs_draft: MODEL_TIERS.STANDARD,

  architecture: MODEL_TIERS.REASONING,
  security_review: MODEL_TIERS.REASONING,
  conflict_resolution: MODEL_TIERS.REASONING,
  requirement_tradeoff: MODEL_TIERS.REASONING,
  root_cause_escalation: MODEL_TIERS.REASONING,
  replan: MODEL_TIERS.REASONING,
  contract_review: MODEL_TIERS.REASONING,
});

const DEFAULT_HOST_MODEL_HINTS = Object.freeze({
  claude: {
    [MODEL_TIERS.LIGHTWEIGHT]: 'haiku',
    [MODEL_TIERS.STANDARD]: 'sonnet',
    [MODEL_TIERS.REASONING]: 'opus',
  },
  antigravity: {
    [MODEL_TIERS.LIGHTWEIGHT]: 'flash_lite',
    [MODEL_TIERS.STANDARD]: 'flash',
    [MODEL_TIERS.REASONING]: 'pro',
  },
  codex: {
    [MODEL_TIERS.LIGHTWEIGHT]: null,
    [MODEL_TIERS.STANDARD]: null,
    [MODEL_TIERS.REASONING]: null,
  },
  generic: {
    [MODEL_TIERS.LIGHTWEIGHT]: null,
    [MODEL_TIERS.STANDARD]: null,
    [MODEL_TIERS.REASONING]: null,
  },
});

const TIER_TO_ROLE = Object.freeze({
  [MODEL_TIERS.DETERMINISTIC]: 'verifier',
  [MODEL_TIERS.LIGHTWEIGHT]: 'explorer',
  [MODEL_TIERS.STANDARD]: 'builder',
  [MODEL_TIERS.REASONING]: 'lead',
});

/**
 * Classify a task into one of 4 cost/capability tiers (`deterministic`, `lightweight`, `standard`, `reasoning`).
 * @param {{ task_type?: string, prompt?: string, risk_level?: 'low'|'medium'|'high', retry_round?: number, files_count?: number, impacted_files_count?: number, escalate_on_retry?: number }} [taskInput]
 */
export function classifyTaskTier(taskInput = {}) {
  const taskType = taskInput.task_type ? String(taskInput.task_type).trim().toLowerCase() : null;
  const prompt = String(taskInput.prompt ?? '').toLowerCase();
  const riskLevel = String(taskInput.risk_level ?? 'medium').toLowerCase();
  const retryRound = Number(taskInput.retry_round ?? 0);
  const filesCount = Number(taskInput.files_count ?? 0);
  const impactedFilesCount = Number(taskInput.impacted_files_count ?? 0);
  const escalateThreshold = Number(taskInput.escalate_on_retry ?? 2);

  let tier = null;
  let source = 'heuristic';
  const reasons = [];

  if (taskType && Object.hasOwn(TASK_TYPE_TO_TIER, taskType)) {
    tier = TASK_TYPE_TO_TIER[taskType];
    source = 'explicit_task_type';
    reasons.push(`task_type "${taskType}" maps to ${tier}`);
  } else {
    if (/(?:verify|schema|hash|diff scope|test select|impact analysis|검증|스키마|영향도|해시|検証|影響)/.test(prompt)) {
      tier = MODEL_TIERS.DETERMINISTIC;
      reasons.push('prompt matches deterministic script check');
    } else if (/(?:architect|security|auth|crypto|conflict|tradeoff|replan|root cause|escalat|아키텍처|보안|인증|충돌|원인|재계획|설계|アーキテクチャ|セキュリティ)/.test(prompt)) {
      tier = MODEL_TIERS.REASONING;
      reasons.push('prompt involves high-stakes architecture/security/conflict reasoning');
    } else if (/(?:classif|triage|summar|digest|search|explore|label|tag|extract|분류|요약|탐색|트리아지|로그|추출|分類|要約|探索)/.test(prompt)) {
      tier = MODEL_TIERS.LIGHTWEIGHT;
      reasons.push('prompt matches lightweight classification/triage/summarization');
    } else {
      tier = MODEL_TIERS.STANDARD;
      reasons.push('defaulted to standard execution tier');
    }
  }

  // Upgrade non-deterministic tiers under high risk, large blast radius, or repeated failures
  if (tier !== MODEL_TIERS.DETERMINISTIC) {
    if (riskLevel === 'high' && tier !== MODEL_TIERS.REASONING) {
      tier = MODEL_TIERS.REASONING;
      reasons.push('upgraded to reasoning due to high risk_level');
    }
    if (impactedFilesCount >= 5 && tier !== MODEL_TIERS.REASONING) {
      tier = MODEL_TIERS.REASONING;
      reasons.push(`upgraded to reasoning due to wide impact (${impactedFilesCount} impacted files)`);
    }
    if (retryRound >= escalateThreshold && tier !== MODEL_TIERS.REASONING) {
      tier = MODEL_TIERS.REASONING;
      reasons.push('escalated_after_repeated_failure');
    }
  }

  // ADR-004: Small 1-file standard edits may be handled directly by lead without subagent overhead
  const directLeadOptional =
    tier === MODEL_TIERS.STANDARD &&
    filesCount > 0 &&
    filesCount <= 1 &&
    impactedFilesCount <= 2 &&
    riskLevel !== 'high';

  return {
    tier,
    recommended_role: TIER_TO_ROLE[tier],
    classification_source: source,
    direct_lead_optional: directLeadOptional,
    reasons,
  };
}

/**
 * Resolve host-specific model identifier for a logical tier while respecting single-model honesty.
 * @param {string} hostId
 * @param {string} tier
 * @param {object} capabilities
 * @param {Record<string, string|null>} [modelTiersOverride]
 */
export function resolveHostModelForTier(hostId, tier, capabilities, modelTiersOverride = {}) {
  const normHost = normalizeHostId(hostId);

  if (tier === MODEL_TIERS.DETERMINISTIC) {
    return {
      host: normHost,
      tier,
      execution_mode: 'deterministic_script',
      model_hint: null,
      estimated_llm_calls: 0,
      degraded_to_single_model: false,
      limitations: [],
    };
  }

  if (!capabilities || capabilities.status !== 'AVAILABLE') {
    return {
      host: normHost,
      tier,
      execution_mode: 'UNAVAILABLE',
      model_hint: null,
      estimated_llm_calls: null,
      degraded_to_single_model: false,
      limitations: ['host_unavailable'],
    };
  }

  if (!capabilities.supports_multi_model) {
    return {
      host: normHost,
      tier,
      execution_mode: capabilities.execution_mode ?? 'sequential_single_model',
      model_hint: null,
      estimated_llm_calls: 1,
      degraded_to_single_model: true,
      limitations: ['single_model_environment_tier_separation_unavailable'],
    };
  }

  const hostDefaults = DEFAULT_HOST_MODEL_HINTS[normHost] ?? DEFAULT_HOST_MODEL_HINTS.generic;
  const hasExplicitOverride = Object.hasOwn(modelTiersOverride ?? {}, tier);
  const modelHint = hasExplicitOverride ? modelTiersOverride[tier] : (hostDefaults[tier] ?? null);

  return {
    host: normHost,
    tier,
    execution_mode: capabilities.execution_mode ?? (capabilities.supports_subagents ? 'native_subagent' : 'native_session'),
    model_hint: modelHint,
    estimated_llm_calls: 1,
    degraded_to_single_model: false,
    limitations: modelHint === null ? ['no_tier_model_alias_configured_using_host_default'] : [],
  };
}

function loadRoutingConfigFromRepo(repoRoot) {
  if (!repoRoot) return {};
  const configPath = path.join(path.resolve(repoRoot), '.crafthelm', 'config.json');
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

function readEnvModelTiers(env = process.env) {
  const out = {};
  if (env?.CRAFTHELM_MODEL_LIGHTWEIGHT) out.lightweight = env.CRAFTHELM_MODEL_LIGHTWEIGHT;
  if (env?.CRAFTHELM_MODEL_STANDARD) out.standard = env.CRAFTHELM_MODEL_STANDARD;
  if (env?.CRAFTHELM_MODEL_REASONING) out.reasoning = env.CRAFTHELM_MODEL_REASONING;
  return out;
}

function mergeNonNullTiers(...layers) {
  const merged = {};
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    for (const [tier, value] of Object.entries(layer)) {
      if (value !== null && value !== undefined && value !== '') {
        merged[tier] = value;
      }
    }
  }
  return merged;
}

/**
 * Route a CraftHelm task across cost-efficient model tiers for the active single-provider host.
 * @param {object} taskInput
 * @param {{ host?: string, repoRoot?: string, contract?: object, capabilities?: object, env?: NodeJS.ProcessEnv, modelTiers?: Record<string, string|null>, supportsMultiModel?: boolean, singleModel?: boolean, inSession?: boolean, cliCommand?: string, runner?: Function, resolve?: Function }} [options]
 */
export function routeTask(taskInput = {}, options = {}) {
  const repoConfig = loadRoutingConfigFromRepo(options.repoRoot);
  const contractRouting = options.contract?.model_routing ?? {};
  const hostId = normalizeHostId(
    options.host ?? taskInput.host ?? options.contract?.host ?? repoConfig.default_host ?? 'generic',
  );

  const escalateOnRetry =
    taskInput.escalate_on_retry ??
    contractRouting.escalate_on_retry ??
    repoConfig.model_routing?.escalate_on_retry ??
    2;

  const classification = classifyTaskTier({
    ...taskInput,
    escalate_on_retry: escalateOnRetry,
  });

  const envTiers = readEnvModelTiers(options.env ?? process.env);
  const repoHostProfile = repoConfig.model_routing?.host_profiles?.[hostId] ?? {};
  const contractHostProfile = contractRouting.host_profiles?.[hostId] ?? {};
  const modelTiersOverride = mergeNonNullTiers(
    envTiers,
    repoConfig.model_routing?.model_tiers,
    repoHostProfile,
    contractRouting.model_tiers,
    contractHostProfile,
    options.modelTiers,
  );

  let capabilities = options.capabilities ?? null;
  if (!capabilities) {
    if (classification.tier === MODEL_TIERS.DETERMINISTIC) {
      capabilities = { status: 'AVAILABLE', supports_multi_model: false, execution_mode: 'deterministic_script' };
    } else {
      const mergedHostConfig = {
        ...(repoConfig.host_config ?? {}),
        ...(options.contract?.host_config ?? {}),
        ...(options.supportsMultiModel ? { supports_multi_model: true } : {}),
      };
      const { adapter } = getHostAdapter(hostId, { hostConfig: mergedHostConfig });
      capabilities = adapter.discoverCapabilities({
        singleModel: Boolean(options.singleModel),
        inSession: Boolean(options.inSession),
        cliCommand: options.cliCommand,
        repoRoot: options.repoRoot,
        env: options.env,
        runner: options.runner,
        resolve: options.resolve,
      });
    }
  }

  const resolution = resolveHostModelForTier(hostId, classification.tier, capabilities, modelTiersOverride);

  return {
    host: resolution.host,
    tier: classification.tier,
    recommended_role: classification.recommended_role,
    execution_mode: resolution.execution_mode,
    model_hint: resolution.model_hint,
    estimated_llm_calls: resolution.estimated_llm_calls,
    degraded_to_single_model: resolution.degraded_to_single_model,
    direct_lead_optional: classification.direct_lead_optional,
    classification_source: classification.classification_source,
    reasons: classification.reasons,
    limitations: resolution.limitations,
    cross_provider_isolation: `${resolution.host}_only`,
  };
}
