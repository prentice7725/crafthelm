# GEMINI.md — Antigravity & Universal CraftHelm Workspace Instructions

Follow all rules in [AGENTS.md](AGENTS.md).

## Running CraftHelm from Antigravity or Any Host Session

CraftHelm operates natively inside Antigravity (`agy` CLI or in-session `run_command` + `invoke_subagent`) as well as any single-provider AI host (`claude`, `codex`, `generic`, or custom CLI).

- Probe environment: `node scripts/doctor.mjs --host antigravity --json` (or `--host generic --json`)
- Bootstrap a target repo: `node scripts/crafthelm.mjs init-host --repo <target> --host antigravity`
- Execute full test suite: `npm test`

## Accountability & Single-Provider Rules

- Keep every host isolated: never invoke a different provider CLI from inside an adapter.
- Use `invoke_subagent` (or `agy` workers) for exploration/implementation/independent reading when appropriate, and ALWAYS run `scripts/verify.mjs` and `scripts/review-package.mjs` deterministically before presenting `READY_FOR_HUMAN_REVIEW`.
- Never fabricate human approval (`approvals/decision.json`) or use a `COMPLETE` state.
