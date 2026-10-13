## Summary of Changes
Provide a concise overview of what this pull request changes and why.

## Motivation & Context
- Fixes # (issue)
- Relevant architectural decisions or discussions:

## Verification & Gates Passed
Confirm that the required gates passed locally before submission:
- [ ] `npm run gate:quick` passed locally
- [ ] `npm run gate` passed without weakening any test assertions
- [ ] `npm run check:control-plane` passed (manifests, graph, self-tests)
- [ ] `npm run check:vault` passed (zero broken vault links, 100/100 health)

## Invariants & Compliance Checklist
- [ ] **Single Concern**: Addresses one atomic concern per PR (AGENTS.md Rule 8).
- [ ] **No Weakened Assertions**: Zero deleted or softened assertions; no `@ts-ignore` without annotation (AGENTS.md Rule 4).
- [ ] **Documentation / Vault**: Updated paired notes in `vault/` or `docs/` if architectural behavior changed (AGENTS.md Rule 10).
- [ ] **Zero Secrets**: Verified no credentials or `.env*` files are included.
