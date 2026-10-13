# Portable rules digest (generated-mirror source)

This is the condensed rule set that `npm run gen:configs` copies into every tool mirror
(`GEMINI.md`, `.cursorrules`, `.github/copilot-instructions.md`, `llms.txt`,
`.agents/rules/` and `.agent/rules/`). It is a **summary of `AGENTS.md` §4 and the area rules in
`agent-system/rules/`, not a second authority**: on any conflict those win and this file is the bug.

It lives outside `AGENTS.md` so the rules are not loaded twice into every agent session.
When you change a rule in `AGENTS.md` §4 or `agent-system/rules/`, change it here too, then run
`npm run gen:configs`; CI fails if the mirrors drift.

<!-- AGENT-RULES-DIGEST START (canonical portable rules — edit HERE, then run `npm run gen:configs`; CI fails on drift) -->
**Autonomous Engineering Architecture load-bearing rules (portable digest — full detail in `AGENTS.md` §4 and `agent-system/rules/`):**

1. Server / core components by default; interactive leaf at the UI boundary. Mutations are transactional and typed. Modules target <= 400 lines; decompose when handling multiple concerns.
2. Design token discipline — no invented hex values or uncoordinated styling. Scoped modules per component. Animate transform/opacity only; honor prefers-reduced-motion. Zero layout reads in render loops.
3. Strict data access — explicit queries, tenant/ownership isolation on all tables, migrations generated deterministically. Every list query bounded with pagination.
4. Strict TypeScript, no `any`; schema (Zod) validation at every external boundary (IO, network, LLM output). Deterministic SSR: never branch on `typeof window` in render. Never weaken a check to get to green: no `@ts-ignore`, no undescribed suppressions, never delete or loosen a test assertion.
4b. Zero-trust security (OWASP): Every exported backend mutation verifies caller authentication AND resource ownership. Timing-safe equality for tokens and signatures (`crypto.timingSafeEqual()`). Test both authorized AND rejected paths.
4c. WCAG 2.2 AA accessibility: 100% programmatic labeling (`<label htmlFor>` or `aria-label`); zero bare `outline: none` (mandatory visible `:focus-visible`); toggle controls broadcast state via `aria-pressed`/`aria-selected`; never block user paste.
4d. Performance & Memory Hygiene: Zero async waterfalls (parallelize independent I/O via `Promise.all()`); image aspect ratios specified (0 CLS); effects with listeners/timers must return cleanups; in-flight requests abortable via `AbortController`.
5. AI pipelines — prompts live only in versioned prompt registries; untrusted text escaped and delimited; model gateway handles safety and fallbacks; AI outputs validated via schemas.
6. Fail-closed error handling — standardized typed error envelopes; paywall/quota status 402; money and AI changes ship with comprehensive test suites.
7. Secrets (`.env*`, credentials) are strictly local-only and never read, written, or committed.
8. One concern per PR — no unrelated refactors bundled into a fix. Architecture decisions are binding. When an ambiguity would change what you build, ask the owner; decide conventional defaults yourself. Update living `vault/` notes when work changes reality.

9. **Executive Advisory Mandate.** You are expected to CHALLENGE a request that is
wrong, not to implement it fluently. Before non-trivial work run
`npm run exec:review "<request>"`: touched paths set the risk tier and the wording can
only raise it. R0-R1 fast-track; R2 standard (state the one assumption that would change
the build; decisions, lessons and reviewer lenses print); R3+ strategic (the cited
assessment plus a four-question pre-mortem, checked with `--check --pre-mortem`). **Every claim in an assessment cites or it does not count** — a market or
platform claim needs a URL and a year, a blast-radius claim needs `file:line`, and
`exec:review --check` exits non-zero otherwise. The brief also names the **review roles**
(`agent-system/executive-roles.json`): CPO and CTO always (the CTO compares two options and
states reversibility); CFO, CISO, Legal, DevOps, AIQuality and Data when their paths or words
are touched. Any UNKNOWN forces the `BLOCKED — NEEDS VERIFICATION` verdict. `exec:review --review` gives the reviewer each triggered role's checklist for the diff.

10. **Documentation as hypothesis.** Specs and vault notes are models, never ground truth. Where docs and code disagree about how code works, the code wins. Any architectural assertion, bug claim, or dependency cited from docs must be proven against live source code (`file:line`). Modifying code in a feature directory requires updating or verifying its paired vault note in the same change (`node scripts/check-doc-drift.mjs`).
11. **Token & context hygiene.** Agents must conserve quota: run gates with `--terse` (1 line/check; full logs on error), avoid polling loops (wait on reactive notifications), use sliced file inspection (`StartLine`/`EndLine`), and batch related operations into dense turns.

**Task contract:** preflight (advisory) -> orient (relevant docs + vault note) -> implement to rules -> test while working -> run `npm run gate:quick` before committing -> exercise runtime flow -> update affected docs in same change. On failure: fix and re-verify, max 3 attempts per distinct failure, then stop and report honestly with evidence. Never skip a failing test; never claim done without proof.

**Working preferences:** answer first and tersely, with evidence; reuse existing code before writing new; make the simplest change that meets the spec; start a bug fix with a failing test; subtract before adding; batch tool calls, read slices, never poll; `gate:quick` locally, push once; "are you sure?" means re-audit from evidence.

**Enforcement is universal, not tool-specific.** Machine-checkable rules are enforced at commit time by `.githooks/` and re-checked in CI — identically for Claude, Codex, Antigravity, Copilot, Cursor, and humans. Provider-native agent adapters are generated from `agent-system/agents.json`.
<!-- AGENT-RULES-DIGEST END -->
