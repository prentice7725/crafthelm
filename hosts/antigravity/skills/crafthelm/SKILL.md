---
name: crafthelm
description: >-
  Single-provider, interview-first, methodology-composable, evidence-driven development operating
  framework. Use when driving a coding task through Source-First interview, execution contract,
  scoped implementation, verification against the contract, and READY_FOR_HUMAN_REVIEW.
---

# CraftHelm Antigravity / Gemini Skill

> **The Lead Steers. Workers Build. Evidence Decides.**

- **Isolation:** Antigravity / Gemini single-provider workflow (`--host antigravity` or `--host generic`). Never invoke another provider CLI.
- **Delegation:** Use `invoke_subagent` (or `agy` worker) for scoped edits inside `scope.allow`, routing lightweight exploration to `flash_lite` and architecture/escalated repairs to `pro`.

## Workflow Gate Sequence

1. **Doctor & Bootstrap:** Run `node scripts/crafthelm.mjs doctor --host antigravity --repo . --json` (act on its `warnings`: a setup older than this CraftHelm lacks the hooks) and `node scripts/crafthelm.mjs init-host --repo . --host antigravity` if `.crafthelm/config.json` is missing.
2. **Source-First Interview:** Read target SOT files first, then run `node scripts/crafthelm.mjs interview --repo . --task-id <ID> --request "<task>" --host antigravity`. Never guess unresolved `BLOCKER`s.
3. **Skills Lock, Contract Approval & Checkpoint:** Lock skills with `node scripts/crafthelm.mjs skills lock --repo . --host antigravity`. First try `node scripts/crafthelm.mjs contract begin .crafthelm/contracts/<ID>.json --repo . --run-id <RUN>`: it starts the run without asking only where the project set a standing rule and the scope cannot reach a strict zone, and otherwise refuses. When it refuses, approving the contract is the user's decision, not yours: show them the scope and the acceptance checks in `.crafthelm/contracts/<ID>.json` and wait for an explicit go-ahead in the conversation. Then run `node scripts/crafthelm.mjs contract approve .crafthelm/contracts/<ID>.json --actor <name the user gave> --init-run --repo . --run-id <RUN>`. `--init-run` also freezes the run baseline; without it, run `node scripts/crafthelm.mjs checkpoint init --repo . --contract .crafthelm/contracts/<ID>.json --run-id <RUN>`. If code for this task was already committed before the run was opened, add `--baseline-ref <commit before that work>` so it is verified too. An approval made from an agent session is recorded as such.
4. **Scoped Implementation:** Acquire the single-writer lock (`node scripts/crafthelm.mjs checkpoint acquire-lock --repo . --run-id <RUN> --writer <id>`) and edit strictly inside `scope.allow`. Keep the lock through the verify-and-repair loop and pass the same `--writer <id>` to every `verify`, `feedback` and `checkpoint` command while you hold it; without it they stop with `CONCURRENT_WRITER_BLOCKED`. Release it (`node scripts/crafthelm.mjs checkpoint release-lock --repo . --run-id <RUN> --writer <id>`) before the review package. Do not edit files while `verify` is running.
5. **Verify & Bounded Repair Loop:** Run `node scripts/crafthelm.mjs verify --repo . --run-id <RUN>` (or `node scripts/crafthelm.mjs feedback --repo . --run-id <RUN>`, which also publishes the review package), adding `--writer <id>` while you hold the lock. A check stopped at its time limit is reported as `AC_TIMEOUT`, not as a failed test: the limit is `timeout_ms` on the acceptance item (default 10 minutes), set with `contract add-e2e --timeout-ms`. Respect the 3-round repair limit (`BLOCKED_HUMAN_ATTENTION`).
6. **Review Package & Human Handoff:** Run `node scripts/crafthelm.mjs review-package --repo . --run-id <RUN>` and stop at `READY_FOR_HUMAN_REVIEW`. The user decides: give them `node scripts/crafthelm.mjs review --repo .` to run in their own terminal.

Optional, only when the task or contract calls for it: `route`/`delegate`, `impact` with `verify --selective`, the mutation probe, Waterfall stage approvals, the Kouetsu gate (`editorial.require_kouetsu`).

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
