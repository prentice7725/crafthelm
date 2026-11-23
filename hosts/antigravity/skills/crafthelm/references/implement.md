---
name: crafthelm-implement
description: Execute scoped implementation under single-writer lock, Red-First or baseline GREEN preservation, and 3-round repair limit.
---

# CraftHelm Implement Skill

1. Acquire single-writer lock before modifying repository files.
2. Stay strictly inside `scope.allow` and never modify `scope.protect` or verification baselines.
3. Follow TDD (RED -> GREEN -> REFACTOR) for new behaviors or `characterization_first` baseline GREEN for refactoring.
4. Stop and escalate (`BLOCKED_HUMAN_ATTENTION`) after 3 failed repair rounds for the same cause.
