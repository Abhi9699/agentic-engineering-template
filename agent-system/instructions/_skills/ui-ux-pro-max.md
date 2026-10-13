This is a **design-direction** engine — advisory input, not a source of truth.
`docs/product/18-design-system.md` + `app/globals.css` **win on any conflict**. The
persisted engine output at `design-system/master/MASTER.md` is advisory only: a stale
generation of it once carried an off-brand palette that misled a redesign which had to be
reverted. Use the engine for exploration and reasoning; ratify against doc 18 before you
build. This matches the load rule in `CLAUDE.md`.

Never preload it: the `SKILL.md` fronts a large CSV/Python payload meant to be queried on
demand (`scripts/search.py --design-system`), not injected at startup.
