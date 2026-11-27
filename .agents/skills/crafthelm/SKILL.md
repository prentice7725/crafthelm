---
name: crafthelm
description: Execute CraftHelm's single-provider, interview-first, evidence-driven workflow natively inside Antigravity or any generic AI host session using deterministic CLI gates and subagent delegation.
---

# CraftHelm Universal & Antigravity Routing Skill

> **The Lead Steers. Workers Build. Evidence Decides.**

Use this skill when driving a development task through CraftHelm from an Antigravity session (`agy` CLI or IDE chat with `run_command` + `invoke_subagent`) or any generic host.

## Workflow Loop

1. **Doctor & Lock:** Run `node scripts/crafthelm.mjs doctor --host antigravity --json` (or `--host generic`) to confirm host capabilities and Kouetsu editorial integrity.
2. **Source-First Interview:** Read target SOT (`README.md`, `docs/`, `package.json`, git log), then run `node scripts/crafthelm.mjs interview` (never guess unresolved `BLOCKER`s).
3. **Contract & Checkpoint:** Pin skills (`node scripts/crafthelm.mjs skills lock --repo . --host antigravity`). Approving the contract is the user's decision, not yours: show them the scope and acceptance checks in `.crafthelm/contracts/<ID>.json` and wait for an explicit go-ahead in the conversation. Then run `node scripts/crafthelm.mjs contract approve .crafthelm/contracts/<ID>.json --actor <name the user gave> --init-run --repo . --run-id <RUN>` (`--init-run` also freezes the run baseline; without it run `node scripts/crafthelm.mjs checkpoint init --repo . --contract .crafthelm/contracts/<ID>.json --run-id <RUN>`). An approval made from an agent session is recorded as such.
4. **Scoped Implementation & Cost Routing:** Acquire single-writer lock (`node scripts/crafthelm.mjs checkpoint acquire-lock --repo . --run-id <RUN> --writer <id>`), route classification/exploration tasks to `lightweight` (`route --task-type classify`) and architecture/escalated repairs to `reasoning`, and delegate scoped edits to `invoke_subagent` (or `agy` worker) within `scope.allow`. Release writer lock when done.
5. **Impact Analysis & Selective Regression Loop:** Run `node scripts/crafthelm.mjs impact` (supports built-in JS/TS/Python/Go/Rust/Java/Kotlin/C#/C/C++/Ruby/PHP analysis plus `--analyzer-cmd`) and `node scripts/crafthelm.mjs verify --selective` (or `node scripts/crafthelm.mjs feedback --selective`) to run impacted tests plus protected E2E checks across any test runner, automatically falling back to full suite on global or unparsed changes and feeding structured failures (`evidence/feedback-packet.json`) back within the 3-round cap.
6. **Review Package & Kouetsu Gate:** Run `node scripts/crafthelm.mjs review-package` (triggered automatically on pass in `feedback`) to generate `reports/review-package.md`, verify links/AC parity, and execute Kouetsu editorial review.
7. **Human Acceptance Gate:** Stop at `READY_FOR_HUMAN_REVIEW`. Present the review package and let the human explicitly run `node scripts/crafthelm.mjs approve record ...` (`accept`, `changes-requested`, `reject`, or `request-verification`).

## Invariants

- Never introduce a `COMPLETE` state.
- Never generate `approvals/decision.json` without explicit human decision input.
- Never claim unmeasured token counts or dollar costs; report `"unknown"` when unmeasured.
