#!/usr/bin/env node
/**
 * Claude Stop wrapper. Policy: core.mjs evaluateStop — a session that wrote files since
 * the gate last settled runs their related tests, `tsc` and the evidence check; capped at
 * 2 consecutive blocks, after which it stops with an UNVERIFIED notice.
 * Antigravity twin: antigravity-stop-evidence-guard.mjs.
 *
 * Payload: { session_id, stop_hook_active, cwd }
 * Output:  { decision: "block", reason }, { systemMessage } (allow with a notice), or nothing
 */
import { pathToFileURL } from 'node:url';
import { evaluateStop, readStdinJson } from './core.mjs';

export function evaluateClaudeStop(payload, root = process.cwd()) {
    return evaluateStop({ sessionId: payload?.session_id ?? '', root });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    try {
        const payload = await readStdinJson();
        if (payload) {
            const r = evaluateClaudeStop(payload, payload.cwd || process.cwd());
            if (r.block) console.log(JSON.stringify({ decision: 'block', reason: r.reason }));
            else if (r.notice) console.log(JSON.stringify({ systemMessage: r.notice }));
        }
    } catch { /* never trap the session on a guard failure */ }
}
