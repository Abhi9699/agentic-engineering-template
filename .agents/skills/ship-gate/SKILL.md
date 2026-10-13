---
name: ship-gate
description: Run before claiming any change is done. Runs the full local gate ladder, exercises the real user flow, enforces prompt evals and money path verification, and records the Pre-Handoff Verification Receipt.
---

# Ship gate

Run before claiming any change is done. Stop at the first failure and fix it; three
attempts at one failure, then stop and report with the output verbatim.

1. `npm run gate` (or `npm run gate:quick` while iterating)
   Runs the full local sequence: every static check in `STATIC_CHECKS` (`scripts/gate.mjs`,
   the single list; `check:rules` through `plan:lint` and `db:check`), plus lint, tsc,
   scoped vitest, and build (`gate:quick` skips lint and build).
   Listing an ad-hoc subset is not the gate.
2. **Never read a gate result through a pipe.** `npm run gate | tail` reports the exit
   status of `tail`, not the gate. Redirect to a file and echo `$?`.
3. Exercise the real user flow and capture evidence — a screenshot, an exported file, a
   log line, or a database row. Types and unit tests do not prove a user-visible change.
   For UI changes: exercise the user flow and verify relevant screens and interactive boundaries.
4. If the change touches an AI prompt or model gateway: bump the SemVer and
   run prompt evaluations (`npm run eval:prompts`). A live run needs explicit ceilings
   and prints its worst-case cost before spending.
5. If the change touches credits, tiers, billing, checkout, webhooks, 402 or reserve/refund:
   verify transaction idempotency and fail-closed error envelope paths.
6. If the change touches visual artifact rendering: export and inspect artifacts
   across supported themes/palettes.
7. Update the affected `docs/` file and `vault/` note, and append one line to
   `vault/_CHANGELOG.md`. Then `node scripts/check-vault.mjs`.
8. Regenerate any stale generated docs on a clean tree before committing —
   `docs:check` tells you which.
9. If anything in this run surfaced a defect — yours or the repository's — add it to
   `vault/_Lessons.md` with a gate that prevents it, and prove the gate bites by planting
   the failure once. A lesson with no gate is recorded as `status: OPEN`, never as closed.
10. **Pre-Handoff Verification Receipt.** Every pull request or task completion must cite (`npm run evidence:check`):
    - Gate ladder command executed: `npm run gate:quick` or `npm run gate` (must exit 0).
    - Targeted test command and pass count (e.g. `npx vitest run ...` with X passed, 0 failed).
    - Real flow exercise evidence: screenshot path, terminal curl/status, or log output.
    - Zero console error confirmation: observed 0 console errors, 0 hydration warnings, 0 uncaught exceptions.
