---
name: crafthelm-review-publish
description: Generate the 8-section Human Review Package, verify AC/link parity, execute Kouetsu editorial review, and transition only to READY_FOR_HUMAN_REVIEW.
---

# CraftHelm Review Publish Skill

1. Confirm `target_snapshot_digest` matches the latest `VerificationStamp` (block if `STALE`).
2. Render the 8-section Markdown report (`reports/review-package.md`) with `PENDING` human decision.
3. Verify all relative links exist and AC statuses match `evidence-manifest.json`.
4. The Kouetsu editorial check (`Content -> Clarity -> Surface`) runs when its copy is at hand and is recorded in `reports/editorial-report.json`. It blocks the package only when the contract sets `editorial.require_kouetsu`.
5. Never create `approvals/decision.json` or transition to `ACCEPTED`.
