# Security Policy

## Supported Versions

We actively maintain and provide security updates for the latest release on the `main` branch.

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0.0 | :x:                |

---

## Zero-Trust Architecture & Confinement Model

This repository enforces strict defensive security invariants designed for autonomous and semi-autonomous AI engineering:

1. **Secret Confinement**:
   - Environment files (`.env*`) and sensitive credentials are gitignored and protected by pre-commit hooks (`guard-secrets.mjs`).
   - Provider-native read denials prevent AI harnesses from inspecting credentials or local private configurations.
   - Any commit attempting to add secrets is blocked before leaving the developer workstation.

2. **Mutation Verification**:
   - Every backend mutation must verify caller authentication and assert strict tenant and resource ownership.
   - Cryptographic comparisons must use timing-safe functions (`crypto.timingSafeEqual`) to prevent timing attacks.

3. **Planted-Failure Defect Probes**:
   - The harness maintains 34/34 synthetic defect probes (`npm run agent:selftest`) ensuring that broken security invariants fail-closed before runtime execution.

---

## Reporting a Vulnerability

We take the security of this project seriously. If you discover a security vulnerability or potential flaw in our control plane, gate engine, or secret confinement perimeter, please report it responsibly.

### How to Report
Please **DO NOT** report security vulnerabilities via public GitHub issues.

Instead, please submit a report through **GitHub Private Vulnerability Reporting**:
- Go to the repository [Security Advisories](https://github.com/Abhi9699/agentic-engineering-template/security/advisories) tab.
- Click **"Report a vulnerability"**.

Alternatively, if private reporting is unavailable, reach out directly to the maintainer via the email associated with the GitHub account (`Abhi9699`).

### What to Include
To help us triage and resolve the issue quickly, please include:
- A clear description of the vulnerability.
- Steps to reproduce or a minimal proof of concept (PoC).
- The affected component (e.g., git hooks, control plane manifest validator, CI workflow).
- Any potential impact on secret confinement or execution security.

---

## Response Timeline

- **Initial Acknowledgment**: Within 48 hours of receipt.
- **Triage & Assessment**: Within 5 business days.
- **Patch & Advisory**: Once verified, a security patch will be prepared and merged into `main` with an accompanying advisory.
