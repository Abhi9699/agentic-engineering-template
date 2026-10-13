#!/usr/bin/env node
/**
 * The repository's single definition of "this path is a secret", plus the
 * commit-time guard built on it. Shared by the .githooks/pre-commit hook
 * (every tool + human) and the Claude Code PreToolUse hook — one
 * implementation, several callers, zero divergence (spec §3 Layer 2).
 *
 * SCOPE — read this before trusting it (A-NOW item 1, AA-GAP-13):
 *   This module is **write/commit protection**. It stops a secret entering git
 *   history. It does NOT and cannot prevent an agent or process from *reading*
 *   a secret that exists on disk — that boundary is per-provider (Claude's
 *   `permissions.deny` in .claude/settings.json) or, where a provider offers no
 *   such control, only a secret-free worktree provides it. `npm run agent:doctor`
 *   reports which providers are actually confined; never claim a universal read
 *   boundary exists.
 *
 * The pattern mirrors .gitignore exactly (`.env*` ignored, `!.env.example`), so
 * there is one policy rather than two that can drift.
 */
import { pathToFileURL } from 'node:url';
import { stagedEntries } from './lib/staged.mjs';

/**
 * Any `.env`/`.env.<anything>` (`.env.local`, `.env.production`, `.env.preview`,
 * `.env.staging`, `.env.local.bak`, …) and any `service_account*.json`, at the
 * repository root or nested at any depth. Case-insensitive because Windows and
 * macOS resolve `.ENV` to the same file that Linux would treat as distinct.
 */
const SECRET = /(^|\/)(service_account[\w.-]*\.json|\.env(\..+)?)$/i;

/**
 * The one committed exception: the placeholder template that documents which
 * variables exist. It holds no values (see .gitignore `!.env.example`).
 */
const SECRET_ALLOWED = /(^|\/)\.env\.(example|sample|template|defaults?)$/i;

/** Normalize a path for policy matching: backslashes → slashes, no `./` prefix. */
export function normalizePath(p) {
    return p.replaceAll('\\', '/').replace(/^\.\//, '');
}

/**
 * Pure: is this path a secret under repository policy?
 * @param {string} p repo-relative or absolute path, either slash style
 * @returns {boolean}
 */
export function isSecretPath(p) {
    const n = normalizePath(p);
    return SECRET.test(n) && !SECRET_ALLOWED.test(n);
}

/**
 * Pure: returns normalized paths of staged secret files.
 * @param {Array<{ status: string, path: string }>} entries
 * @returns {string[]}
 */
export function findStagedSecrets(entries) {
    return entries.map((e) => normalizePath(e.path)).filter(isSecretPath);
}

/**
 * Claude Code PreToolUse body for `git commit`, run through scripts/hook-fail-closed.mjs.
 * @returns {string} a deny decision when a secret is staged, or '' to allow
 */
export function hookMain() {
    const hits = findStagedSecrets(stagedEntries());
    if (!hits.length) return '';
    return JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Secret file staged (${hits.join(', ')}). Unstage it (git restore --staged <file>) before committing — secrets must never enter git history. (Shared guard: scripts/guard-secrets.mjs — fails closed.)`,
        },
    });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const hits = findStagedSecrets(stagedEntries());
    if (hits.length) {
        console.error(
            `Secret file staged: ${hits.join(', ')}\n` +
            `  Unstage it (git restore --staged <file>) before committing — secrets must never enter git history.`
        );
        process.exit(1);
    }
}
