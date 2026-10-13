#!/usr/bin/env node
/**
 * Antigravity PreInvocation hook — research reminder.
 *
 * Fires once before each model invocation. Since doc 34 W3 no step is required before
 * work: the write guard ledgers every write and decides risk from the written paths. This
 * hook speaks only when a vendor-integration or dependency write was already refused for
 * want of research, and repeats how to capture it. Zero output otherwise.
 * State and policy: core.mjs. Claude twin: claude-prompt-preflight.mjs.
 *
 * Payload shape (PreInvocation, per hooks.md): { conversationId, invocationNum, ... }
 * Output: { injectSteps: [{ ephemeralMessage: "..." }] } or {}
 */
import { pathToFileURL } from 'node:url';
import { readState as readPreflightState } from './core.mjs';

export function evaluatePreInvocationPayload(payload) {
    const conversationId = payload?.conversationId ?? '';
    const state = readPreflightState(conversationId);
    if (!state?.researchOwed || state.researchCaptured) return {};
    return {
        injectSteps: [
            {
                ephemeralMessage:
                    'A vendor-integration or dependency write was refused: research is not captured yet.\n' +
                    '  1. npm run knowledge:search "<problem> <lib@version>"  → check cache first\n' +
                    '  2. If cache miss: run 3 parallel web searches (version-pinned)\n' +
                    '  3. Fill ResearchEntry JSON (see scripts/research-validate.mjs for schema)\n' +
                    `  4. npm run research:capture '<json>' --conv ${conversationId}\n` +
                    'Writes to that path stay blocked until step 4 completes.',
            },
        ],
    };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    let raw = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;

    let payload;
    try {
        payload = raw.trim() ? JSON.parse(raw) : {};
    } catch {
        console.log('{}');
        process.exit(0);
    }

    console.log(JSON.stringify(evaluatePreInvocationPayload(payload)));
    process.exit(0);
}
