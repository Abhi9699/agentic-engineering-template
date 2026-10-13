---
type: architecture
status: active
tags: [architecture, core, template]
related: [_START-HERE, Decisions, Conventions]
last-updated: 2026-10-12
last-verified: 2026-10-12
source: [AGENTS.md]
confidence: Confirmed
---

# System Architecture

Hub index: [[_START-HERE]].

This document outlines the core architecture and design topology for products developed with this template.

```mermaid
graph TD
    User([User / Client Boundary]) <--> SecurityBoundary[Security Perimeter & Auth Middleware]
    SecurityBoundary <--> AppCore[Application Core / Business Logic]
    AppCore <--> DataAccess[Data Access & ORM / Repository Layer]
    AppCore <--> AIGateway[AI Gateway & Prompt Registry]
    
    subgraph AgentHarness [Agentic Control Plane]
        Governance[AGENTS.md Single Source of Truth] --> HardRules[AST Hard Rules & Invariants]
        Governance --> RiskRouter[Executive Risk Review R0-R4]
        Governance --> GateLadder[Pre-Commit & Ship Gates]
        Governance --> LivingVault[Living Knowledge Vault]
    end

    AppCore -. Checked By .-> AgentHarness
```

## Architectural Layers

1. **Client / Presentation Layer:**
   - Server-first components with interactive leaves at the UI boundary.
   - Design token discipline: all styling derives from tokens, never arbitrary raw values.
   - Accessible by default (WCAG 2.2 AA).

2. **Application Core (`src/`):**
   - Strictly typed TypeScript modules (target <= 400 lines per module).
   - Validation at every external boundary using Zod or equivalent declarative schemas.
   - Fail-closed error envelopes.

3. **Data Access Layer:**
   - Explicit queries, tenant/ownership isolation on all tables.
   - Deterministic migrations.
   - All list queries bounded with pagination.

4. **AI Pipelines & Model Gateway:**
   - Prompts live exclusively in versioned registries.
   - Untrusted inputs escaped and delimited.
   - Model gateway manages rate limits, fallbacks, and cost ceilings.

5. **Security & Anti-Regression Perimeter:**
   - Commit and push hooks verify secret boundaries and code invariants before code leaves the developer machine.
   - Every regression is recorded in [[_Lessons]] with an automated machine gate that prevents recurrence.

## Related ADRs & Conventions

- Architectural Decisions: [[Decisions]]
- Engineering Conventions: [[Conventions]]
- Current Implementation Status: [[Active-Context]]
