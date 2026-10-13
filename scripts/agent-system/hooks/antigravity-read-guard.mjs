#!/usr/bin/env node
/**
 * Antigravity PreToolUse hook for the tools that return file CONTENTS: `view_file` and
 * `grep_search` (doc 36 S2, 2026-10-11). Until now only Antigravity's shell was guarded, so
 * `view_file .env.local` read a secret that `cat .env.local` could not.
 *
 * `find_by_name` and `list_dir` are not matched: they return names, and a secret's name is not
 * the secret.
 *
 * Antigravity does not document its tools' argument names, so every string argument is checked:
 * - a path that names a secret (`isSecretPath`, the repository's one definition);
 * - a wildcard that could expand to one, with the shell guard's rules (`secretsReferenced`).
 *
 * Fails CLOSED: a payload with no tool arguments, or one that does not parse, is denied.
 */
import { pathToFileURL } from 'node:url';
import { secretsReferenced } from '../../guard-bash-secret-read.mjs';
import { isSecretPath, normalizePath } from '../../guard-secrets.mjs';

/** Every string inside `value`, however deeply nested. */
function strings(value, out = []) {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
    else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out));
    return out;
}

/**
 * @param {unknown} payload
 * @returns {{ decision: 'allow' | 'deny', reason?: string }}
 */
export function evaluateReadPayload(payload) {
    const args = /** @type {any} */ (payload)?.toolCall?.args ?? /** @type {any} */ (payload)?.tool_input;
    if (!args || typeof args !== 'object') {
        return { decision: 'deny', reason: 'antigravity-read-guard: could not find the tool arguments in the hook payload. Failing closed.' };
    }
    const hits = new Set();
    for (const s of strings(args)) {
        const value = s.trim();
        if (isSecretPath(normalizePath(value))) hits.add(value);
        // A tool argument is a native path, not shell text: a `\` separates, and a leading
        // wildcard may match a dot file, so it is scanned as PowerShell text (2026-10-11 review).
        else if (/[*?[]/.test(value)) secretsReferenced(value, { shell: 'powershell' }).forEach((h) => hits.add(h));
    }
    if (!hits.size) return { decision: 'allow' };
    return {
        decision: 'deny',
        reason: `Blocked: this read names ${[...hits].join(', ')}, which is or could expand to a secret file. `
            + 'Secrets are never read by an agent (AGENTS.md §4, §9). `.env.example` is the readable template. '
            + 'For a search, use a narrower include pattern that cannot match `.env*` or `service_account*.json`.',
    };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    let raw = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;
    let payload;
    try {
        payload = JSON.parse(raw);
    } catch {
        console.log(JSON.stringify({ decision: 'deny', reason: 'antigravity-read-guard: could not parse hook payload. Failing closed.' }));
        process.exit(0);
    }
    console.log(JSON.stringify(evaluateReadPayload(payload)));
    process.exit(0);
}
