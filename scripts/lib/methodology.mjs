import { WATERFALL_GATED_STAGES } from './state-machine.mjs';

export const STANDARD_STAGES = Object.freeze([
  'discover',
  'interview',
  'requirements',
  'architecture',
  'detailed_design',
  'tasks',
  'implementation',
  'integration',
  'technical_verification',
  'review_package',
  'human_acceptance',
  'handoff',
]);

/**
 * Compose a 4-axis methodology stage execution plan (Section 3 & 3.1).
 * @param {{ lifecycle: string, specification: string, engineering: string, execution: string }} methodology
 * @param {string} [changeKind]
 * @returns {{ methodology: object, change_kind: string, stages: object[] }}
 */
export function composeMethodologyPlan(methodology, changeKind = 'feature') {
  const lifecycle = methodology?.lifecycle ?? 'incremental';
  const specification = methodology?.specification ?? 'sdd';
  const engineering = methodology?.engineering ?? 'tdd';
  const execution = methodology?.execution ?? 'full';

  const isDocsOrResearch = changeKind === 'docs' || changeKind === 'research';
  const isRefactor = changeKind === 'refactor';
  const isWaterfall = lifecycle === 'waterfall';

  const stageSpecs = {
    discover: {
      inputs: ['project_root', 'source_policy'],
      outputs: ['sot_inventory'],
      entry_criteria: ['Target repository readable'],
      exit_criteria: ['SOT priority and baseline identified'],
      owner: 'explorer',
      allowed_tools: ['read', 'search', 'git_status'],
      verification: 'SOT sources recorded without silent override',
      skipped_reason: null,
    },
    interview: {
      inputs: ['request', 'sot_inventory'],
      outputs: ['requirements.md', 'decisions.md', 'open_questions.md', 'acceptance.md', 'execution-contract.json'],
      entry_criteria: ['Discovery completed'],
      exit_criteria: ['All BLOCKER uncertainties resolved', 'Contract approved'],
      owner: 'lead',
      allowed_tools: ['read', 'ask_user'],
      verification: 'Zero unresolved BLOCKER items',
      skipped_reason: null,
    },
    requirements: {
      inputs: ['requirements.md', 'execution-contract.json'],
      outputs: ['requirements.md'],
      entry_criteria: ['Interview completed'],
      exit_criteria: ['REQ-IDs mapped to measurable acceptance criteria'],
      owner: 'planner',
      allowed_tools: ['read', 'write_docs'],
      verification: 'REQ-ID to AC-ID traceability complete',
      skipped_reason: specification === 'existing' ? 'existing specification retained as baseline' : null,
    },
    architecture: {
      inputs: ['requirements.md'],
      outputs: ['architecture_notes'],
      entry_criteria: ['Requirements baselined'],
      exit_criteria: ['Component boundaries and protected scope defined'],
      owner: 'lead',
      allowed_tools: ['read', 'write_docs'],
      verification: 'Architecture aligns with SOT and scope',
      skipped_reason: specification === 'lightweight' && !isWaterfall ? 'lightweight specification compresses standalone architecture stage' : null,
    },
    detailed_design: {
      inputs: ['architecture_notes', 'requirements.md'],
      outputs: ['detailed_design'],
      entry_criteria: ['Architecture approved or baselined'],
      exit_criteria: ['Module interfaces and edge cases specified'],
      owner: 'planner',
      allowed_tools: ['read', 'write_docs'],
      verification: 'No unresolved design ambiguity',
      skipped_reason: specification !== 'sdd' && !isWaterfall ? 'skipped under non-SDD non-waterfall specification' : null,
    },
    tasks: {
      inputs: ['execution-contract.json'],
      outputs: ['task_dag'],
      entry_criteria: ['Design or requirements ready'],
      exit_criteria: ['Tasks mapped to AC IDs and non-overlapping file scopes'],
      owner: 'planner',
      allowed_tools: ['read', 'write_docs'],
      verification: 'Every AC covered by at least one task',
      skipped_reason: null,
    },
    implementation: {
      inputs: ['task_dag', 'execution-contract.json'],
      outputs: ['code_changes', 'test_changes'],
      entry_criteria: ['Contract approved', 'Single-writer lock acquired'],
      exit_criteria: [resolveImplementationExitRule(engineering, changeKind)],
      owner: 'builder',
      allowed_tools: ['read', 'write_scoped', 'test'],
      verification: resolveEngineeringVerificationStrategy(engineering, changeKind),
      skipped_reason: null,
    },
    integration: {
      inputs: ['code_changes'],
      outputs: ['integrated_tree'],
      entry_criteria: ['Implementation tasks finished'],
      exit_criteria: ['Combined changes pass integration boundary'],
      owner: 'builder',
      allowed_tools: ['read', 'test'],
      verification: 'Integrated build and interface checks pass',
      skipped_reason: !isWaterfall && specification === 'lightweight' ? 'single-increment integration folded into technical_verification' : null,
    },
    technical_verification: {
      inputs: ['target_snapshot_digest', 'policy_base_ref'],
      outputs: ['evidence/verification-stamp.json', 'evidence-manifest.json'],
      entry_criteria: ['Worker completed', 'Snapshot frozen'],
      exit_criteria: ['Protected policy checks, scope guard, and required E2E/AC checks pass'],
      owner: 'verifier',
      allowed_tools: ['read', 'exec_deterministic'],
      verification: isDocsOrResearch
        ? 'Document links, schema, and source checks pass without forced RED test'
        : isRefactor
          ? 'Baseline GREEN and preservation checks pass'
          : 'Deterministic execution + E2E smoke + protected policy checks pass',
      skipped_reason: null,
    },
    review_package: {
      inputs: ['evidence-manifest.json', 'evidence/verification-stamp.json'],
      outputs: ['reports/review-package.md', 'reports/editorial-report.json'],
      entry_criteria: ['Technical verification stamped and not STALE'],
      exit_criteria: ['8-section Markdown generated', 'AC/link parity valid', 'Kouetsu editorial check executed'],
      owner: 'reviewer',
      allowed_tools: ['read', 'write_reports', 'kouetsu'],
      verification: 'READY_FOR_HUMAN_REVIEW reached without generating human approval record',
      skipped_reason: null,
    },
    human_acceptance: {
      inputs: ['reports/review-package.md', 'evidence-manifest.json'],
      outputs: ['approvals/decision.json'],
      entry_criteria: ['State is READY_FOR_HUMAN_REVIEW'],
      exit_criteria: ['Explicit human decision recorded'],
      owner: 'human',
      allowed_tools: ['human_decision_cli'],
      verification: 'Human actor recorded explicit accept / changes-requested / reject',
      skipped_reason: null,
    },
    handoff: {
      inputs: ['approvals/decision.json'],
      outputs: ['handoff_summary'],
      entry_criteria: ['State is ACCEPTED'],
      exit_criteria: ['Final digests verified valid'],
      owner: 'lead',
      allowed_tools: ['read'],
      verification: 'Approval digests match final snapshot and report',
      skipped_reason: execution === 'stage' ? 'stage execution stops before automatic handoff unless requested' : null,
    },
  };

  const stages = STANDARD_STAGES.map((stage) => {
    const spec = stageSpecs[stage];
    let approvalRequirement = 'none';
    if (stage === 'interview') approvalRequirement = 'contract_approval';
    if (stage === 'human_acceptance') approvalRequirement = 'human_final_acceptance';
    if (isWaterfall && WATERFALL_GATED_STAGES.includes(stage)) {
      approvalRequirement = stage === 'human_acceptance' ? 'human_final_acceptance' : 'human_stage_gate';
    }
    return {
      stage,
      included: spec.skipped_reason === null,
      skipped_reason: spec.skipped_reason,
      inputs: spec.inputs,
      outputs: spec.outputs,
      entry_criteria: spec.entry_criteria,
      exit_criteria: spec.exit_criteria,
      approval_requirement: approvalRequirement,
      owner: spec.owner,
      allowed_tools: spec.allowed_tools,
      verification: spec.verification,
      waterfall_gate: isWaterfall && WATERFALL_GATED_STAGES.includes(stage),
    };
  });

  return {
    methodology: { lifecycle, specification, engineering, execution },
    change_kind: changeKind,
    requires_red_first: !isDocsOrResearch && !isRefactor && engineering === 'tdd',
    requires_baseline_green: isRefactor || engineering === 'characterization_first',
    requires_e2e_smoke: changeKind === 'feature' || changeKind === 'bugfix',
    stages,
  };
}

function resolveImplementationExitRule(engineering, changeKind) {
  if (changeKind === 'docs' || changeKind === 'research') {
    return 'Documentation sources, references, and format checks ready';
  }
  if (changeKind === 'refactor' || engineering === 'characterization_first') {
    return 'Baseline GREEN characterization preserved after refactor';
  }
  if (engineering === 'tdd') {
    return 'New behavior demonstrated RED before fix and GREEN after implementation';
  }
  return 'Implementation and post-implementation tests completed';
}

function resolveEngineeringVerificationStrategy(engineering, changeKind) {
  if (changeKind === 'docs' || changeKind === 'research') {
    return 'docs_source_and_link_checks';
  }
  if (changeKind === 'refactor' || engineering === 'characterization_first') {
    return 'baseline_green_preservation';
  }
  if (engineering === 'tdd') {
    return 'red_green_refactor';
  }
  return 'test_after';
}
