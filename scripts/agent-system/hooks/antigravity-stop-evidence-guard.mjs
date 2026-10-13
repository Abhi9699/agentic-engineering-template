#!/usr/bin/env node
/**
 * Antigravity Stop wrapper. Policy: core.mjs evaluateStop — when this session wrote files,
 * completion is held until their related tests, `tsc` and the evidence check pass; capped
 * at 2 consecutive blocks, then allowed. Claude twin:
 * claude-stop-guard.mjs.
 *
 * Payload: { conversationId, terminationReason, fullyIdle }
 * Output:  { decision: "allow" | "continue", reason? }
 */
import { pathToFileURL } from 'node:url';
import { evaluateStop, getBlockCount, incrementBlockCount, readStdinJson, resetBlockCount } from './core.mjs';

export { getBlockCount, incrementBlockCount, resetBlockCount };

export function evaluateStopPayload(payload, root = process.cwd()) {
    // Background tasks still settling, or a stop the model did not choose: never hold it.
    if (payload?.fullyIdle === false) return { decision: 'allow' };
    if ((payload?.terminationReason ?? 'model_stop') !== 'model_stop') return { decision: 'allow' };
    const r = evaluateStop({ sessionId: payload?.conversationId ?? '', root });
    // Antigravity shows `reason` only with "continue" (https://antigravity.google/docs/hooks,
    // checked 2026-10-03), so an UNVERIFIED notice on an allowed stop has no channel there;
    // the pre-push gate:quick still refuses the failing commit.
    return r.block ? { decision: 'continue', reason: r.reason } : { decision: 'allow' };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const payload = (await readStdinJson()) ?? {};
    console.log(JSON.stringify(evaluateStopPayload(payload)));
}
