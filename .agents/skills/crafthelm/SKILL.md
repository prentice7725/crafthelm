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
4. **Scoped Implementation:** Acquire single-writer lock (`node scripts/crafthelm.mjs checkpoint acquire-lock --repo . --run-id <RUN> --writer <id>`) and edit within `scope.allow`. Keep the lock through the verify-and-repair loop and pass the same `--writer <id>` to every `verify`, `feedback` and `checkpoint` command while you hold it; without it they stop with `CONCURRENT_WRITER_BLOCKED`. Release it before the review package. Do not edit files while `verify` is running.
5. **Verify & Bounded Repair Loop:** Run `node scripts/crafthelm.mjs verify` (or `node scripts/crafthelm.mjs feedback`, which also publishes the review package), feeding structured failures (`evidence/feedback-packet.json`) back within the 3-round cap. A check stopped at its time limit is reported as `AC_TIMEOUT`, not as a failed test: the limit is `timeout_ms` on the acceptance item (default 10 minutes), set with `contract add-e2e --timeout-ms`.
6. **Review Package & Human Handoff:** Run `node scripts/crafthelm.mjs review-package` (triggered automatically on pass in `feedback`) to generate `reports/review-package.md` and verify links/AC parity.
7. **Human Acceptance Gate:** Stop at `READY_FOR_HUMAN_REVIEW`. Present the review package and let the human explicitly run `node scripts/crafthelm.mjs approve record ...` (`accept`, `changes-requested`, `reject`, or `request-verification`).

Optional, only when the task or contract calls for it: `route`/`delegate`, `impact` with `verify --selective`, the mutation probe, Waterfall stage approvals, the Kouetsu gate (`editorial.require_kouetsu`).

## Invariants

- Never introduce a `COMPLETE` state.
- Never generate `approvals/decision.json` without explicit human decision input.
- Never claim unmeasured token counts or dollar costs; report `"unknown"` when unmeasured.
