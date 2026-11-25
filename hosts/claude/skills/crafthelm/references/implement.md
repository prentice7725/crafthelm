---
name: crafthelm-implement
description: Execute scoped implementation under single-writer lock, Red-First or baseline GREEN preservation, and 3-round repair limit.
---

# CraftHelm Implement Skill

1. Acquire single-writer lock before modifying repository files.
2. Stay strictly inside `scope.allow` and never modify `scope.protect` or verification baselines.
3. Follow TDD (RED -> GREEN -> REFACTOR) for new behaviors or `characterization_first` baseline GREEN for refactoring.
   - Write the smallest complete change (vendored Ponytail rules, `external-skills/ponytail/AGENTS.md`). Before writing, read the code the change touches and list every caller, test, fixture and export it must reach. Then take the first option that fully works: not needed at all, already in this codebase, standard library or platform feature, an installed dependency, one readable line, and only then the minimum new code.
   - Add no abstraction, option, config or "for later" code nobody asked for, and no dependency for a few lines. Never cut validation at trust boundaries, error handling that prevents data loss, security or accessibility.
   - A deliberate shortcut with a known limit gets a one-line `shortcut: <the limit>, <when to upgrade>` comment.
   - These rules size the code, not the evidence: the contract's acceptance checks are required even where Ponytail would settle for one small test, and anything the change must reach outside `scope.allow` is an escalation.
   - Report what was skipped or not checked in the Lead Context Contract packet: an `acceptance[]` entry with status `not_run` and a `note`, and any risk the Lead must decide in `decision_needed`.
4. When work is delegated, leave a record: on a CLI host run the worker with `crafthelm delegate run --execute`; with in-session subagents have the worker return only the Lead Context Contract packet and file it with `crafthelm delegate record`. Do not describe work as delegated if no record exists.
5. Stop and escalate (`BLOCKED_HUMAN_ATTENTION`) after 3 failed repair rounds for the same cause.
