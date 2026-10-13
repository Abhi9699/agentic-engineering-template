---
name: plan-check
description: Run before writing or accepting an implementation plan. Validates schema counts, greps for existing implementations, computes metrics, checks component props, cites market facts, and enforces AGENTS.md rules.
---

# Plan check

Run before writing or accepting an implementation plan. Every step is a file to open, not
a fact to recall — a plan reviewed on 2026-08-22 carried five defects, and all five were
findable by reading the repository.

0. **Read `vault/_Lessons.md`.** Every defect this project has already made, and the gate
   that now catches it. The OPEN entries are the ones nothing catches yet — if the plan
   touches one, it inherits that risk and must say how it avoids it.
1. **Open every schema or enum the plan describes.** State counts from the file, never
   from memory. (`lib/validation/*.schema.ts`, `lib/db/schema.ts`)
2. **Grep for anything the plan proposes to build.** If it already exists, the plan is an
   extraction, not a new module — two implementations drift.
3. **Compute every number.** Contrast with `contrastRatio()`; cost from
   `ai_generations_log`; size with `wc -c`. An estimated ratio or price is usually wrong.
4. **Check the props of any component the plan touches**, and the fields any editor binds.
   Do not invent a signature.
5. **Delete or cite every market statistic.** Publisher and date, or it does not appear.
6. **Name the verification that can actually see the change.** Unit tests cannot see a
   rendered slide, a PDF, or a screen. If the change is visual, the plan must include a
   rendered check.
7. **Confirm the plan updates `docs/` and `vault/`** in the same change.
8. **Stage the work.** One component through one theme, verified end to end, before
   fanning out. A sixteen-file landing has no checkpoint.
9. **Check `AGENTS.md` §4** for a rule the plan would break, and `docs/OPEN_QUESTIONS.md`
   §A for a decision it would re-litigate. §B items are stop-and-flag, never guess.
