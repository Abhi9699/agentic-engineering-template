# Agent Enforcement — the tool-agnostic spine

> **A0-D temporary warning — `DOC-P1-010`.** Lifecycle consolidation is still active.
> Every parity and readiness claim below names the mechanism actually tested.

| | |
|---|---|
| **Since** | 2026-07-18 (design spec retired 2026-07-24 — recover from git history: `docs/superpowers/specs/2026-07-18-agentic-enforcement-spine-design.md`) |
| **Last verified** | 2026-08-16 against local scripts, manifests, generated five-provider strategist adapters, and focused tests |
| **Reads with** | `AGENTS.md` §4 (the rules) · §9 (what's enforced) · §11 (per-tool map) |
| **Principle** | `AGENTS.md` stays the single source of truth; **correctness does not depend on any AI reading it**. Every machine-checkable rule is enforced at commit time and in CI — identically for Claude Code, Codex, Antigravity, Copilot, Cursor, and humans. |

## The four layers

| Layer | What | Where |
|---|---|---|
| 1. Zero-drift mirrors | Per-tool config files are generated from the `AGENT-RULES-DIGEST` region in `agent-system/rules-digest.md` (moved out of `AGENTS.md` on 2026-09-16 so native `AGENTS.md` readers don't load every rule twice); CI fails on drift | `scripts/gen-agent-configs.mjs` (+ `scripts/lib/markers.mjs`) |
| 2. Universal guardrails | Committed git hooks run shared guard modules on every commit/push, for every tool | `.githooks/pre-commit`, `.githooks/pre-push`, `scripts/guard-{secrets,migrations,prompts}.mjs` |
| 3. Deterministic rules | The machine-checkable §4 rules, unit-tested, with block/warn severity + escape hatches | `scripts/lib/hard-rules.mjs` (engine), `scripts/check-hard-rules.mjs` (CLI) |
| 4. One contract | The task contract + enforcement statement ship inside the generated digest, so every tool reads identical words | the digest itself |

## Per-tool configuration map (provider-agent paths verified 2026-08-16)

| Path | Is | Read by |
|---|---|---|
| `AGENTS.md` | single source of truth (Linux Foundation / AAIF standard) | every tool natively |
| `CLAUDE.md` | pointer → `AGENTS.md` | Claude Code |
| `GEMINI.md` | pointer + generated digest | Gemini CLI **and** Antigravity (highest project priority) |
| **`.agent/rules/`** (singular) | Antigravity workspace rules (legacy fallback mirror) | Antigravity |
| **`.agents/rules/`** (plural) | Antigravity workspace rules & glob policies (current path) | Antigravity |
| **`.agents/hooks.json`** | Antigravity lifecycle hooks (PreToolUse command guard & Stop evidence guard; documented; not yet verified) | Antigravity |
| **`.agents/skills/`** (plural) | skills (`SKILL.md` packages; gitignored machine-local vendor packs + any committed exceptions) | Codex **and** Antigravity |
| `.codex/agents/*.toml` | Codex subagents | Codex |
| `.agents/agents/*.md` | Workspace custom agents | Antigravity |
| `.github/agents/*.agent.md` | Repository custom agents | GitHub Copilot |
| `.cursor/agents/*.md` | Project subagents (`readonly` supported) | Cursor |
| `.cursorrules`, `.github/copilot-instructions.md`, `llms.txt` | pointer + generated digest | Cursor / Copilot / crawlers |

**The `.agent` vs `.agents` trap:** singular = Antigravity *legacy rules fallback*; plural = Codex+Antigravity *skills*, current *rules*, and *hooks*.

## Commands

```bash
npm run check:rules              # scan app/ lib/ components/ (CI mode)
node scripts/check-hard-rules.mjs --staged    # staged files only (pre-commit uses this)
npm run check:rules:coverage     # which rules are enforced (block/warn) vs judgment-only
npm run gen:configs              # regenerate all tool mirrors from AGENTS.md
node scripts/gen-agent-configs.mjs --check    # rules-mirror drift gate (CI runs this)
npm run check:agents             # Claude/Codex subagent roster + description parity — STRUCTURAL ONLY (in gate + pre-commit)
npm run agent:doctor             # report-only capability/skill inventory health (never blocks; A-NOW item 6)
npm run check:control-plane      # IN THE GATE: manifest schema + graph invariants + skill pins
                                 #   + adapter drift + 11 planted-failure self-tests
npm run agent:generate           # regenerate Claude/Codex/Antigravity agents from agent-system/agents.json
npm run skills:sync -- --write   # re-pin skill integrity hashes after an intentional skill change
npm run agent:task "<request>"   # which route, specialist, skills and evidence does this need?
npm run agent:evidence           # what evidence do my changed paths owe? (report-only)
npm run agent:selftest           # prove every control-plane gate still rejects a planted failure
```

**Three distinct drift gates, don't confuse them:**
- `gen-agent-configs --check` guards the **rules mirrors** (`.agents/rules/` + the legacy `.agent/rules/`, `GEMINI.md`, `.cursorrules`, Copilot, `llms.txt`) — generated from the `AGENT-RULES-DIGEST` region in `agent-system/rules-digest.md`.
- `check-agent-parity` (`npm run check:agents`) guards Claude/Codex roster and normalized description equality, then requires a materialized adapter for every active manifest provider claim. **Structural only:** it does not prove tool availability, skill loading, source quality, or behavioral equivalence.
- `generate-adapters --check` (inside `npm run check:control-plane`) guards Claude frontmatter, Codex headers, Antigravity specialists, Copilot profiles, and Cursor subagents against `agent-system/agents.json` **plus** `agent-system/instructions/<agent>/`. Since 2026-08-27 nothing is read back out of an adapter: `_shared.md` is the normative body and is emitted verbatim to every provider, so `--check` is a real comparison and a hand-edited adapter fails.

### Per-provider adapter fidelity (corrected 2026-09-02)

Emitting the same prose to five providers is not parity — each provider's frontmatter is
its own dialect, and only the frontmatter grants tools.

**Antigravity** ([subagents docs](https://antigravity.google/docs/subagents), verified
2026-09-02) reads `.agents/agents/<name>.md` with its own identifiers (`view_file`,
`replace_file_content`, `grep_search`, `run_command`, …). Two of its defaults make a
borrowed name dangerous: the engine gives a subagent **no tools at all** if it names no
tools — and the docs record that a misspelled tool name "may cause the subagent process
to hang". So the generator gives Antigravity **no fallback** to Claude's tool names; a
missing or empty `providerConfig.antigravity.tools` fails generation.

| Key | Values | Why it is pinned |
|---|---|---|
| `tools` | Antigravity identifiers | The only tool grant. No inheritance, no fallback |
| `model` | `inherit \| flash \| pro` | Carries the cost decision Claude expresses as `haiku` (an `economy` tier maps to `flash`) |
| `commandExecutionPolicy` | `off \| auto \| eager \| sandbox` | Pinned to `sandbox` (also the default) so a future default change cannot loosen an agent |

**Read-only enforcement is provider-shaped, not universal.** Claude denies writes with
`disallowedTools` and guards its shell with the `guard-readonly-agent.mjs` PreToolUse
hook; Codex uses `sandbox_mode = "read-only"`; Cursor uses `readonly: true`. For read-only
specialists in Antigravity, its tools allowlist is the write-denial surface —
`replace_file_content` is the only tool that writes, and withholding it *is* the control
(while workspace-level command guards and Stop lifecycle hooks configure via `.agents/hooks.json` — documented; not yet verified).
Generation fails if a `readOnly` agent is ever granted it.

*What this was:* until 2026-09-02, seven of eight Antigravity adapters shipped Claude's
tool names, because the renderer fell back to `providerConfig.claude.tools` while the
validator read `providerConfig.antigravity.tools ?? []` — undefined for exactly those
seven, so the loop never ran and the gate reported green on the failure it was written
for. Five planted self-tests now cover this (16 → 21).

### Skills are two-rooted, and both roots are now checked (2026-09-02)

Claude reads `.claude/skills/`; Codex and Antigravity read `.agents/skills/`. A
first-party skill is canonical in exactly one root — beside its data, scripts and driver —
and needs a **discovery mirror** in the other, or the providers reading the other root
cannot find it at all.

Mirrors are generated (`npm run skills:mirrors`, `--check` in the gate) and carry **no
reference content**: name, description, the canonical path, and any project policy
about the skill from `agent-system/instructions/_skills/<id>.md`. An unmonitored mirror
had drifted — presenting a driver reference missing
`theme`, `perf`, `cta`, `scroll-through`, `signout`, `eval`, `text` and `help`, the whole
verification ladder, and every Gotcha. It read complete, so there was no reason to open
the real guide, and nothing compared the two. A partial copy that looks whole is worse
than a pointer.

**Skills named in prose are declared in the manifest.** `_shared.md` is emitted verbatim
everywhere, so a skill it names is named on providers that may not have it. Every
registered skill named in an agent's body must appear in `requiredSkills` or
`conditionalSkills`, and `skills.json` `availableOn` then drives a generated per-provider
footer: *"Not available on this provider (antigravity): `dataviz`, `frontend-design`."*
A `requiredSkill` unavailable on a claimed provider fails generation outright — a preload
cannot be conditional. `provenance: provider-native` marks a skill the provider itself
ships: this repository cannot materialize, pin or verify it, and `agent:doctor` reports it
as such rather than as a materialization gap nobody can close.

**The context budget measures every provider.** It read `.claude/agents` + `.claude/skills`
for all five until 2026-09-02, so it understated everyone else and could not see that
`content-growth-intelligence` had no Claude-side copy at all — the strategist's preload was
a silent no-op on the provider it runs on most. The ceiling now binds against the worst
provider, because that is the per-spawn cost somebody actually pays.

## The control plane (`agent-system/`)

Typed manifests describe capabilities, agents, skills, routing, evidence, sources, budgets, loops, providers, completion states and the graph contract. They are **configuration, not policy** — they reference rule IDs and never restate AGENTS.md prose, and a test enforces that boundary.

`check-graph` derives a typed dependency graph from them on every run (nothing is stored) and enforces invariants JSON Schema cannot express: no route may reach a quarantined skill or an agent that does not exist yet, every R3/R4 route needs an independent verifier and a human gate, exclusive file ownership may not overlap, judgment-only evidence must name a reviewer, and no agent may hold a `humanOnly` capability as a standing power.

**Skill integrity is verifiable (since 2026-07-31).** `agentic-skill-tree-sha256-v1` hashes each skill's whole directory — LF-normalized text, raw bytes for binaries — so a pin is falsifiable. The previous `skills-lock.json` `computedHash` values were produced by no code in this repository and reproduced by no documented algorithm, which made tampering indistinguishable from an algorithm difference. `agent-system/skills.json` is now the single registry; `skills-lock.json` is generated output.

**MCP Builder is registered as an external capability (since 2026-08-02).** The
Apache-2.0 `anthropics/skills` package is materialized at
`.agents/skills/mcp-builder`, registered in `agent-system/skills.json`, and pinned in
the generated `skills-lock.json`. Its presence and byte integrity are checked by
`npm run check:control-plane`; that check does not prove the upstream guidance is
current or that a provider loaded the skill.

**Content-growth consultation has a strict evidence boundary when invoked (since 2026-08-16).**
`content-growth-strategist` is an active read-only role with generated adapters for Claude,
Codex, Antigravity, Copilot, and Cursor. The manifest grants no write, shell, publish, or deploy
capability. Claude, Antigravity, and Copilot adapters use explicit tool allowlists; Codex and
Cursor cannot isolate inherited connectors at repository level and therefore require a
secret-free worktree, public-only host configuration, or caller-supplied public source bundle.
Its first-party `content-growth-intelligence` skill requires claim-level sources and an
`unvalidated` handoff. The parent validates packets with
`.agents/skills/content-growth-intelligence/scripts/validate-evidence.mjs`; the validator
uses a strict Zod v4 schema and rejects unknown fields, missing sources, caller-inflated
freshness TTLs, excerpt-hash mismatches, broken reciprocal mappings, unsupported recommendation
dependencies (including assumptions), and self-certified validation. This is machine-checkable
when the parent invokes it; no provider hook automatically blocks an unvalidated handoff, and
it does not prove that a source semantically entails a claim. The reviewer remains the
independent reviewer.

Provider caveat: Copilot's `web` alias is not available to its cloud agent, Codex parent
overrides can weaken a custom agent's sandbox, and Cursor subagents inherit parent/team MCP
tools. When a runtime cannot prove public-only research isolation or reach current public
sources, the strategist accepts a caller-supplied source bundle or returns `blocked`.
No remote MCP service or general egress broker was deployed under AD-15.

## Proof boundaries

| Evidence | What it proves | What it does not prove |
|---|---|---|
| `npm run check:agents` | Claude/Codex roster and normalized descriptions plus materialized files for every manifest provider claim | Skill loading, tool permissions, behavioral equivalence, or provider execution |
| `gen-agent-configs --check` | Generated rule mirrors match the digest | That a provider loaded or obeyed the mirror |
| `npm run gate` | Required local repository checks passed | Gitleaks, base-aware applied-migration comparison, CI environment behavior, vault workflow, deploy, or external services |
| `npm run check:control-plane` | Manifests are schema-valid and semantically consistent, skill bytes match their pins, provider adapters match the manifest, and 11 planted failures are still rejected | That a provider actually loaded a skill, that an agent obeyed its contract, or that a hand-authored prose body is still accurate |
| `npm run agent:evidence` | Which evidence the changed paths owe | That the evidence was produced — it is report-only and cannot block |
| `npm run agent:task` | A recommended route, specialist, skill and evidence set | Authorization. It is keyword/path matching, not judgement; it recommends and never approves |
| Git hooks | The invoked local commit/push checks passed | Protection against `--no-verify` or CI/external readiness |
| CI | The committed CI workflows passed for an exact revision | Runtime correctness in production or vendor configuration |
| Runtime/vendor evidence | The named flow worked in the named environment | Unrelated flows, later revisions, or permanent provider parity |

## How to add or change a hard rule

1. Edit the rule in `AGENTS.md` §4 (the table, and the numbered list if it adds a clause) **and** the digest in `agent-system/rules-digest.md`, in the same commit. `scripts/__tests__/agent-config-paths.test.ts` fails if a numbered rule, or a clause that once lived only in the digest, disappears from `AGENTS.md`.
2. If machine-checkable, add it to `RULES` in `scripts/lib/hard-rules.mjs` (+ a test in `scripts/__tests__/hard-rules.test.ts`). High confidence → `severity: 'block'` with an inline escape-hatch comment (like `// authz-403`); heuristic → `'warn'`.
3. `npm run gen:configs` → commit the regenerated mirrors together with the rule change (CI rejects the commit otherwise).

## Hook mechanics

- `core.hooksPath=.githooks` is set by the npm `prepare` script on every `npm ci`/`npm install` (non-fatal outside a git checkout, so build sandboxes never break).
- Hooks are POSIX `sh` shims (LF-forced via `.gitattributes` — CRLF breaks `sh`); all logic lives in cross-platform Node scripts whose CLI blocks use `pathToFileURL` detection (the `file://` string-compare idiom silently never fires on Windows).
- The Claude Code PreToolUse secret hook delegates to the same `scripts/guard-secrets.mjs` (fail-closed) — one implementation, two callers.
- Bypass (`git commit --no-verify`) is not defended locally; **CI is the backstop** (hard rules, drift check, gitleaks, gate).

## Task-discipline hooks: one policy, one manifest, every provider (2026-09-23)

Preflight → write guard → Stop guard used to exist only for Antigravity, and its classifier stopped any task containing common words (`build`, `agent`, `owner`) as a "§B open question" while forcing web research on every R2 UI tweak. Now:

- **Policy** lives once in `scripts/agent-system/hooks/core.mjs`. Classification reuses the `agent:task` resolver. Research is required only for R3+ or a task naming a library version; an unresolved request is R1. §B hits are "verify before relying" notes, never a stop.
- **Wiring** is declared once in `agent-system/hooks.json`. `npm run agent:generate` writes `.agents/hooks.json` whole and only the *managed* entries (`node scripts/agent-system/hooks/…`) of `.claude/settings.json`; `check:control-plane` fails on drift.
- **Wrappers** are thin: `antigravity-*.mjs` and `claude-*.mjs` translate payload/output shapes only. Claude classifies on `UserPromptSubmit` (it sees the prompt, so step 0 is free); Antigravity's `PreInvocation` cannot, so it reminds the agent to run step 0.
- **Cost:** the Stop guard runs `evidence:check` only when a source file was written since it last settled, blocks at most twice in a row, then settles, so question-only turns end free. The Claude write guard prints nothing on allow (printing "allow" would skip the permission prompt).
- **Risk never drops within a session**: "yes go ahead" cannot relax an R3 task in flight.

> **Superseded in part by doc 34 W3 (2026-10-03): gates arm from written files, not prompts.**
> The prompt classifier routed read-only questions as `control-plane-change · R3` and armed
> research for them, so the prompt hook is now **advisory** and arms nothing.
> - **Write guard** (`evaluateWrite`) ledgers every in-repo write (`written` / `pending`) and
>   ratchets risk from the written paths (`classify('', written)`). Research is owed only for a
>   dependency-version edit (`package.json` text naming a version, the lockfile) or a
>   vendor-integration path (`VENDOR_PATH_RE`: billing, auth, AI gateway, integrations).
> - **Stop guard** (`evaluateStop`) does nothing when `pending` is empty. Otherwise it runs
>   `scripts/agent-system/hooks/session-gate.mjs` on the ledger (not `git status`: the checkout
>   is shared). First the mechanical checks (doc 36 S3, 2026-10-11): line caps in process on the
>   written `app|components|lib` `.ts(x)` files against `scripts/line-caps.baseline.json`;
>   `check:tokens` for a written CSS Module or `app/globals.css`; `check:css-modules` (missing and
>   `--unused`) for a written CSS Module or `app|components` `.tsx`. Claude also gets a write-time
>   `additionalContext` notice when a write would take a capped file past its allowance (never a
>   deny). Then the doc generators whose inputs were written (doc 36 S4, 2026-10-11; the list is
>   `scripts/lib/docs-steps.mjs`): each is checked and, on drift, regenerated (`--write`, the
>   index/governance pair in the `docs:write` converging order) and re-checked; a regeneration
>   blocks Stop once as **"docs regenerated"** so the output joins the same commit. Vault lint,
>   `check-doc-drift` and `check-doc-refs` carry decisions and are never auto-fixed. Then related Vitest files (`selectTests`, threads; `chdir` tests apart) and, for a
>   TypeScript write, `tsc --noEmit`, each capped at 120 s within a 240 s budget; a timed-out
>   step is reported as deferred to `gate:quick`, never silently passed. Then the evidence check.
>   Hook timeout is 300 s in both providers. After 2 blocks it stops with
>   **"UNVERIFIED — gate failed (…)"** (Claude `systemMessage`; Antigravity shows a reason only
>   with `continue`, so there the pre-push `gate:quick` is the backstop).
> - **Antigravity PreInvocation** speaks only after a vendor write was refused for want of research.

## `main` protection: three partial nets, no complete one (2026-09-03)

> **Superseded 2026-09-25:** GitHub Pro is active and repository rulesets now protect
> `main` and `develop` server-side (`.github/rulesets/*.json`: PR-only, required checks
> `Code Quality` + `Secret Scan`, no force-push or deletion, no bypass). L-025 is closed.
> A third ruleset, `review-required` (`.github/rulesets/review.json`), adds code-owner
> approval with an admin-only bypass on PRs; agents push and open PRs as the
> `template-bot` GitHub App so the owner can approve them
> (`docs/ops/access-and-break-glass.md` §3).
> The history below explains why the three local nets exist; they stay as earlier layers.

`main` is release-only (AGENTS.md §8) and is what Vercel deploys to production. Before
2026-09-25 **no server-side control could enforce that on this repository.** Verified
against the live API at the time:

| Endpoint | Response |
|---|---|
| `GET /repos/<owner>/<repo>/rulesets` | `403 "Upgrade to GitHub Pro or make this repository public."` |
| `GET /repos/.../branches/main/protection` | `403` — same |
| `PATCH /repos/...` enabling advanced security | `422 "Advanced security has not been purchased."` |

GitHub's own docs name **repository rulesets** as the forward-looking replacement for
classic branch protection — multiple can apply at once, enforcement is togglable without
deleting the ruleset, and they are visible to anyone with read access. Neither is
purchasable here, so what exists instead is three partial nets:

1. **`.githooks/pre-push`** → `scripts/guard-main-push.mjs`. Refuses a push to `main`
   whose HEAD is not a merge from `develop`, reusing `checkMergeOrigin()` so there is one
   implementation. **Bypassed by `--no-verify`** — which is this repository's normal way
   to push, because the pre-push typecheck was slow enough that skipping it became habit.
   A control defeated by the maintainer's own muscle memory is not a control, hence net 2.
   Since 2026-09-28 the hook's second step is `scripts/pre-push-check.mjs`, per pushed
   commit: instant when `gate:quick` already passed on it (the receipt in `.git`);
   otherwise it runs `gate:quick` (static checks, `tsc`, affected tests) on that commit,
   in place on a clean tree or in a throwaway worktree when the tree has uncommitted
   changes, since concurrent agents make the working tree differ from what is pushed.
   The inner loop is `npm run test:task` (`scripts/test-task.mjs`): the tests that import
   the uncommitted changes plus the tests that read them from disk. Both it and
   `gate:quick` find affected tests with `scripts/related-tests.mjs`, a text scan of
   imports, because `vitest related` / `--changed` spent 30+ minutes building the module
   graph on a Windows laptop (2026-09-28). Measured with the scan: `test:task` 153 s for
   22 changed files (24 test files).
2. **`.claude/settings.json` `PreToolUse`** on `Bash(git push *)`, running the same guard
   with `--hook`. This one **survives `--no-verify`**, because it intercepts the tool call
   before git runs at all. Claude-only: Codex, Antigravity and a human at a terminal do
   not have it.
3. **`scripts/check-main-merge-origin.mjs`** in CI, on push to `main`. After the fact —
   Vercel may already be deploying by the time it goes red.

Nets 1 and 2 are *preventive* and *local*; net 3 is *detective* and *remote*. None is
server-side, so a determined or careless push from an unguarded tool still lands.
**L-025 stays OPEN**, and it closes only when a server-side control exists — that is a
plan decision (GitHub Pro, or making the repository public), not a code change.

Pinned by `scripts/__tests__/guard-main-push.test.ts`, which asserts the guard logic, the
hook ordering (guard before typecheck, so a refusal costs nothing), the `PreToolUse`
wiring, and that CI still carries net 3.

## Claude hooks resolve from the project root and fail closed (2026-09-24)

Claude runs a command hook in the session's **current** directory, which follows every
`cd` the agent makes. The hooks used to call `node scripts/...` by a relative path, so from
any subdirectory they crashed with "Cannot find module". And a PreToolUse hook that crashes
or times out **does not block** — the call proceeds
([hooks docs](https://code.claude.com/docs/en/hooks), verified 2026-09-24). Transcripts
from 2026-08-30 → 2026-09-24 showed 55 such crashes and 26 timeouts (10s, during machine
stalls) across the secret-read, `main`-push and staged-secret guards: each one a call that
ran unguarded.

- Every Claude hook now runs `node "${CLAUDE_PROJECT_DIR}/scripts/..."`. Managed hooks get
  this from `anchorToProject()` in `scripts/agent-system/generate-hooks.mjs`; the manifest
  (`agent-system/hooks.json`) keeps the provider-neutral relative form.
- **Since 2026-10-08 the security guards run in exec form, with no shell.**
  `guard-bash-secret-read` (Bash, and PowerShell with `--powershell`), `guard-main-push` and
  `guard-secrets` are wired as `node -e BOOTSTRAP ${CLAUDE_PROJECT_DIR}/scripts/hook-fail-closed.mjs <guard>`.
  - The old `|| { …; exit 2; }` tail needed Git Bash. On Windows without it, Claude falls back
    to PowerShell, the tail does not parse, and the guard failed open.
  - `hook-fail-closed.mjs` turns any guard failure into exit 2, which blocks: a crash, a missing
    module, a bad return.
  - `BOOTSTRAP` does the same if the runner file itself cannot load.
  - Each guard exports `hookMain(raw, args)`. The git-hook CLIs still call the same code.
- The guards' timeout is 60s (was 10s). A stall now delays the call instead of waving it
  through. A healthy run costs about 1s.
- Proved live on 2026-10-08 in a headless Claude Code 2.1.294 session in a worktree: the Bash
  and PowerShell probes were both denied.

Pinned by `scripts/__tests__/agent-hooks-core.test.ts`, which checks three things:
- no hook uses a cwd-relative path;
- a guard that cannot start exits 2;
- a run from `docs/` still denies a secret read.

`scripts/__tests__/hook-fail-closed.test.ts` pins the runner itself.

Residual risk: a timeout cannot be made to block, because that is Claude Code's contract. 60s
narrows the window but does not close it. Antigravity's hook wiring was not changed.

## Weakening a check to get to green (2026-09-17)

AGENTS.md §4 now carries this as its own row, with an honest enforcement column:

- **`@ts-ignore`, and a `@ts-expect-error` with no description**: blocked by
  `@typescript-eslint/ban-ts-comment` (already an error through `eslint-config-next/typescript`).
- **A stale `eslint-disable`** (one that no longer suppresses anything): an **error** since
  `linterOptions.reportUnusedDisableDirectives: "error"` in `eslint.config.mjs`. It was a
  warning, and warnings were how dead suppressions piled up unseen. Proved by planting an
  unused directive: `npx eslint` exits 1.
- **A new `eslint-disable` without a written reason, or a deleted or loosened test assertion**:
  **judgment** (review and `reviewer`). Requiring a description on every directive needs
  `@eslint-community/eslint-plugin-eslint-comments`, a new devDependency; that is an owner
  decision, recorded in `vault/Open-Questions.md`. 49 of today's 52 directives would need a
  `-- reason` or a frozen baseline.

## Deliberately NOT machine-enforced

Server-Components-by-default, Zod at the boundaries `route-zod` cannot see (Server Action arguments, service returns), right-abstraction judgments — automating these would produce false positives and erode trust in the checker. They stay with `reviewer` / PR review. `npm run check:rules:coverage` prints this boundary so it is never assumed.

**Judgment-only since 2026-09-17** (added to §4 and the `reviewer` sweep, and no check enforces them yet):
- **New config through `lib/env.ts`.** Existing `process.env` reads are grandfathered. A check that fails only on *new* reads outside an allowlist is the path to enforcement, and it would need its own CI step (`ci-backstop.test.ts`).
- **Rejection-path tests for new Server Actions / API routes.** `check:server-actions` proves `auth()` is called, not that the rejection is tested.
- **Escaping untrusted text interpolated into `prompt-registry.ts` templates.** This is a mitigation, not prevention; see OWASP LLM01:2025 (https://genai.owasp.org/llmrisk/llm01-prompt-injection/).
- **One concern per PR.**
- **Fail closed** on auth, ownership, credit settlement and validation.


## Two traps in per-tool rule-file discovery

*Relocated from `AGENTS.md` §11 on 2026-09-03. That file is read whole by several tools
and sits under a hard 32 KiB cap that `scripts/__tests__/agent-config-paths.test.ts`
enforces with a 10% reserve; when the reserve is hit the rule is to move DETAIL here and
leave the rule itself there. Nothing below changed but its location.*

*(**Size trap, 2026-08-22:** Antigravity's documented rule-file limit is **12,000 characters** ([rules & workflows](https://antigravity.google/docs/rules-workflows)) and this file is ~25,000. If it is truncated at that boundary the cut lands mid-§6, taking the ship gate, the delivery loop, "update the affected docs", §7 and §8 with it — which is why `.agents/rules/evidence-discipline.md` restates them in an always-on file that fits. Whether the cap applies to a natively-read `AGENTS.md` is **unverified**; the mitigation is cheap either way. Keep every file in `.agents/rules/` under 12,000 characters.)*

*(Path trap, corrected 2026-07-31: **`.agents/`** plural is Antigravity's **current** location for `rules/`, `skills/` **and** `agents/`, and is also where Codex reads skills. **`.agent/`** singular is a **legacy** rules-only fallback that still resolves, which is why generating only it looked fine for so long — both are generated until the fallback is formally retired. Source: [Antigravity rules](https://antigravity.google/docs/rules-workflows), last verified 2026-07-31; pinned by `scripts/__tests__/agent-config-paths.test.ts`.)*

## Re-proving a closed lesson (`npm run prove:gates`)

`vault/_Lessons.md` holds that a lesson stays OPEN until it has a gate **and** the gate has
been proven to bite. That proof happens once, by hand, when the lesson is written — break
the fix, watch the test go red, put it back — and then nothing re-checks it.

A gate rots quietly. An assertion loosened during an unrelated refactor; a mock that starts
satisfying the expectation for the wrong reason; a rename that leaves the test covering
nothing. Every one of those keeps the suite green, which is the failure mode L-015, L-033,
L-037, L-045 and L-049 all share.

`scripts/prove-gate.mjs` re-runs the ritual from a `proof:` spec in the lesson body:

```
- **proof:** `<file>` :: `<find>` -> `<replace>` :: `<test path>`
```

It mutates the file, runs the named test, asserts it **fails**, and restores from the
in-memory original in a `finally`. It refuses to run on a dirty tree, and refuses a `find`
string that matches zero times (the subject moved — the proof is stale) or more than once
(it will not mutate an arbitrary occurrence).

**Not a targeted revert of the fixing commit**, which was the first design and is too
coarse: a fix and its planted test usually land in the same commit, so reverting the source
deletes the module the test imports and the test fails for the wrong reason. A proof that
cannot tell "the guard is gone" from "the file is gone" proves nothing.

**Weekly in CI** (`.github/workflows/prove-gates.yml`), not in the ship gate: each proof
runs a real suite, and gate rot is slow-moving. A check that adds minutes to every PR for a
signal that changes monthly is how a useful check becomes one people route around. It still
fails loudly when a gate stops biting.

`--list` reports lessons that declare a gate with no `proof:` spec. That is a backlog to
burn down as lessons are written, never a failure: a lesson with **no** gate at all is a
legitimate terminal state (`lesson_recorded_as_open_with_named_blocker` in `loops.json`),
and demanding a proof from it would push toward manufacturing a gate to clear a report.

**Lesson classes (doc 36 P2, 2026-10-11).** Every lesson's `class:` opens with one id from the
closed set in `scripts/lib/lesson-classes.mjs`: `gate-gap`, `money-path`, `unmeasured-claim`,
`stale-fact`, `vendor-drift`, `ui-craft`, `silent-loss` or `process`. The plan's draft set was
replaced, because two of its classes held no lesson and the two largest groups had no class. Each
class names the routes it bears on. The preflight (`openLessonHits`) lists a class's OPEN lessons
when a prompt resolves to one of those routes, never on `minor-change` or a read-only route. Before
P2, the preflight matched only a `trigger:` field that no lesson carried, so it never listed a
lesson.

## Agent architecture v3 (2026-10-08)

Why: agents worked from worktrees with no env, the gate ran the whole suite for a one-line
`package.json` script edit, wording alone set the risk tier, and nothing measured whether the
reviewer catches anything. Each item below names the file that enforces it.

### Scorecard

`npm run agent:scorecard` (`scripts/agent-system/scorecard.mjs`) reads the shared state dir
`<git-common-dir>/agent-state/` (`scripts/lib/shared-state.mjs`), so every worktree and every tool
writes to one place. Since doc 36 M2 (2026-10-11) it also prints the quick gate per agent tool,
**stage catches** (how often each stage stopped a run; a stage at 0 over 60 days is a retirement
candidate for the doc 36 G2 review) and, from `git log` `Agent-Tool` trailers, commits per tool
with their fix share and **rework** (a `fix` touching a file a `feat` changed in the prior 14 days).
Run `npm run agent:scorecard -- --days 60` for the retirement view. Targets, reviewed when a number misses:

| Metric | Target | Why this number |
|---|---|---|
| gate:quick p50 | ≤ 5 min | the first run on a fresh branch tests everything changed since `origin/develop`; re-runs after a green commit measured 119 s (C3) |
| Stop `UNVERIFIED` | 0 per week | each one is a claim shipped without passing evidence |
| CI escapes after a green local gate | ≤ 1 in 10 | above that, `gate:quick` scoping is missing an input |
| Startup context (AGENTS.md + CLAUDE.md + vault entry notes) | ≤ 30 KB | paid on every task; AGENTS.md §1–§8 must also end before 12,000 characters (`agent-config-paths.test.ts`) |
| Reviewer eval | every case passes | `scripts/__tests__/reviewer-eval.test.ts` fails while the recorded run is older than the reviewer instructions |

Delivery metrics (lead time, change failure rate) stay in `dora:report`.

### Gate retirement (doc 36 G2, 2026-10-11)

A gate stage costs every run its seconds and its false positives. A stage that never stops a
run has to justify those costs, or go.

- **Input:** `npm run agent:scorecard -- --days 60`. Each stage with 0 catches is marked by
  `retirementReview()` in `scripts/agent-system/scorecard.mjs`:
  - `candidate`: the stage ran for the whole window and caught nothing.
  - `exempt`: the stage is never proposed.
  - `too new`: its first recorded run falls inside the window, so its 0 is not yet evidence.
- **Exempt by name:** `check:rules` (money and Server Action rules), `check:server-actions`
  (auth), `check:migrations` and `db:check` (migrations), and any stage whose name says secret,
  money, credit, billing, auth or migration (`RETIREMENT_EXEMPT`). Gitleaks and the secret guards
  run outside `gate:quick` and are never in the review. Retiring an exempt check stays an owner
  decision (AGENTS.md §12).
- **Retiring a candidate** is a reviewed PR whose description quotes the scorecard output. It
  does one of three things:
  - removes the stage;
  - moves it to `gate:full` or CI, where its cost is lower;
  - records why it stays: a stage can catch nothing because it already works by deterrence
    (`check:fonts` keeps a banned font out). That reason must name what would return without it.
- **A stage is not retired for being slow or noisy.** Those are S3/S4 friction defects, fixed in
  place.
- **Cadence:** every 60 days. The first review is due **2026-12-10**, 60 days after M1 began
  attributing runs. On 2026-10-11 the review listed no candidate: every 0-catch stage was
  `exempt`, or `too new` because the shared timing log starts on 2026-10-08.

### Complexity budget (doc 36 G1, 2026-10-11)

`scripts/agent-system/check-complexity-budget.mjs` runs in `check:control-plane` and holds three
counts to `agent-system/budgets.json` `complexity`:

| Count | What it measures |
|---|---|
| `npmScripts` | entries in `package.json` `scripts` |
| `scriptsLines` | lines in files under `scripts/`, including new files git does not ignore |
| `startupBytes` | the files every tool loads at session start (the scorecard's `STARTUP_FILES`) |

- A count over its budget fails the gate.
- A count under its budget passes. `--update` locks the cut in, and only ever lowers a budget.
- Growing a budget takes `--raise` in a commit whose message carries `Budget-Raise: <reason>`. The
  check reads every commit since `origin/develop` that raised a value, and fails one without the
  trailer, so the pre-push `gate:quick` catches it.
- The budgets were baselined on 2026-10-11 at the values measured after doc 36's own additions.
  Doc 36's audit put scripts/ at 54,713 lines, and this branch added about 1,800 more (tests
  included).
- Doc 36's exit is that the quarter ends with each count at or below its baseline.

### Coverage per tool

| Check | Claude | Antigravity | Codex · Cursor · Copilot |
|---|---|---|---|
| Command guard | secret reads, `main` pushes, staged secrets: Bash PreToolUse hooks in `.claude/settings.json` (the secret-read guard also runs on PowerShell); destructive git: `permissions.deny` | secret reads and the commit trailer: `antigravity-command-guard.mjs` on `run_command`; `main` pushes and staged secrets fall to `.githooks/` and the rulesets | none locally; pre-commit + CI (Gitleaks) |
| File-tool secret read | `permissions.deny` `Read()` rules | `antigravity-read-guard.mjs` on `view_file\|grep_search` (doc 36 S2) | none; secret-free worktree |
| Write guard (main checkout and secret paths denied) | hook, plus `Edit()` denies | hook (`evaluateWrite` denies a secret path since doc 36 P1) | none locally; pre-commit + branch rulesets |
| Preflight route | UserPromptSubmit hook | PreInvocation hook | `node scripts/task-preflight.mjs` by hand |
| Stop evidence (related tests, `tsc`, receipts) | Stop hook | Stop hook | pre-push `gate:quick` + CI |
| Hard rules, ship gate, rulesets | `.githooks/` + CI, for every tool and human | | |
| Tool attribution (doc 36 M1) | `prepare-commit-msg` reads `CLAUDECODE`/`AI_AGENT` | the command guard denies a `git commit` without `--trailer "Agent-Tool: antigravity"` | set `AGENT_TOOL`, else untagged |

**Parity suite (doc 36 P1, 2026-10-11).** `scripts/__tests__/provider-parity.test.ts` proves the
Claude and Antigravity columns above from the committed wiring (`.claude/settings.json`,
`.agents/hooks.json`, `.githooks/`, `agent-system/providers.json`). Every active control with a
`hook:` mechanism, plus AGT-01, must declare its coverage for both tools, and each claim must hold;
a new hook control fails the suite until it does. It also runs both write adapters to show that each
denies the main checkout and a secret path, checks that both Stop hooks run `evaluateStop` within
300 s, and checks that every adapter is wired. It names the config files, so `gate:quick` selects it
whenever one of them changes.

**Attribution (doc 36 M1, 2026-10-11).** `.githooks/prepare-commit-msg` runs
`scripts/agent-system/commit-trailer.mjs`, which adds an `Agent-Tool: <tool>` trailer from
`scripts/lib/agent-tool.mjs` `detectTool()`: `AGENT_TOOL` first, then Claude's `CLAUDECODE` /
`AI_AGENT`. It is telemetry: it never blocks a commit and leaves an existing trailer alone. Antigravity
exports no variable a git hook can read (`ANTIGRAVITY_CLI_ALIAS` is machine-wide), so its command
guard requires the trailer on the command line instead. `gate.mjs` records the same `tool` field in
`gate-timings.jsonl`. A human commit stays untagged.

Source: `agent-system/hooks.json` declares hooks for `claude` and `antigravity` only. Tools without
lifecycle hooks are caught at commit, push and CI, later and more expensively, never not at all.

### Lanes and risk

`resolve-task.mjs` scores touched paths first: the riskiest path route is the floor, and request
wording can only raise it (a "typo" in `lib/config/constants.ts` is still money). `minor-change`
(R1) covers wording-only edits. `exec-review.mjs` then picks the lane: **fast-track** R0–R1,
**standard** R2 (specialist, evidence, review, and one stated riskiest assumption, no template),
**strategic** R3+ (cited assessment plus a `## Pre-mortem`: failure story, blast radius with
`file:line`, detection, rollback; `--check --pre-mortem` exits non-zero on a blank field). The
pre-mortem follows Klein, "Performing a Project Premortem", HBR, 2007.
A route can override the risk lane: `control-plane-change` carries `"lane": "control-plane"`, an
R3 lane that keeps the CTO option record and the pre-mortem but waives the CPO market source and
the release checklist, which have nothing to cite for a hook or a gate (`--check --lane
control-plane`; 2026-10-08). Its review is the cited `self-review`, owed once per PR.

### Reviewer eval

`agent-system/fixtures/reviewer-eval.json` holds six seeded-defect diffs (missing `auth()`, literal
credit cost, skipped money test, unscoped query, prompt edit with no bump, a clean diff that reopens
§A #55) and one clean control, which catches a reviewer that blocks everything. One reviewer call
answers all of them (`--prompt`); `--score` grades deterministically and `--record` stamps the hash
of `agent-system/instructions/reviewer/_shared.md`. Edit those instructions and the hash-lock test
fails until the eval is re-run. The reviewer's ceiling in `agent-system/budgets.json` is 7,000
characters.

### Freshness and retirement

The weekly `.github/workflows/freshness.yml` run (`scripts/check-source-freshness.mjs`) now
measures three registries into its one `docs-freshness` issue: volatile documents, vendor
sources (`agent-system/sources.json`, `source:` rows) and active skills
(`agent-system/skills.json`, `skill:` rows; TTL by provenance in `scripts/lib/freshness.mjs`:
90 days vendored or provider-native, 180 first-party). A source with no recorded verification
reads as expired. Skills quarantined for over 60 days are listed as retirement candidates;
the issue proposes, the owner deletes.

A source's `lastVerified` must carry `verifiedFrom`, a page under its `origin`
(`scripts/__tests__/freshness.test.ts`, so CI fails a bare date bump). The session that
re-reads the page also records `npm run research:capture`; that receipt lives in local state,
so CI cannot check it, and `verifiedFrom` is the part a machine can hold.

### Worktree env

`scripts/lib/load-env.mjs` `loadDevEnv()` finds `.env.local` in the current checkout or the main
one (through the git common dir), in memory only. It never loads `.env` (production values) and
never overrides a set variable. `env-loading.test.ts` fails on any cwd-relative or default
`dotenv` load in the repo.

## Moved from `AGENTS.md` §9 — what runs automatically (2026-10-03, doc 34 W1)

Moved verbatim so `AGENTS.md` stays small; `AGENTS.md` §9 keeps a summary and points here.

Guardrails run deterministically **for every tool and human**, not just Claude. Full detail: `docs/engineering/agent-enforcement.md`.

**Universal** — committed `.githooks/` (self-installed by `npm ci` via `prepare`); **every gate has a CI backstop, so a `--no-verify` commit can't bypass it:**

- **pre-commit** blocks: staged secrets (`service_account*.json`, `.env*` except `.env.example` — `scripts/guard-secrets.mjs`) · hand-edited migrations (`lib/db/migrations/**`) · `check:rules --staged` (402-paywall, `defineRelations`, `BLOCK_NONE`, Gemini outside repo) · vault lint · agent parity (`scripts/check-agent-parity.mjs`). Prints prompt eval reminder on staged prompts.
- **pre-push**: blocks non-develop push to `main` (`guard-main-push.mjs`); instant if the pushed commit passed `gate:quick`, else runs it (clean worktree if dirty).
- **CI** (`.github/workflows/`): runs all hook checks plus Gitleaks, lint, tests, `db:check`, mirror-drift.
- Per-tool mirrors regenerate from `agent-system/rules-digest.md` (`npm run gen:configs`); CI fails on stale.

**Secret boundary — write vs. read.** Git hooks provide **write/commit protection** (blocking secrets entering git). Read denial is per-provider (`permissions.deny` + `guard-bash-secret-read.mjs` PreToolUse hook on both the Bash and PowerShell tools for Claude; tests in `scripts/__tests__/secret-boundary.test.ts`). Run `npm run agent:doctor` to report provider confinement status. Details in `docs/engineering/agent-enforcement.md`.

**Threat model of the shell secret-read guard (2026-10-08).** The scanner is a *backstop
against accidental reads*. It is not a boundary against a determined agent, and it cannot be:
a script written with the Write tool and then run reads whatever it likes. What it does:
- matches literal secret names and wildcards that could expand to one (`.en*`, `*.local`);
- in bash, also scans the words bash really passes on, with quotes and backslash escapes
  resolved (`".e"nv.local`, `.e\nv.local`), and matches wildcards only on that form, so the regex
  `"^\S*\s*"` is no longer read as a path ending in `s*` (doc 36 S1, 2026-10-11);
- in bash, lets a wildcard through when it is confined to a literal directory that exists and
  holds no secret-named entry (`agent-system/*.json`), only for one simple command with no
  separator, pipe, substitution or directory change. A program that globs by itself (`rg -g`,
  `find -path`) can still match a same-named directory elsewhere; that residual is accepted;
- skips a heredoc body only for a quoted delimiter fed to a text sink (`cat > file`,
  `git commit -F -`, `-m "$(cat <<'X'`), and scans every other body;
- denies what it cannot read: `pwsh -EncodedCommand`, and `iex`/`Invoke-Expression`/
  `[scriptblock]::Create` on the PowerShell tool.

The real boundaries are elsewhere:
- no long-lived key on disk (keyless GCP via ADC impersonation, `docs/ops/15-setup-runbook.md`);
- `Read` deny rules for the file tools;
- an OS sandbox, which on Windows needs WSL2 (follow-up).

A bare `*`/`.*` is deliberately not flagged; that would block every listing.

**Rulesets** (`.github/rulesets/`, verified 2026-09-25): `main`/`develop` PR-only, no force-push/deletion, required `Code Quality` + `Secret Scan`, no bypass; `review-required` adds code-owner approval (admin bypass on PRs). Agents push and open PRs as the App: `scripts/agent-github-app.mjs` (`docs/ops/access-and-break-glass.md` §3).

**Claude extras (`.claude/settings.json`):** secret read/write denial, main-checkout write denial (worktree-only, also Antigravity), `main`-push guard, destructive-git containment (`push`, `reset --hard`, `clean`, `rebase` require confirmation), migration edit-denial, prompt eval reminder, shell secret-read guard (`guard-bash-secret-read.mjs`, on Bash and, with `--powershell`, on PowerShell), and read-only mutation guard (`guard-readonly-agent.mjs` for auditor/scout/qa). Shared: `.claude/settings.json`, `.claude/skills/`, `.githooks/`. **If a guardrail blocks you, you're about to break a §4 rule — stop and rethink, don't work around it.**

## Moved from `AGENTS.md` §11 — tool portability (2026-10-03, doc 34 W1)

Moved verbatim; `AGENTS.md` §11 keeps a summary and points here.

This is an **[AGENTS.md-standard](https://agents.md)** file — Codex, GitHub Copilot's coding agent, Cursor, Windsurf, Jules, VS Code, and most 2026 tools read it natively. Entry points (thin pointers — never duplicate rules into them):

| Tool | Reads | Extras |
|---|---|---|
| Claude Code | `CLAUDE.md` → imports this file | `.claude/` (subagents, skills, hooks) |
| Codex CLI | this file natively (chained root→cwd, 32 KiB cap, `AGENTS.override.md` supported) | skills in `.agents/skills/` · subagents in `.codex/agents/*.toml` · MCP in `.codex/config.toml` |
| Antigravity | `GEMINI.md` → this file natively → `.agents/rules/*.md` (generated mirror, applied last; legacy `.agent/rules/*.md` still generated during migration) | skills in `.agents/skills/` (shared with Codex, including `ship-gate`, `plan-check`, `config-selftest`) · hand-authored domain rules in `.agents/rules/` · hooks in `.agents/hooks.json` · MCP in `.agents/mcp_config.json` |
| Cursor | this file natively | project subagents in `.cursor/agents/*.md` |
| Copilot coding agent / IDE chat | this file or `.github/copilot-instructions.md` | custom agents in `.github/agents/*.agent.md` |
| Windsurf / Jules / VS Code | this file natively | — |
| Gemini CLI | `GEMINI.md` → imports this file | — |

*(Two traps — Antigravity's 12,000-character rule-file limit and `.agents/` vs legacy `.agent/` — are in `docs/engineering/agent-enforcement.md`.)*

**Parity contract** — everything here binds every tool; the machine-checkable rules are enforced identically by the git hooks + CI (§9), and the per-tool mirrors regenerate from the rules digest (`agent-system/rules-digest.md`), so no tool reads stale rules. The heavy lifting lives in **npm scripts, not Claude skills**, so every tool and model size shares the tooling: `npm run gate | eval:prompts | webhook:simulate | credits:set`. The `.claude/skills/*/SKILL.md` files are readable how-to docs — read them even without a skill mechanism. Two things vary by tool:
- **Subagents** (§10) use provider-native adapters where supported: Claude `.claude/agents/`, Codex `.codex/agents/`, Antigravity `.agents/agents/`, Copilot `.github/agents/`, and Cursor `.cursor/agents/`. Other tools run the matching checklist inline. Adapter presence is structural evidence only; it does not prove a provider loaded or obeyed the role.
- **Web access**: if your tool can't verify vendor facts (billing, auth, AI gateway) against current docs, say so instead of guessing — unverified vendor assumptions are this repo's worst historical bug source.

<!-- BEGIN:nextjs-agent-rules -->

## Moved from `AGENTS.md` §2 — full command list and ship-gate notes (2026-10-03, doc 34 W1)

```bash
npm run dev      # dev server (Turbopack); `predev` blocks it inside a worktree
npm run dev:worktree -- --port 3100  # dev server inside .worktrees/<id> (webpack, parent env in memory)
npm run test:task  # while working: tests for uncommitted changes
npm run gate:quick # LOCAL BAR: static checks (parallel, GATE_PARALLEL=0 for serial) + types + changed tests. Lint/build are CI's.
npm run gate     # the same plus lint and build (~5min) — before opening a PR
npm run gate:full # every check, unscoped — what CI runs
npm run build    # production build only
npm run lint     # ESLint + Stylelint (zero-error policy; Stylelint advisory)
npm test         # Vitest — app/ components/ lib/ scripts/ infra/
npm run critique # deterministic rendered measurement (contrast, truncation, tap size, overflow)
npm run agent:doctor       # report agent capability health (skill provenance, secret confinement)
npm run check:server-actions # verify exported Server Actions authenticate callers
npm run check:ownership    # verify every query on a user-owned table names the owner
npm run check:control-plane # manifest schema, graph invariants, skill integrity, adapter drift
npm run agent:generate     # regenerate provider agents from agent-system/agents.json
npm run agent:task "<req>" # route, specialist, skills, and evidence needed for request
npm run exec:review "<req>" # lane (fast-track R0-R1 / standard R2 / strategic R3+ / control-plane) + the brief; --check <file> [--pre-mortem] enforces citations; --review prints the reviewer's role lenses
npm run eval:reviewer -- --prompt  # seeded-defect reviewer eval; --score <file> [--record] grades one reviewer run
npm run agent:scorecard   # agent-loop health against the "Scorecard" targets below
npm run agent:worktree <id> # isolated worktree, node_modules shared by junction; --cleanup <id> to remove
npm run agent:evidence     # inspect required evidence for changed paths
npm run evidence:record -- <id>  # record evidence receipt; --base <ref> receipts committed work against `git diff <ref>`
npm run evidence:check     # verify required evidence receipts match current file sha256
npm run skills:sync -- --write  # re-pin skill integrity hashes
npm run skills:mirrors     # regenerate skill discovery mirrors
npm run eval:prompts       # doc 16 §7 prompt eval (DRY by default, zero model calls)
npm run docs:write         # regenerate every generated doc in the one order that converges
npm run docs:check         # scripts/docs-check.mjs runs the named steps of scripts/lib/docs-steps.mjs (`--list`): generated-doc drift, doc lifecycle, vault lint, rule mirrors, check-doc-drift, then check-doc-refs (a backticked path in a live doc that no longer exists blocks unless it is in scripts/doc-refs.baseline.json, which only shrinks: `--update`; doc 36 C4). A failure names its step and fix; gate runs each step as its own `docs:check › <id>` stage (doc 36 S4)
npm run webhook:simulate   # sign + send test webhook
npx drizzle-kit generate   # create migration from lib/db/schema.ts
npm run db:migrate         # apply committed migrations to a LOCAL database
# NEVER `drizzle-kit push` — no migration history, no rollback, silent data loss (INF-05).
# Production: run the manual `db-migrate` Action — typing "production" IS the gate, since
# required reviewers need Enterprise on a private repo. `npm run db:applied` shows pending.
```

**Ship gate, cheapest first.** `npm run test:task` while you work. `npm run gate:quick` is the **local bar** before committing: static checks, `tsc`, and the tests affected since your last green run; the pre-push hook enforces it. It skips `lint` and `build` (measured: `lint` alone costs more than all static checks; CI runs both). `npm run gate` adds them back, before a PR. `npm run gate:full` is unscoped, as in CI.

**A latency trade, not a coverage one — it holds only because CI is complete.** `ci.yml` runs every static check, lint, `tsc`, the full Vitest suite, the carousel critique and the build. `ci-backstop.test.ts` fails if a gate exists locally with no CI step: a local-only check is skipped by `--no-verify`.

**What scoping cannot do:** it walks the import graph (plus tests reading a changed file), so it cannot see a test pinning a count or a name you did not touch. **Change a pinned value or a manifest → grep for what pins it and run those files directly.**

## Moved from `AGENTS.md` §10 — specialist roster detail (2026-10-03, doc 34 W1)

**Generated, not hand-authored.** Adapters are pure output, emitted by `npm run agent:generate` from `agent-system/agents.json` and `agent-system/instructions/<agent>/` (prose). `_shared.md` is the **normative contract emitted verbatim to every provider**. Edit `agent-system/instructions/`, never an adapter: `npm run check:control-plane` verifies parity and fails on hand-edits.

### The roster since doc 34 W5 (2026-10-03)

The main session builds every change inline. `agents.json` records two kinds of agent that
get no adapter, marked by `runtime` (`scripts/agent-system/agent-kinds.mjs`):

- **`builder`** (`runtime: main-session`) — the user's own session. It holds the write,
  schema, prompt, paid-model and money capabilities, so routes, the capability graph and
  evidence actors still resolve; it loads the route's `requiredSkills` instead of being a
  preloaded specialist.
- **`explore`** (`runtime: built-in`, read-only) — high-volume search. On Claude it is the
  provider's built-in `Explore` subagent; tools without one search inline.

Domain knowledge the retired specialists carried now lives in four first-party skills, each
mirrored to `.agents/skills/` and integrity-pinned: `ui-work`, `backend-work`, `money-path`,
`ai-pipeline`. The routes name them (`agent-system/routing.json`): `ui-change` loads
`ui-work` + `web-design-guidelines`; `backend-change`,
`schema-migration` and `publishing-change` load `backend-work`; `money-change` loads
`money-path` + `verify-money-path`; `prompt-change` loads `ai-pipeline` + `prompt-eval`.

Generated subagents (adapters for every provider they claim):

- **`reviewer`** (read-only, shell guarded by `scripts/guard-readonly-agent.mjs`, memory, `omitClaudeMd`; was `rule-auditor` until doc 34 W4, 2026-10-03) — the one fresh-context reviewer. Gets the review packet (`npm run review:pack`: base, head, files, checklist ids, diff) and the task spec; answers every checklist id with a quoted `file:line` within `maxTurns: 25`, fixes nothing, never re-runs the gate, and returns the answer for the caller to record with `npm run review:check -- <file> --actor reviewer`. Owed once per PR by R2+ paths (money, auth, prompts, schema, migrations, Server Actions); the receipt proves the review ran on that content, not that a BLOCK was acted on.

**Cited review, once per PR (2026-10-08).** 42 fresh-context reviews cost a median 2.3M (max 13.9M) context tokens each, nearly all of it rebuilding the diff and re-running checks the gate had proved, and receipts went stale on every edit because Stop enforced them. Now:
- `review` (money, auth, prompts, AI-output guards, schema, migrations, Server Actions, and the security boundary: `scripts/guard-*.mjs`, `hook-fail-closed.mjs`, `.claude/settings.json`, `.githooks/`, the replay runner's push and billing block (`scripts/agent-system/replay.mjs`), and the review enforcement in `evidence.json`, `review.mjs`, `evidence-receipt.mjs`, `check-evidence.mjs`) is signed by `reviewer`. A citation check proves a quote exists, not that a session judged a guard that constrains it fairly. `self-review` (the rest of the control plane: gate, test selection, CI, routing and other manifests) is signed by the main session, which already holds the context. `review:check` refuses `main-session` on a `review`.
- Both are `phase: "pr"`: Stop skips them; `.githooks/pre-push` runs `check-evidence --enforce --pr` against the merge-base with `origin/develop`.
- What stops a self-review from being an unchecked "looks good" is `scripts/agent-system/review.mjs check`: every checklist id answered (`ok` / `finding <Severity>` / `n/a: <reason>`); every `ok` and `finding` quotes text found within 3 lines of a cited line in a file of the change; `PASS` is refused beside a Critical or High finding. Only a passing check is recorded, and `evidence-receipt record` refuses a `citedReview` type without one.
- A `BLOCK` is recorded but reads as stale, so it never clears pre-push; after the fix, `review:pack -- --delta` diffs only from the reviewed commit and carries the earlier findings.
- Tests: `scripts/__tests__/review-check.test.ts`.
- **`content-growth-strategist`** (read-only, no shell/write/publish/deploy authority) — content strategy, positioning, creator workflows, channels, lifecycle, growth experiments. Opens `content-growth-intelligence`, returns claim-level consultation packets.

Retired in W5 and deleted from the manifest (git history keeps them): `ui-engineer`,
`backend-engineer`, `ai-pipeline-engineer`, `billing-integrity-engineer`,
`qa-runtime-engineer`, `repo-scout`. The UI taste memory stays at
`.claude/agent-memory/ui-engineer/`, which `ui-work` reads.

## Repository Architecture File Map

| What | Where |
|---|---|
| Application entrypoint | `src/index.ts` |
| Application unit tests | `src/__tests__/*` |
| Agent control plane (manifests) | `agent-system/*.json` |
| Specialist instructions | `agent-system/instructions/` |
| Universal hard rules & gates | `scripts/lib/hard-rules.mjs` · `scripts/gate.mjs` |
| Git hooks & safety barriers | `.githooks/*` · `scripts/guard-*.mjs` |
| Stack configuration | `config/stack.config.json` |
| Living knowledge vault | `vault/` — entry: `vault/_START-HERE.md` → `vault/Active-Context.md`. Lint: `node scripts/check-vault.mjs` |

*(**Superseded 2026-10-03, doc 34 W1/W2:** the size trap above is closed. Antigravity's docs now state 24,000 bytes per rule file and a 20,000-token budget for always-on rules, and confirm `AGENTS.md` is always loaded ([rules](https://antigravity.google/docs/rules)). `AGENTS.md` §1–§8 fit in 12,000 characters (`agent-config-paths.test.ts`), and `evidence-discipline.md` and the digest mirror are `trigger: model_decision`, so no rule file is always-on.)*
