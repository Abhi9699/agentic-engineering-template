# Agent architecture decision register

| Field | Value |
|---|---|
| **Lifecycle** | Current decision register |
| **Owner / approver** | Founder |
| **Maintainer** | Engineering productivity |
| **Authority** | Architecture authorization only; does not override product decisions |
| **Last verified** | 2026-08-16 |

This is the only approval register for
`docs/archive/AGENTIC-ARCHITECTURE-EXCELLENCE-PLAN-2026-07-28.md`. The plan is a
non-authorizing proposal. A recommendation or broad quality goal is not substituted for
a decision whose prerequisites or measured evidence do not yet exist.

## Decision schema

Every decision records:

- stable ID and status (`pending`, `accepted`, `rejected`, `superseded`, or `expired`);
- exact scope and exclusions;
- approver and approval date;
- prerequisite evidence and its digest;
- time/cost budget and review or expiry date;
- rollout, rollback, and supersession history.

## Baseline evidence

| Evidence | Digest / result |
|---|---|
| A0 evidence envelope | `fb433bedf3c3ed099dc256047e3b109ac559d7a1ff1163ed3b08d2aed27468e1` |
| Repository baseline | `1289a5e2750c15c4ebaa88faa002d49db8a13149` |
| A0 independent verdict | Blocked pending A0-D documentation recovery; A0-D vault blocker cleared 2026-07-31 (decisions #31–#54 digested, vault 100/100) |
| Live provider calls / paid cost | `0` / `$0` |
| A0 protocol deviation | `A0-DEV-001`; dotenv initialization occurred without value disclosure |
| A-NOW implementation evidence | `docs/engineering/audits/architecture/2026-07-31-a-now-implementation.md` |
| A-NOW protocol deviations | `A-NOW-DEV-001` implemented before Documentation-Ready/AD-00 on founder instruction; `A-NOW-DEV-002` ran in the existing dirty worktree rather than clean branches from `develop` |

## Bootstrap decision

### AD-00 — A-NOW bootstrap

| Field | Record |
|---|---|
| Status | **`accepted`** — ratified retrospectively by the founder on 2026-07-31, with both deviations left on the record |
| Scope | Seven A-NOW rows in two independently reversible slices |
| Exclusions | No live/paid provider calls; no A1–A8 authorization |
| Approver | Founder |
| Approval date | 2026-07-31 (retrospective ratification; the work preceded the approval, which is deviation `A-NOW-DEV-001`) |
| Prerequisites | A0-D green (**not met** — blocked on the owner-only `vault/Decisions.md` digest of decisions #31–#54); roadmap conflict check (**not recorded**); clean worktrees from `develop` (**not met** — `A-NOW-DEV-002`); rollback base `1289a5e2` (met); time budget (**not recorded**) |
| Evidence digest | `docs/engineering/audits/architecture/2026-07-31-a-now-implementation.md` |
| Budget | Not recorded. Actual paid spend to date: `$0` |
| Review/expiry | Review immediately — the founder must either ratify this retrospectively or direct a revert |
| Rollback | Slice S and Slice T revert independently from `1289a5e2`; nothing is committed |
| Supersession | None |

**Honest status.** All seven rows are implemented and verified (1138/1138 tests green,
`tsc` clean, build passing, zero paid calls). They were built on the founder's explicit
2026-07-31 instruction to complete the plan, which came *before* the prerequisites this
register exists to enforce. An agent cannot grant itself authorization, so the work was
recorded as deviation `A-NOW-DEV-001` and held at `pending-prerequisites` until the founder
ruled. **On 2026-07-31 the founder ratified it retrospectively.** The deviations are
deliberately NOT erased: the register's value is that it records what actually happened,
including the order in which it happened.

## Retention decision — A1–A8 (2026-07-31)

**Founder directed that the implemented A1–A8 control plane be RETAINED as-is.**

| Field | Record |
|---|---|
| Decision | Keep A1–A8 in the working tree, unchanged and uncommitted |
| Rationale | Built, green (1138/1138 tests), 11/11 planted failures caught, ~2% gate overhead; six real defects already found. Rebuilding later would cost more than retaining it |
| What this is NOT | **Not AD-00 approval, and not authorization for any further phase.** It is a decision to retain existing work, nothing more |
| Consequences | `npm run check:control-plane` stays in `npm run gate`. The control plane must be maintained: manifest edits require `npm run agent:generate`, and skill changes require `npm run skills:sync -- --write` |
| Outstanding | Cross-worktree lease (AA-GAP-17) and egress broker (AA-GAP-21) remain trigger-gated and unbuilt; evidence checking stays report-only |
| Review trigger | If the control plane blocks work it should not, or its maintenance exceeds its demonstrated value, revisit under §17.1 |

## AD-15 — content-growth strategist consultation lane

| Field | Record |
|---|---|
| Status | **`accepted`** — explicitly approved by the founder in this thread before implementation |
| Scope | Add one repository-native, read-only `content-growth-strategist`; one first-party evidence skill and deterministic packet validator; advisory routing; and generated adapters for Claude, Codex, Antigravity, GitHub Copilot, and Cursor |
| Exclusions | No product-source mutation, autonomous publishing, authenticated social access, live/paid model call, deployed MCP server, general egress broker, pricing/legal/public-claim approval, or claim of literal zero hallucination |
| Approver | Founder |
| Approval date | 2026-08-16 |
| Prerequisites | Existing control plane retained; current official provider documentation checked; task is read-only at runtime; no new dependency or external service required |
| Evidence digest | `docs/engineering/audits/architecture/2026-08-16-content-growth-strategist.md` |
| Budget | Zero paid provider calls and zero deployed infrastructure; local implementation and verification only |
| Review/expiry | Provider configuration facts expire after 30 days; external content facts carry claim-level TTLs |
| Rollback | Remove AD-15 receipt, strategist/route/capabilities/skill entries, regenerate adapters and skill lock, then run the control-plane gate |
| Supersession | None |

**Acceptance boundary.** “No hallucination” is implemented as zero unsupported factual claims
in an accepted consultation packet: volatile facts require current source records, excerpt
hashes, reciprocal claim mapping, and TTL checks. A deterministic validator can reject missing,
stale, mismatched, conflicted, or self-certified evidence; it cannot prove that a cited excerpt
semantically entails the claim. That final judgment remains with the consuming agent and
independent reviewer. Provider adapter generation proves files match the manifest, not that a
provider loaded or obeyed them. Copilot cloud's native `web` alias is unavailable, and Cursor
web access depends on configured MCP tools; those runtimes must use an approved source bundle
or return `blocked`.

## Full-program decisions

AD-01 through AD-14 are `deferred-evidence` until A-NOW lands and the product-P0/roadmap
continue gate is satisfied. Their exact decision text, dependencies, and acceptance
conditions remain in §18.2 of the architecture plan. They cannot be accepted before the
required cost, privacy, product-priority, and A-NOW evidence exists.

| ID range | Status | Earliest decision point |
|---|---|---|
| AD-01–AD-14 | `deferred-evidence` | After A-NOW and the product-P0/roadmap continue gate |

## Supersession history

No architecture decision has yet been superseded.
