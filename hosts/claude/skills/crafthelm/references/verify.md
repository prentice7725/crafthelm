---
name: crafthelm-verify
description: Run deterministic verification on the frozen snapshot using protected base-ref policies, E2E/property/differential checks, and diff-triggered reliability rules.
---

# CraftHelm Verify Skill

1. Load verification rules and `REVIEW.md` from `policy_base_ref` or protected external policy paths, never from candidate edits.
2. Compute `target_snapshot_digest` excluding `.crafthelm/runs/`.
3. Execute contract AC checks (`fast`, `unit`, `e2e`, `property`, `differential`, `manual`) and diff-triggered reliability rules (`observe`/`enforce`).
4. Block technical pass when functional changes fail or lack E2E smoke coverage.
5. Emit `evidence/verification-stamp.json` and `evidence-manifest.json` with script-computed SHA-256 hashes.
