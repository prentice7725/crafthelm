---
name: crafthelm
description: Single-provider, host-agnostic, interview-first, methodology-composable, evidence-driven development operating framework. Supports Claude Code, Codex, Antigravity (agy/IDE), and generic/custom AI hosts without cross-provider brokers.
---

# CraftHelm Routing Skill

> **The Lead Steers. Workers Build. Evidence Decides.**

## Invariants

1. **Single Provider:** Use only the active host (`claude`, `codex`, `antigravity`, `generic`, or configured custom CLI). Never invoke a second provider CLI.
2. **SOT First:** Read the target repository's authoritative sources before asking questions or editing files.
3. **Interview Before Execution:** Unresolved `BLOCKER` items stop execution (`INTERVIEW_REQUIRED`).
4. **Protected Verification Policy:** Load review/verification rules from `policy_base_ref` or protected paths, never from candidate branch edits.
5. **No Silent Bypass:** Missing tools, skipped checks, or unavailable cross-model verification must be reported as `UNAVAILABLE` / `UNVERIFIED` / `BLOCKED`.
6. **Human Owns Done:** Automation ends at `READY_FOR_HUMAN_REVIEW`. Only explicit human approval transitions to `ACCEPTED`. Never use a `COMPLETE` state.

## Command Mapping

- `crafthelm doctor --host auto|claude|codex|antigravity|generic` — probe active host capabilities and Kouetsu availability
- `crafthelm init-host --repo <path> --host antigravity|gemini|claude|codex|generic|all` — install host integration skills and config into a target repo
- `crafthelm install-skills --targets claude,codex,gemini|all [--scope user|project] [--dry-run] [--status] [--uninstall] [--with-kouetsu]` — register or inspect host-isolated CraftHelm skills across Claude Code, Codex, and Gemini/Antigravity
- `crafthelm interview` — run SOT intake, classify `BLOCKER`/`ASSUMABLE`/`DEFERRED`, emit requirements and contract
- `crafthelm contract validate|plan|approve` — validate schema, inspect 4-axis methodology plan, record contract approval
- `crafthelm checkpoint init|stage|approve-stage|record-repair|resume|handoff|replan|status|audit` — manage state, single-writer lock, structured handoff packets (`tried_and_failed`), 3-round repair limit, and stale detection
- `crafthelm impact --repo <path> [--analyzer-cmd <cmd>] [--test-command-template <tpl>]` — run polyglot AST + call-graph diff impact analysis and runner-aware selective test recommendation
- `crafthelm route --task-type <type> --host <host> [--lightweight-model <m>] [--impact-file <path>]` — route tasks to `deterministic` / `lightweight` / `standard` / `reasoning` model tiers
- `crafthelm memory index|search|decide|list` — manage Markdown SOT decisions (`supersedes`) and zero-LLM `node:sqlite` FTS5 search with episodic decay
- `crafthelm verify [--selective]` — execute AC checks (with safe selective regression + fallback), E2E/property/differential tests, reliability rules, and stamp `target_snapshot_digest`
- `crafthelm feedback [--selective]` — run bounded verification -> feedback -> repair -> `READY_FOR_HUMAN_REVIEW` loop
- `crafthelm review-package` — compose Markdown review package, validate links/AC parity, run Kouetsu editorial check
- `crafthelm approve record|verify` — record or re-verify explicit human acceptance/changes-requested/rejection
- `crafthelm skills list|audit|lock|verify-lock` — inspect registry, audit third-party skills, pin SHA-256 locks
- `crafthelm benchmark` — run deterministic/live A vs B vs C benchmark comparison

## Skill Modules

- [interview](skills/interview/SKILL.md)
- [plan](skills/plan/SKILL.md)
- [implement](skills/implement/SKILL.md)
- [verify](skills/verify/SKILL.md)
- [review-publish](skills/review-publish/SKILL.md)
- [learn](skills/learn/SKILL.md)
