# Contributing to Autonomous Agentic Engineering Template

Thank you for your interest in contributing! This project is an autonomous software engineering operating system and control plane designed for high-reliability software development with AI agents and human engineers.

To maintain deterministic quality and prevent regressions, all contributions follow strict engineering gates and conventions.

---

## 1. Code of Conduct

All contributors and maintainers are expected to adhere to our [Code of Conduct](CODE_OF_CONDUCT.md). By participating in this project, you agree to uphold its standards.

---

## 2. Development Setup

### Prerequisites
- **Node.js**: `>= 24.0.0` (ESM native)
- **npm**: `>= 10.0.0`
- **Git**: `>= 2.40.0`

### Initial Setup
```bash
# Clone your fork
git clone https://github.com/Abhi9699/agentic-engineering-template.git
cd agentic-engineering-template

# Install dependencies and link git hooks
npm install

# Verify setup and control-plane integrity
npm run check:control-plane
npm run agent:selftest
```

The repository configures Git hooks automatically via `npm run prepare` (`.githooks/`). These hooks verify:
- Secret confinement (preventing accidental `.env` or credential staging).
- Direct push restrictions to `main`.
- Quick gate validation before commits.

---

## 3. Branching & Release Strategy

We follow a disciplined trunk-based branch model:
- **`main`**: Production release branch. Protected against direct pushes. Changes land in `main` exclusively through Pull Requests with passing CI (`Ship Gate`).
- **`develop`**: Primary integration branch. All feature branches, bug fixes, and improvements target `develop`.
- **Feature Branches**: Branch from `develop` (`feat/...`, `fix/...`, `docs/...`).

```bash
# Start from up-to-date develop
git checkout develop
git pull origin develop
git checkout -b feat/your-feature-name
```

---

## 4. Hard Architectural Invariants

Every change must satisfy the load-bearing rules codified in [AGENTS.md](AGENTS.md):

1. **Strict TypeScript & Schema Validation**: Zero `any`. All external boundaries (network, I/O, AI model outputs) must be validated with Zod schemas.
2. **Never Weaken Checks**: Never use `@ts-ignore` without approved justifications. Never delete, skip, or weaken a failing test assertion to reach green.
3. **Module Caps**: Modular source files target `<= 400` lines. Decompose multiple concerns.
4. **Zero-Trust Security**: Authenticate caller identity and verify tenant resource ownership on all mutations. Use `crypto.timingSafeEqual()` for token comparisons.
5. **Zero Waterfalls & Memory Hygiene**: Parallelize independent async I/O via `Promise.all()`. Effects with event listeners or timers must return cleanup functions. In-flight requests must be abortable via `AbortController`.
6. **One Concern per PR**: Atomic commits and isolated scopes. Do not bundle unrelated refactors into a fix.
7. **Living Knowledge Vault**: If your change modifies architectural decisions or conventions, update the paired note in `vault/` within the same change.

---

## 5. Local Verification Ladder

Before committing or opening a PR, run the local verification suite:

```bash
# Local fast bar before committing (types + rules + vault + changed tests)
npm run gate:quick

# Full gate ladder (runs complete AST, control-plane, and anti-regression checks)
npm run gate

# Validate all planted-failure synthetic defect probes
npm run agent:selftest

# Verify Obsidian knowledge vault link health
npm run check:vault
```

---

## 6. Submitting a Pull Request

1. **Keep it Focused**: Ensure your PR addresses a single problem or feature.
2. **Commit Conventions**: Use Conventional Commits (`feat: ...`, `fix: ...`, `docs: ...`, `chore: ...`).
3. **Verify Locally**: Ensure `npm run gate:quick` and `npm run gate` exit `0`.
4. **Open PR against `develop`**: Provide a clear description referencing any associated issues.
5. **Pass CI**: Ensure the GitHub Actions `Ship Gate` check completes successfully.

---

## 7. Reporting Issues & Vulnerabilities

- **Bug Reports & Feature Requests**: Submit an issue using our [GitHub Issue Templates](https://github.com/Abhi9699/agentic-engineering-template/issues).
- **Security Inquiries**: Please review [SECURITY.md](SECURITY.md) for coordinated vulnerability disclosure.
