#!/usr/bin/env node
/**
 * Antigravity PreToolUse wrapper for file-write tools
 * (write_to_file | replace_file_content | multi_replace_file_content).
 *
 * Policy: core.mjs evaluateWrite — every write is ledgered for the Stop gate, and a
 * vendor-integration or dependency path waits for captured research. Claude twin:
 * claude-write-guard.mjs. The written text is not read here (Antigravity's argument
 * names for it are not documented), so any package.json write counts as a version change.
 *
 * Payload: { conversationId, toolCall: { name, args: { TargetFile } }, workspacePaths }
 * Output:  { decision: "allow" | "deny", reason? }
 */
import { pathToFileURL } from 'node:url';
import { audit, evaluateWrite, readStdinJson } from './core.mjs';

function extractTargetFile(payload) {
    const args = payload?.toolCall?.args ?? {};
    return args.TargetFile ?? args.targetFile ?? args.target_file ?? '';
}

export function evaluatePreflightPayload(payload) {
    const r = evaluateWrite({
        sessionId: payload?.conversationId ?? '',
        targetFile: extractTargetFile(payload),
        cwd: payload?.workspacePaths?.[0] ?? process.cwd(),
    });
    return r.allowed
        ? { decision: 'allow', _reason: r.why }
        : { decision: 'deny', reason: r.reason, _reason: r.why };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const payload = await readStdinJson();
    if (payload === null) {
        console.log(JSON.stringify({ decision: 'allow', reason: 'preflight-guard: could not parse payload, allowing.' }));
        process.exit(0);
    }
    const { decision, reason, _reason } = evaluatePreflightPayload(payload);
    audit(process.cwd(), 'preflight-guard', {
        provider: 'antigravity', decision, reason: _reason,
        targetFile: extractTargetFile(payload), conversationId: payload?.conversationId ?? '',
    });
    console.log(JSON.stringify(reason ? { decision, reason } : { decision }));
}
