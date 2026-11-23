# CLAUDE.md — CraftHelm Project Instructions

Follow all rules in [AGENTS.md](AGENTS.md).

## Quick Verification

- `npm test` — runs schema, unit, security, and e2e vertical-slice tests.
- `node scripts/doctor.mjs --host claude --json` — verifies local Claude Code CLI and Kouetsu plugin detection without invoking Codex.

## Non-Negotiable Contracts

- Keep `contracts/schemas/*.schema.json` synchronized with `scripts/lib/schema.mjs` validators.
- Load verification policies from `policy_base_ref` (`git show`) or designated protected directories rather than mutable candidate files.
- Ensure `.crafthelm/runs/` artifacts are excluded from code `target_snapshot_digest` calculations so verification artifacts never invalidate their own snapshot.
