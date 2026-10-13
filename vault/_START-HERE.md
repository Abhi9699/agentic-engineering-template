---
type: hub
status: active
tags: [hub, meta]
related: [Active-Context, Architecture, _Lessons, Decisions, Conventions, Glossary, Open-Questions, _CHANGELOG]
last-updated: 2026-10-12
last-verified: 2026-10-12
source: [AGENTS.md]
confidence: Confirmed
---

# 🧭 START HERE — Knowledge Vault

This vault is the **living project memory**: the single source of truth for architectural maps, ADRs, anti-regression lessons, and active context.

## Core Hubs

- [[Active-Context]] — Current focus, recent changes, next steps
- [[Architecture]] — System architecture topology, layers, and service boundaries
- [[_Lessons]] — **Anti-Regression Lessons Ledger**: every defect encountered and the automated machine gate that catches it
- [[Decisions]] — Architecture Decision Records (ADRs)
- [[Conventions]] — Project and engineering conventions
- [[Glossary]] — Canonical project terminology
- [[Open-Questions]] — Unresolved design questions requiring owner review
- [[_CHANGELOG]] — Living changelog of system iterations

## Operating Principles for Agents

1. **Ground every claim:** Every assertion must cite a live file path (`file:line`) or official specification.
2. **Update on change:** When a change alters system behavior or architecture, update the corresponding vault note in the same change.
3. **Decisions are binding:** Approved decisions in [[Decisions]] are final; do not re-litigate without explicit owner instruction.
