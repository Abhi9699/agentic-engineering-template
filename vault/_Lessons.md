---
type: meta
status: active
tags: [meta, agents, quality]
related: [_START-HERE, Conventions, Open-Questions]
last-updated: 2026-10-12
last-verified: 2026-10-12
source: [scripts/guard-secrets.mjs]
confidence: Confirmed
---

# Lessons Ledger

Every defect that reached a plan, a PR, or production, and the **machine gate** that now prevents its recurrence.
Hub index: [[_START-HERE]].

A lesson is not learned when it is written down. It is learned when a machine refuses to let it happen again. Prose is advisory; a failing test is binding.

---

## L-001 — Secrets or credential files staged in git

- **class:** process (security-boundary)
- **defect:** Sensitive credentials or environment files (`.env*`, `service_account.json`) staged for commit.
- **gate:** `node scripts/guard-secrets.mjs` wired into `.githooks/pre-commit`.
- **bites:** yes — rejected staged `.env.local` with non-zero exit code.
- **proof:** `scripts/guard-secrets.mjs` :: `return SECRET.test(n) && !SECRET_ALLOWED.test(n);` -> `return false;` :: `scripts/__tests__/lesson-proofs.test.ts`
