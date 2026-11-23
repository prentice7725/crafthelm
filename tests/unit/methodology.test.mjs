import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STANDARD_STAGES, composeMethodologyPlan } from '../../scripts/lib/methodology.mjs';

describe('4-Axis Methodology Composer', () => {
  it('supports waterfall + sdd + tdd + stage with stage gates', () => {
    const plan = composeMethodologyPlan(
      { lifecycle: 'waterfall', specification: 'sdd', engineering: 'tdd', execution: 'stage' },
      'feature',
    );
    assert.equal(plan.stages.length, STANDARD_STAGES.length);
    assert.equal(plan.requires_red_first, true);
    assert.equal(plan.requires_e2e_smoke, true);

    const reqStage = plan.stages.find((s) => s.stage === 'requirements');
    const archStage = plan.stages.find((s) => s.stage === 'architecture');
    const handoffStage = plan.stages.find((s) => s.stage === 'handoff');
    assert.equal(reqStage.waterfall_gate, true);
    assert.equal(archStage.waterfall_gate, true);
    assert.equal(handoffStage.included, false);
  });

  it('supports iterative + lightweight + tdd + full', () => {
    const plan = composeMethodologyPlan(
      { lifecycle: 'iterative', specification: 'lightweight', engineering: 'tdd', execution: 'full' },
      'feature',
    );
    const detailedDesign = plan.stages.find((s) => s.stage === 'detailed_design');
    assert.equal(detailedDesign.included, false);
    assert.ok(detailedDesign.skipped_reason);
  });

  it('supports incremental + existing + characterization_first + full for refactoring', () => {
    const plan = composeMethodologyPlan(
      { lifecycle: 'incremental', specification: 'existing', engineering: 'characterization_first', execution: 'full' },
      'refactor',
    );
    assert.equal(plan.requires_red_first, false);
    assert.equal(plan.requires_baseline_green, true);
    const reqStage = plan.stages.find((s) => s.stage === 'requirements');
    assert.equal(reqStage.included, false);
  });

  it('does not force RED tests on docs/research changes', () => {
    const plan = composeMethodologyPlan(
      { lifecycle: 'iterative', specification: 'lightweight', engineering: 'tdd', execution: 'full' },
      'docs',
    );
    assert.equal(plan.requires_red_first, false);
    assert.equal(plan.requires_e2e_smoke, false);
    const verifyStage = plan.stages.find((s) => s.stage === 'technical_verification');
    assert.match(verifyStage.verification, /without forced RED test/);
  });
});
