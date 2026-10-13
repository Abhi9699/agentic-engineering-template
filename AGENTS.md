# AGENTS.md — Autonomous Agentic Architecture

**This file is the single source of truth for working in this repo. Read it fully before writing any code.**

## 1. What this is
Autonomous software engineering repository powered by multi-IDE AI agent harnesses (Claude, Google Antigravity, OpenAI Codex, Cursor, GitHub Copilot).

## 2. Core Commands

```bash
npm run gate:quick          # LOCAL BAR before committing: static checks + types + changed tests
npm run gate                # Ship gate before opening a PR
npm run exec:review "<req>" # Pre-mortem executive risk assessment & C-suite lenses (R0-R4)
npm run check:control-plane # Verify declarative schemas, DAG graph reachability, self-tests
npm run gen:configs         # Sync rule digests to all IDE tool mirrors
npm run agent:generate      # Emit updated adapters for Claude, Antigravity, Codex, Cursor
npm run prove:gates         # Re-prove all anti-regression lesson checks
```

## 3. Technology Stack (Configurable via config/stack.config.json)
TypeScript strict · Node 24+ ESM · Vitest · Vanilla modular architecture · Zod schema validation.

## 4. Hard Rules (A violation is a broken PR)

| Don't | Do instead | Enforced |
|---|---|---|
| Use `any` or skip validation | TypeScript strict; validate every boundary with Zod | tsc / check:rules |
| Weaken a check to get to green | Fix the cause. Never delete or loosen failing assertions. No `@ts-ignore` | check:rules / tsc |
| Bundle a fix with unrelated refactors | One concern per PR | review / judgment |
| Read or commit secrets | `.env*` and credentials stay local-only (gitignored) | guard-secrets.mjs |

**Numbered Rules:**
1. **Modules & Architecture** — Modular components <= 400 lines; decompose multiple concerns.
2. **Tokens & Motion** — Scoped styles, design token discipline, animate transform/opacity only.
3. **Data Access** — Explicit queries, tenant/ownership isolation, bounded list queries.
4. **Types & Quality** — Zero `any`, deterministic execution, no unannotated suppressions.
4b. **Zero-Trust Security** — Every backend mutation authenticates caller and verifies ownership.
4c. **Accessibility** — WCAG 2.2 AA: labelled controls, visible `:focus-visible`, never block paste.
4d. **Performance** — Zero waterfalls, abortable in-flight requests, image aspect ratios set.
5. **AI Pipelines** — Prompts live in versioned registries; untrusted text escaped; safety fallbacks.
6. **Error Handling** — Standard typed error envelopes; quota/paywall status 402; fail-closed.
7. **Secrets** — `.env*` and credentials are never read, written, or committed.
8. **Decisions & Scope** — One concern per PR. Update living `vault/` notes when work changes reality.
9. **Executive Advisory Mandate** — Challenge flawed requests. Run `npm run exec:review "<request>"` before non-trivial work (R0-R4 risk tiering, C-suite lenses, and pre-mortems).
10. **Documentation as Hypothesis** — Code wins over docs. Prove claims against live source code (`file:line`).
11. **Token & Context Hygiene** — Run gates with `--terse`, avoid polling loops, read file slices.

## 5. Where Things Live
- Control plane manifests: `agent-system/*.json`
- Universal scripts & gates: `scripts/`
- Git barriers: `.githooks/`
- Living Knowledge Vault: `vault/`
- Application code: `src/`

## 6. Task Contract
1. **Orient:** Read task spec and corresponding `vault/` note.
2. **Implement:** Follow §4 hard rules.
3. **Verify:** Run `npm run gate:quick`.
4. **Update:** Update affected docs and vault notes in the same commit.

<!-- BEGIN:agent-rules -->
<!-- END:agent-rules -->
