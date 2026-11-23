import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createGenericAdapter } from '../../hosts/generic/adapter.mjs';
import { MODEL_TIERS, classifyTaskTier, routeTask } from '../../scripts/lib/model-router.mjs';

describe('Cost-Efficient Model Tier Router', () => {
  it('routes deterministic, lightweight, standard, and reasoning tasks to distinct tiers', () => {
    const det = routeTask({ task_type: 'verify' }, { host: 'antigravity' });
    assert.equal(det.tier, MODEL_TIERS.DETERMINISTIC);
    assert.equal(det.execution_mode, 'deterministic_script');
    assert.equal(det.estimated_llm_calls, 0);
    assert.equal(det.model_hint, null);

    const agyCaps = { status: 'AVAILABLE', supports_multi_model: true, supports_subagents: true, execution_mode: 'agy_cli' };
    const light = routeTask({ task_type: 'classify', prompt: 'triage log' }, { host: 'antigravity', capabilities: agyCaps });
    assert.equal(light.tier, MODEL_TIERS.LIGHTWEIGHT);
    assert.equal(light.model_hint, 'flash_lite');
    assert.equal(light.cross_provider_isolation, 'antigravity_only');

    const std = routeTask({ task_type: 'implement', files_count: 1, impacted_files_count: 1 }, { host: 'antigravity', capabilities: agyCaps });
    assert.equal(std.tier, MODEL_TIERS.STANDARD);
    assert.equal(std.model_hint, 'flash');
    assert.equal(std.direct_lead_optional, true);

    const high = routeTask({ task_type: 'architecture' }, { host: 'antigravity', capabilities: agyCaps });
    assert.equal(high.tier, MODEL_TIERS.REASONING);
    assert.equal(high.model_hint, 'pro');

    const claudeCaps = { status: 'AVAILABLE', supports_multi_model: true, supports_subagents: true, execution_mode: 'native_subagent' };
    const claudeLight = routeTask({ task_type: 'summarize' }, { host: 'claude', capabilities: claudeCaps });
    assert.equal(claudeLight.model_hint, 'haiku');
    assert.equal(claudeLight.cross_provider_isolation, 'claude_only');
  });

  it('escalates to reasoning tier on repeated failure retries or high risk', () => {
    const firstRepair = classifyTaskTier({ task_type: 'repair', retry_round: 1 });
    assert.equal(firstRepair.tier, MODEL_TIERS.STANDARD);

    const secondRepair = classifyTaskTier({ task_type: 'repair', retry_round: 2 });
    assert.equal(secondRepair.tier, MODEL_TIERS.REASONING);
    assert.ok(secondRepair.reasons.includes('escalated_after_repeated_failure'));

    const highRiskImplement = classifyTaskTier({ task_type: 'implement', risk_level: 'high' });
    assert.equal(highRiskImplement.tier, MODEL_TIERS.REASONING);
  });

  it('reports single-model degradation honestly and respects custom model_tiers overrides', () => {
    const singleCaps = { status: 'AVAILABLE', supports_multi_model: false, execution_mode: 'sequential_single_model' };
    const degraded = routeTask({ task_type: 'classify' }, { host: 'codex', capabilities: singleCaps });
    assert.equal(degraded.tier, MODEL_TIERS.LIGHTWEIGHT);
    assert.equal(degraded.degraded_to_single_model, true);
    assert.equal(degraded.model_hint, null);
    assert.ok(degraded.limitations.includes('single_model_environment_tier_separation_unavailable'));

    const customCaps = { status: 'AVAILABLE', supports_multi_model: true, execution_mode: 'custom_cli' };
    const overridden = routeTask(
      { task_type: 'classify' },
      {
        host: 'opencode',
        capabilities: customCaps,
        modelTiers: { lightweight: 'mini-fast', standard: 'dev-mid', reasoning: 'deep-think' },
      },
    );
    assert.equal(overridden.model_hint, 'mini-fast');
    assert.equal(overridden.degraded_to_single_model, false);
  });

  it('supports multilingual heuristics, CRAFTHELM_MODEL_* env overrides, host_profiles, and in-session supports_multi_model', () => {
    const koLight = classifyTaskTier({ prompt: '빌드 로그를 요약하고 분류해 줘' });
    assert.equal(koLight.tier, MODEL_TIERS.LIGHTWEIGHT);

    const koReason = classifyTaskTier({ prompt: '인증 보안 아키텍처 충돌 원인 분석' });
    assert.equal(koReason.tier, MODEL_TIERS.REASONING);

    const jaDet = classifyTaskTier({ prompt: '変更の影響度検証を実施' });
    assert.equal(jaDet.tier, MODEL_TIERS.DETERMINISTIC);

    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'crafthelm-router-'));
    try {
      fs.mkdirSync(path.join(tmpRepo, '.crafthelm'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRepo, '.crafthelm', 'config.json'),
        JSON.stringify({
          schema_version: '0.3',
          default_host: 'opencode',
          host_config: { supports_multi_model: true },
          model_routing: {
            host_profiles: {
              opencode: { lightweight: 'qwen-profile-mini', standard: 'qwen-profile-std', reasoning: 'qwen-profile-pro' },
            },
          },
        }),
        'utf8',
      );

      const profiled = routeTask(
        { task_type: 'classify' },
        {
          host: 'opencode',
          repoRoot: tmpRepo,
          inSession: true,
          env: { CRAFTHELM_MODEL_LIGHTWEIGHT: 'env-fallback-mini' },
        },
      );
      assert.equal(profiled.degraded_to_single_model, false);
      assert.equal(profiled.model_hint, 'qwen-profile-mini');

      const envUsed = routeTask(
        { task_type: 'summarize' },
        {
          host: 'local-llm',
          supportsMultiModel: true,
          inSession: true,
          env: { CRAFTHELM_MODEL_LIGHTWEIGHT: 'ollama/qwen-fast' },
        },
      );
      assert.equal(envUsed.model_hint, 'ollama/qwen-fast');

      const genericMulti = createGenericAdapter('custom-ide', { supports_multi_model: true });
      const caps = genericMulti.discoverCapabilities({ inSession: true });
      assert.equal(caps.supports_multi_model, true);
      const worker = genericMulti.selectWorker('explorer', caps, { tier: 'lightweight', modelTiers: { lightweight: 'ide-fast' } });
      assert.equal(worker.model_hint, 'ide-fast');

      // init-host style null placeholders must not overwrite CRAFTHELM_MODEL_* env vars
      fs.writeFileSync(
        path.join(tmpRepo, '.crafthelm', 'config.json'),
        JSON.stringify({
          schema_version: '0.3',
          default_host: 'local-host',
          host_config: { supports_multi_model: true },
          model_routing: {
            model_tiers: { lightweight: null, standard: null, reasoning: null },
          },
        }),
        'utf8',
      );
      const envOverNull = routeTask(
        { task_type: 'classify' },
        {
          host: 'local-host',
          repoRoot: tmpRepo,
          supportsMultiModel: true,
          inSession: true,
          env: { CRAFTHELM_MODEL_LIGHTWEIGHT: 'env-mini' },
        },
      );
      assert.equal(envOverNull.model_hint, 'env-mini');
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });
});
