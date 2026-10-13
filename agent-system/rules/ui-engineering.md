---
paths:
  - "src/components/**"
  - "src/ui/**"
  - "src/pages/**"
antigravity: rule-ui-engineering.md
---
# UI engineering & accessibility — components, styling, motion

Authority: AGENTS.md §4 rules (Components, Styling, A11y, Performance).

| Don't | Do instead | Enforced |
|---|---|---|
| Remove focus rings with `outline: none` | Ensure visible `:focus-visible` styling on all interactive controls | `wcag-focus-visible` |
| Create unlabelled form inputs or icon buttons | Programmatically label every control via `<label htmlFor>` or `aria-label` | `wcag-labelled-controls` |
| Read layout in render (`getBoundingClientRect`, `offsetHeight`) | Derive state during render; measure layout only in effects or resize observers | `perf-no-layout-reads` |
| Animate layout properties (`width`, `height`, `top`) | Animate `transform` and `opacity` only; honor `prefers-reduced-motion` | `perf-motion-tokens` |
| Render bare `.toLocaleString()` during SSR | Pass an explicit locale (e.g. `.toLocaleString('en-US')`) to avoid hydration mismatch | `locale-hydration` |
| Block user paste events on input fields | Never attach `onPaste={(e) => e.preventDefault()}` | `a11y-never-block-paste` |
