---
type: decision
status: accepted
tags: [decision, architecture]
related: [_START-HERE, Conventions]
last-updated: 2026-10-11
last-verified: 2026-10-11
source: [AGENTS.md]
confidence: Confirmed
---

# Architecture Decision Records (ADR)

Hub index: [[_START-HERE]].

## ADR-001 — Autonomous Agentic Engineering Spine
- **Status:** Accepted
- **Context:** Software projects developed with AI pair programmers require deterministic governance, anti-regression tracking, and multi-IDE configuration parity.
- **Decision:** Establish `AGENTS.md` as the tool-agnostic single source of truth, enforced by git barriers, pre-tool hooks, AST hard-rules, and C-suite pre-mortems.
