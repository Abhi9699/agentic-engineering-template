# Autonomous Agentic Engineering Architecture & Template

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Multi-Agent](https://img.shields.io/badge/Architecture-Multi--Agent_Control_Plane-success.svg)](#)
[![Gates](https://img.shields.io/badge/Ship_Gate-34%2F34_Probes_Biting-brightgreen.svg)](#)

A production-grade, multi-agent control plane and software engineering operating system designed for building mission-critical software products with AI coding agents (Claude, Codex, Antigravity, Cursor, Copilot).

Built from thousands of hours of production multi-agent pair programming, this architecture transforms probabilistic LLMs into deterministic, high-reliability engineering teams.

## Core Architectural Pillars

### 1. Unified Multi-Provider Control Plane (`agent-system/`)
- Single Source of Truth Manifests in `agent-system/`
- Zero Agent Drift via automated adapter emission (`npm run agent:generate`)
- Cognitive Context Budgets enforced per agent and provider (`budgets.json`)

### 2. Planted-Failure Self-Test Engine (`self-test.mjs`)
- 34/34 Synthetic Defect Probes verify that all gates reject bad inputs before code runs
- Complete schema, graph, and manifest consistency checks

### 3. Executive Advisory Mandate (`exec-review.mjs`)
- Automated risk routing (R0 to R4)
- C-Suite advisory briefs (CTO, CPO, CISO, CFO, Legal, AIQuality, Data, DevOps)
- Mandatory pre-mortem analysis for strategic changes

### 4. Living Anti-Regression Knowledge Vault (`vault/`)
- Bidirectional knowledge graph of ADRs, lessons, and conventions
- Anti-Regression Ledger (`_Lessons.md`) with automated machine test proofs (`npm run prove:gates`)
- Pre-configured Obsidian integration with color-coded architectural graphs

### 5. Multi-Layer Security & Secret Confinement
- Git hook perimeter blocking staged secrets and gate bypasses
- Strict read confinement ensuring `.env` and credentials are never read

### 6. Polyglot Readiness
- Configured out of the box for TypeScript, with modular profiles ready for Python services

## Quickstart

```bash
# 1. Install dependencies and activate git hooks
npm install

# 2. Verify control plane manifests and run self-tests
npm run agent:validate
npm run agent:selftest

# 3. Run the ship gate ladder
npm run gate:quick
```

## Building a New Product with this Template

This repository provides an autonomous engineering operating system and multi-agent harness for building mission-critical software products.

### 1. Configure Your Stack (`config/stack.config.json`)
Declare your source code directories, runtime version, and test runners:
```json
{
  "primaryLanguage": "typescript",
  "version": "5.x",
  "runtime": "node >=24",
  "scanDirs": ["src"],
  "testRunner": "vitest",
  "commands": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

### 2. Connect Your Living Obsidian Vault
Open this repository or the `vault/` directory in **Obsidian**:
- **Interactive Knowledge Graph:** Pre-configured color groups highlight Hubs (Indigo), Architecture (Cyan), Decisions/ADRs (Amber), Lessons Ledger (Emerald), and Open Questions (Rose).
- **Single Source of Truth:** `vault/_START-HERE.md` anchors the bidirectional link graph. Update living notes when architectural changes land.
- **Automated Vault Governance:** `npm run check:vault` ensures 100% link integrity, metadata validity, and zero broken citations.

### 3. Develop with AI Agent Harnesses
Multi-IDE agent configurations stay in exact sync across:
- **Google Antigravity:** Native `.agents/` and `.agent/rules/`
- **Claude Code:** `CLAUDE.md` and `.claude/`
- **OpenAI Codex:** `.codex/`
- **Cursor & Copilot:** `.cursorrules` and `.github/copilot-instructions.md`

Run `npm run agent:generate` whenever you adjust specialist roles or instructions in `agent-system/`.

### 4. Enforce Quality & Anti-Regression Gates
- **`npm run gate:quick`** — Fast local bar before committing (AST rules + vault + types + tests).
- **`npm run gate`** — Full ship gate required before opening a PR.
- **`npm run prove:gates`** — Mutation test runner that re-proves all recorded lessons in `vault/_Lessons.md` still bite.

## Command Reference

| Command | Description |
|---|---|
| `npm run gate:quick` | Local fast gate (static rules + vault + types + tests) |
| `npm run gate` | Full comprehensive gate ladder |
| `npm run agent:validate` | Validates all manifests against JSON schema |
| `npm run agent:selftest` | Executes all 34 planted-failure behavioral probes |
| `npm run agent:generate` | Generates all agent adapters and mirrors |
| `npm run check:vault` | Audits vault link integrity and freshness |
| `npm run check:rules` | Scans source code against security invariants |
| `npm run check:doc-drift` | Verifies documentation references against live code |
| `npm run check:controls` | Verifies OWASP ASVS control point compliance |
| `npm run check:tokens` | Validates design token discipline |
| `npm run check:line-caps` | Ensures module size caps (<= 400 lines) |
| `npm run prove:gates` | Validates that recorded lessons bite against regressions |
| `npm run exec:review` | Generates C-suite advisory briefs and pre-mortems |

## License
MIT