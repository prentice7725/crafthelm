---
name: crafthelm-plan
description: Compose the 4-axis methodology plan and Task DAG with file scopes, protected paths, and acceptance criteria.
---

# CraftHelm Plan Skill

1. Validate `execution-contract.json` against `contracts/schemas/execution.schema.json`.
2. Compose stage plan using `lifecycle`, `specification`, `engineering`, and `execution` axes.
3. Explicitly map `scope.allow` and `scope.protect` paths and freeze `policy_base_ref`.
4. Ensure Waterfall approval gates are attached when `lifecycle === "waterfall"`.
