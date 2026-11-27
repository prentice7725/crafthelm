---
name: crafthelm
description: >-
  Single-provider, interview-first, methodology-composable, evidence-driven development operating
  framework. Use when driving a coding task through Source-First interview, execution contract,
  AST/call-graph impact analysis, selective regression verification, and READY_FOR_HUMAN_REVIEW.
---

# CraftHelm Claude Code Skill

> **The Lead Steers. Workers Build. Evidence Decides.**

- **Isolation:** Claude-only single-provider workflow (`--host claude`). Never invoke another provider CLI.
- **Delegation:** Use Claude native subagents or scoped session turns strictly inside `scope.allow`, routing classification to `lightweight` and architecture/escalation to `reasoning`.

## Workflow Gate Sequence

1. **Doctor & Bootstrap:** Run `node scripts/crafthelm.mjs doctor --host claude --json` and `node scripts/crafthelm.mjs init-host --repo . --host claude` if `.crafthelm/config.json` is missing.
2. **Source-First Interview:** Read target SOT files first, then run `node scripts/crafthelm.mjs interview --repo . --task-id <ID> --request "<task>" --host claude`. Never guess unresolved `BLOCKER`s.
3. **Skills Lock, Contract Approval & Checkpoint:** Lock skills with `node scripts/crafthelm.mjs skills lock --repo . --host claude`. Approving the contract is the user's decision, not yours: show them the scope and the acceptance checks in `.crafthelm/contracts/<ID>.json` and wait for an explicit go-ahead in the conversation. Then run `node scripts/crafthelm.mjs contract approve .crafthelm/contracts/<ID>.json --actor <name the user gave> --init-run --repo . --run-id <RUN>`. `--init-run` also freezes the run baseline; without it, run `node scripts/crafthelm.mjs checkpoint init --repo . --contract .crafthelm/contracts/<ID>.json --run-id <RUN>`. If code for this task was already committed before the run was opened, add `--baseline-ref <commit before that work>` so it is verified too. An approval made from an agent session is recorded as such.
4. **Cost-Aware Routing & Scoped Implementation:** Acquire the single-writer lock (`node scripts/crafthelm.mjs checkpoint acquire-lock --repo . --run-id <RUN> --writer <id>`), pick tier with `node scripts/crafthelm.mjs route --task-type <type> --host claude --repo . --json`, edit strictly inside `scope.allow`, and release the lock (`node scripts/crafthelm.mjs checkpoint release-lock --repo . --run-id <RUN> --writer <id>`).
5. **Impact Analysis & Bounded Regression Loop:** Run `node scripts/crafthelm.mjs impact --repo . --json` and `node scripts/crafthelm.mjs verify --repo . --run-id <RUN> --selective` (or `node scripts/crafthelm.mjs feedback --repo . --run-id <RUN> --selective`). Respect the 3-round repair limit (`BLOCKED_HUMAN_ATTENTION`).
6. **Review Package & Human Handoff:** Run `node scripts/crafthelm.mjs review-package --repo . --run-id <RUN>` and stop strictly at `READY_FOR_HUMAN_REVIEW`. Only explicit human input runs `approve record`.

At any point, `node scripts/crafthelm.mjs status --repo . --explain` shows the open run, why its last verify failed, and the next command. `node scripts/crafthelm.mjs help <command>` prints a command's arguments. A command that prints "timed out" did not finish (exit code 124): raise `CRAFTHELM_CLI_TIMEOUT_MS` and run it again rather than moving on.

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
- Never approve a contract on your own judgment, and never record a person as its approver unless that person approved it in the conversation.
- Never fabricate token counts or dollar costs; report `"unknown"` when unmeasured.
