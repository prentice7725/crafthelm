# AGENTS.md — CraftHelm Repository Rules

1. **Independence:** Keep CraftHelm completely independent from `hyperfusion`. Never read or modify `hyperfusion` runtime state or files as a dependency.
2. **Single-Provider Isolation:** Claude adapter code must never invoke `codex`; Codex adapter code must never invoke `claude`.
3. **Zero External Runtime Dependencies:** Use Node.js `>=24` built-in modules only.
4. **Line Endings & Encoding:** Always write UTF-8 with LF (`\n`).
5. **Accountability Guardrails:**
   - Never introduce a `COMPLETE` state.
   - Never fabricate measured token counts or dollar costs; report `"unknown"` when unmeasured.
   - Never generate human approval records (`approvals/decision.json`) automatically without explicit user input.
6. **Tests Before Merge:** Run `npm test` after every change and verify 0 failures and 0 skipped tests.
