# NOTICE — Ponytail Rules (vendored)

- Upstream Repository: https://github.com/DietrichGebert/ponytail
- Upstream Version: v5.3.3 (commit `ebd8654c2c627f721eb8f9c0d1bd4090a29f9e10`)
- License: MIT (`Copyright (c) 2026 DietrichGebert`, see `LICENSE`)

## What is vendored

Only `AGENTS.md`, the upstream's compact always-on ruleset, copied byte for byte. The plugin's hooks (`SessionStart`, `SubagentStart`, `UserPromptSubmit`), the status-line band, the board, and the `/ponytail-*` commands are deliberately not adopted: they would inject instructions into every session and every subagent, outside the execution contract and the delegation record.

## How CraftHelm uses it

The implementation stage (`skills/implement/SKILL.md`) applies these rules to how much code a change writes. They never lower a CraftHelm gate. Where they differ, the contract wins:

- Ponytail's "one small test" is a floor. The contract's acceptance checks (unit, e2e, mutation probe) are what verification requires.
- Ponytail's scope ("every place your change must reach") stays inside `scope.allow`. Reaching outside it is an escalation, not a fix.
- Ponytail's closing "what was skipped or not checked" goes into the Lead Context Contract packet, not only the chat reply.

`registry.json` pins `files_digest` to the SHA-256 of `AGENTS.md` (LF-normalized). `tests/unit/external-skills.test.mjs` fails if the vendored file drifts.
