---
name: config-selftest
description: Six falsifiable configuration probes that prove or disprove that the workspace agent configuration (rules, globs, MCP, skills, lessons) is actively loaded.
---

# Config self-test

Six probes that prove — or disprove — that this workspace's agent configuration is
actually loaded. Each has a falsifiable correct answer. Run them in a **fresh chat**, since
a session that has already discussed a topic will answer from its own history rather than
from the rules.

Record outcomes in `vault/_Lessons.md`. A probe that fails is a lesson, not a nuisance.

---

## P1 — Is the always-on rule loaded?

> **Ask:** "Can a carousel slide use ✅ or ➔?"

- **Correct:** No. A missing glyph renders as a black rectangle in the exported PDF; use a
  box, text, or `slide-marks.tsx`.
- **Fails if:** it proposes `❌ Old Way vs ✅ Pro Way`, `[ Swipe ➔ ]`, quotation glyphs or
  "checkmark pills". Measured 2026-08-22: it produced all four (see L-003).
- **Then:** `evidence-discipline` is not Always On, or is being overridden.

## P2 — Is the glob rule loaded?

> **Open `components/carousel/themes/slide-list.tsx`, then ask:** "What props should a new
> slide layout component take?"

- **Correct:** narrow, already-resolved props — `body`/`palette`/`variant`/`fontSize`/`maxWidth`.
  The theme resolves the fitted size; the component never re-derives it.
- **Fails if:** it answers `{ slide, palette, ar }`.
- **Then:** `carousel-satori` is not set to Glob, or the pattern does not match.

## P3 — Is AGENTS.md being truncated? *(currently unverified)*

> **Ask:** "List the five items in the Definition of Done."

- **Correct:** every §4 hard rule followed · ship gate green · the real user flow exercised
  and observed · money/AI changes have a Vitest suite · affected `docs/` updated in the
  same change.
- **Fails if:** it cannot answer or invents items.
- **CAVEAT (measured 2026-08-22):** this probe is weak. Antigravity passed it by *reading*
  `AGENTS.md:115-135` — so a pass proves retrieval, not that the file is in context, and
  truncation stays unverified. Treat P3 as "does it know where to look", which is the thing
  that actually matters: the risk was never that it cannot read §7, but that it does not
  think to.

## P4 — Is MCP loaded?

> **Ask:** "Which MCP servers do you have, and what does context7 do?"

- **Correct:** names `context7` (current library/framework docs). `supabase` and `posthog`
  are configured but disabled pending auth.
- **Fails if:** it reports no MCP servers.
- **Then:** `.agents/mcp_config.json` is not being read — check the MCP settings panel.

## P5 — Are skills discoverable?

> **Type:** `/plan-check` or activate the `plan-check` skill.

- **Correct:** the skill resolves and its steps run.
- **Fails if:** the skill is unknown.
- **Then:** `.agents/skills/` is not being discovered. Check `.agents/skills/plan-check/SKILL.md`.

## P6 — Is the lessons ledger reachable?

> **Ask:** "What open lessons does this repo have, and what do they mean for carousel work?"

- **Correct:** cites `vault/_Lessons.md` — L-003 (glyphs), L-004 (facts asserted not read),
  L-005 (piped gate result), L-006 (skills conflicting with §4).
- **Fails if:** it does not know the file exists.
- **Then:** the always-on rule's §0 is not reaching it; nothing compounds, because every
  session starts from zero.

---

## Two more worth checking once

- **Permissions:** ask it to run `npm run check:rules`. If it prompts for approval, strict
  mode is on — strict mode **ignores the allowlist**. Set *Always Proceed* plus a Deny list.
- **Model:** ask which model is answering. Planning and review belong on Gemini 3.1 Pro or
  Claude Opus 4.6 (thinking); Flash is for mechanical edits.
