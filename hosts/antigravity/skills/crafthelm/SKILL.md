---
name: crafthelm
description: >-
  Single-provider, interview-first, methodology-composable, evidence-driven development operating
  framework. Use when driving a coding task through Source-First interview, execution contract,
  AST/call-graph impact analysis, selective regression verification, and READY_FOR_HUMAN_REVIEW.
---

# CraftHelm Antigravity / Gemini Skill

> **The Lead Steers. Workers Build. Evidence Decides.**

- **Isolation:** Antigravity / Gemini single-provider workflow (`--host antigravity` or `--host generic`). Never invoke another provider CLI.
- **Delegation:** Use `invoke_subagent` (or `agy` worker) for scoped edits inside `scope.allow`, routing lightweight exploration to `flash_lite` and architecture/escalated repairs to `pro`.

## Workflow Gate Sequence

1. **Doctor & Bootstrap:** Run `node scripts/crafthelm.mjs doctor --host antigravity --json` and `node scripts/crafthelm.mjs init-host --repo . --host antigravity` if `.crafthelm/config.json` is missing.
2. **Source-First Interview:** Read target SOT files first, then run `node scripts/crafthelm.mjs interview --repo . --task-id <ID> --request "<task>" --host antigravity`. Never guess unresolved `BLOCKER`s.
3. **Contract, Skills Lock & Checkpoint:** Approve the contract (`contract approve`), lock skills (`skills lock --repo . --host antigravity`), and initialize checkpoint (`checkpoint init`).
4. **Cost-Aware Routing & Scoped Implementation:** Acquire single-writer lock (`checkpoint acquire-lock`), pick tier with `node scripts/crafthelm.mjs route --task-type <type> --host antigravity --repo . --json`, edit strictly inside `scope.allow`, and release the writer lock.
5. **Impact Analysis & Bounded Regression Loop:** Run `node scripts/crafthelm.mjs impact --repo . --json` and `node scripts/crafthelm.mjs verify --repo . --run-id <RUN> --selective` (or `node scripts/crafthelm.mjs feedback --repo . --run-id <RUN> --selective`). Respect the 3-round repair limit (`BLOCKED_HUMAN_ATTENTION`).
6. **Review Package & Human Handoff:** Run `node scripts/crafthelm.mjs review-package --repo . --run-id <RUN>` and stop strictly at `READY_FOR_HUMAN_REVIEW`. Only explicit human input runs `approve record`.

## Stage Reference Modules

- [interview](./references/interview.md)
- [plan](./references/plan.md)
- [implement](./references/implement.md)
- [verify](./references/verify.md)
- [review-publish](./references/review-publish.md)
- [learn](./references/learn.md)

## Non-Negotiable Invariants

- Never introduce a `COMPLETE` state.
- Never create `approvals/decision.json` automatically without explicit human input.
- Never fabricate token counts or dollar costs; report `"unknown"` when unmeasured.
