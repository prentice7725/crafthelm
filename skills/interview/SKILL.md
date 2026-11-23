---
name: crafthelm-interview
description: Conduct Source-First intake and uncertainty triage (BLOCKER, ASSUMABLE, DEFERRED) before generating an execution contract.
---

# CraftHelm Interview Skill

1. Read project SOT (`README.md`, `docs/`, `package.json`, git log) before asking questions.
2. Classify uncertainties into `BLOCKER`, `ASSUMABLE`, and `DEFERRED`.
3. Never guess or silently resolve `BLOCKER` items; return `INTERVIEW_REQUIRED` if unresolved.
4. Emit `requirements.md`, `decisions.md`, `open_questions.md`, `acceptance.md`, and `.crafthelm/contracts/<task-id>.json`.
