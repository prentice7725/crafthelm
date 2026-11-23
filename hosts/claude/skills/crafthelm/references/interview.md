---
name: crafthelm-interview
description: Conduct Source-First intake and uncertainty triage (BLOCKER, ASSUMABLE, DEFERRED) before generating an execution contract.
---

# CraftHelm Interview Skill

1. Read project SOT (`README.md`, `docs/`, `package.json`, git log) before asking questions.
2. Classify uncertainties into `BLOCKER`, `ASSUMABLE`, and `DEFERRED`.
3. Never guess or silently resolve `BLOCKER` items; return `INTERVIEW_REQUIRED` if unresolved.
4. Read `generated_questions` and `uncertainty_coverage` in the interview result. Ask the user each open `BLOCKER` question, then re-run with the answers in `--input` (`uncertainties[].answer`, `reproduction`, `acceptance`, `scope.allow`). For a category that truly does not apply, set `uncertainty_coverage.<category>.basis` to the source that shows it; never write a basis you did not check.
5. Emit `requirements.md`, `decisions.md`, `open_questions.md`, `acceptance.md`, `interview_questions.md`, and `.crafthelm/contracts/<task-id>.json`.
