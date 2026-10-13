#!/usr/bin/env node
/**
 * Claude PreToolUse wrapper for Write|Edit|MultiEdit|NotebookEdit.
 * Policy: core.mjs evaluateWrite. Antigravity twin: antigravity-preflight-guard.mjs.
 *
 * Prints a deny decision, or for an allowed write at most an `additionalContext` notice and
 * never a permissionDecision: emitting "allow" would skip the user's normal permission
 * prompt, which this guard must not do.
 *
 * The notice (doc 36 S3) says when a write would take an `app|components|lib` `.ts(x)` file
 * past its line allowance, so the split happens now rather than at the Stop gate. It is never
 * a deny: a mid-refactor file may pass the cap briefly. PreToolUse `additionalContext` without
 * a decision keeps the normal permission flow (https://code.claude.com/docs/en/hooks,
 * retrieved 2026-10-11).
 *
 * Payload: { session_id, cwd, tool_name, tool_input: { file_path | notebook_path, content | new_string | edits } }
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BASELINE_FILE, LINE_CAP, countLines, isTestOrDefinitionFile, loadBaseline, toPosix } from '../../check-line-caps.mjs';
import { audit, evaluateWrite, gitTop, readStdinJson } from './core.mjs';

const CAPPED = /^(app|components|lib)\/.+\.tsx?$/;
const newlines = (s) => (String(s ?? '').match(/\n/g) ?? []).length;

/**
 * The line-cap notice for a write, or ''. Projects the file's length after the write: a Write
 * counts its content; an Edit or MultiEdit adds each edit's newline delta to the current file
 * (a `replace_all` edit counts once, so the projection is approximate, as a notice may be).
 * @param {{ file_path?: string, content?: string, old_string?: string, new_string?: string, edits?: { old_string?: string, new_string?: string }[] }} input
 * @param {{ top: string, read?: (p: string) => string, baseline?: Record<string, number> }} ctx
 */
export function capAdvisory(input, { top, read = (p) => readFileSync(p, 'utf8'), baseline }) {
    if (!input?.file_path) return '';
    const rel = toPosix(path.relative(top, path.resolve(top, input.file_path)));
    if (!CAPPED.test(rel) || isTestOrDefinitionFile(rel)) return '';
    let projected;
    if (typeof input.content === 'string') {
        projected = countLines(input.content);
    } else {
        let current = '';
        try { current = read(path.join(top, rel)); } catch { /* a new file */ }
        const edits = Array.isArray(input.edits) ? input.edits : [input];
        projected = countLines(current) + edits.reduce((n, e) => n + newlines(e?.new_string) - newlines(e?.old_string), 0);
    }
    const allowed = (baseline ?? loadBaseline(path.join(top, BASELINE_FILE)))[rel] ?? LINE_CAP;
    if (projected <= allowed) return '';
    return `Line cap: after this write ${rel} is about ${projected} lines; its allowance is ${allowed} (AGENTS.md §4 rule 1, `
        + 'scripts/line-caps.baseline.json). The Stop gate and gate:quick fail a file left over it, so it needs splitting '
        + 'into subcomponents or modules before the task ends.';
}

export function evaluateClaudeWrite(payload) {
    const input = payload?.tool_input ?? {};
    const targetFile = input.file_path ?? input.notebook_path ?? '';
    // The text being written, so a package.json edit owes research only when it names a version.
    const content = input.new_string ?? input.content
        ?? (Array.isArray(input.edits) ? input.edits.map((e) => e?.new_string ?? '').join('\n') : undefined);
    const r = evaluateWrite({ sessionId: payload?.session_id ?? '', targetFile, cwd: payload?.cwd ?? process.cwd(), content });
    return { ...r, targetFile };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    try {
        const payload = await readStdinJson();
        if (payload) {
            const r = evaluateClaudeWrite(payload);
            if (r.allowed) {
                const notice = capAdvisory(payload.tool_input ?? {}, { top: gitTop(payload.cwd || process.cwd()) || payload.cwd || process.cwd() });
                if (notice) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: notice } }));
            } else {
                audit(payload.cwd || process.cwd(), 'preflight-guard', {
                    provider: 'claude', decision: 'deny', reason: r.why,
                    targetFile: r.targetFile, conversationId: payload.session_id ?? '',
                });
                console.log(JSON.stringify({
                    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.reason },
                }));
            }
        }
    } catch { /* fail open, matching the Antigravity twin: this is a discipline guard, not a security boundary */ }
}
