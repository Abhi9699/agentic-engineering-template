---
paths:
  - "src/services/**"
  - "src/api/**"
  - "src/db/**"
  - "src/server/**"
antigravity: rule-backend-security.md
---
# Backend and zero-trust security — services, data access, API boundaries

Authority: AGENTS.md §4 rules (Zero-trust, Types, Data Access).

| Don't | Do instead | Enforced |
|---|---|---|
| Compare secrets or hashes with `===` | Use `crypto.timingSafeEqual()` for tokens and signatures | `secret-compare` · tsc |
| Use untrusted input without schema validation | Validate every external request, response, and environment variable with Zod | `zod-boundary` |
| Query data without tenant/ownership filtering | Every query on a user-owned resource must explicitly bind the owner ID | `ownership-filter` |
| Run unbounded database list queries | Apply explicit `limit` clauses and pagination to all list queries | `bounded-query` |
| Return ad-hoc unformatted error objects | Return standard typed API error envelopes | `api-error-envelope` |
| Expose secrets or credentials in client bundles | Keep credentials server-side only; never prefix sensitive keys with client-exposed prefixes | `guard-secrets.mjs` |
