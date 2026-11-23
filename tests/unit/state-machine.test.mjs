import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STATES, assertTransition, assertValidState, canTransition } from '../../scripts/lib/state-machine.mjs';

describe('State Machine Invariants', () => {
  it('explicitly forbids COMPLETE state', () => {
    assert.throws(() => assertValidState('COMPLETE'), /FORBIDDEN_STATE/);
    assert.throws(() => canTransition(STATES.READY_FOR_HUMAN_REVIEW, 'COMPLETE'), /FORBIDDEN_STATE/);
  });

  it('blocks direct ACCEPTED transitions without READY_FOR_HUMAN_REVIEW and human decision (H01/E11)', () => {
    assert.equal(canTransition(STATES.VERIFYING, STATES.ACCEPTED), false);
    assert.equal(canTransition(STATES.REVIEW_PACKAGE_DRAFT, STATES.ACCEPTED), false);
    assert.throws(() => assertTransition(STATES.VERIFYING, STATES.ACCEPTED), /INVALID_TRANSITION/);
    assert.throws(
      () => assertTransition(STATES.READY_FOR_HUMAN_REVIEW, STATES.ACCEPTED, {}),
      /ACCOUNTABILITY_BLOCK/,
    );
    assert.doesNotThrow(() =>
      assertTransition(STATES.READY_FOR_HUMAN_REVIEW, STATES.ACCEPTED, {
        humanDecision: { decision: 'accepted', actor: 'reviewer-1' },
      }),
    );
  });

  it('blocks Waterfall progression without explicit prior stage gate approval (E05)', () => {
    const waterfallContract = { methodology: { lifecycle: 'waterfall' } };
    assert.throws(
      () =>
        assertTransition(STATES.READY, STATES.RUNNING_STAGE, {
          contract: waterfallContract,
          requiredPriorGate: 'requirements',
          stageApprovals: {},
        }),
      /WATERFALL_GATE_BLOCKED/,
    );
    assert.doesNotThrow(() =>
      assertTransition(STATES.READY, STATES.RUNNING_STAGE, {
        contract: waterfallContract,
        requiredPriorGate: 'requirements',
        stageApprovals: { requirements: { approved: true, actor: 'pm' } },
      }),
    );
  });
});
