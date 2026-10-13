#!/usr/bin/env node
/**
 * Claude UserPromptSubmit wrapper — runs the task preflight automatically on every
 * prompt, so AGENTS.md §6 step 0 costs the model nothing. Antigravity twin:
 * antigravity-preinvocation-research.mjs (its hook cannot see the prompt).
 *
 * ADVISORY since doc 34 W3: it arms nothing. Gates arm from the files a session writes
 * (core.mjs evaluateWrite). Adds context only for an R3+ route, a §B verify note or an
 * OPEN lesson; anything else adds zero tokens. Never blocks a prompt.
 *
 * Payload: { session_id, prompt, cwd }
 * Output:  { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } } or nothing
 */
import { pathToFileURL } from 'node:url';
import { preflight, readStdinJson, recordPreflight } from './core.mjs';

// Classify the ask, not a pasted log or document: keyword scoring over a long paste
// escalates risk on nouns the user never asked to change.
const CLASSIFY_CHARS = 500;

export function evaluatePromptPayload(payload, root = process.cwd()) {
    const sessionId = payload?.session_id ?? '';
    const prompt = String(payload?.prompt ?? '').slice(0, CLASSIFY_CHARS);
    if (!sessionId || !prompt.trim()) return null;

    const result = preflight(prompt, root);
    recordPreflight(sessionId, prompt, result);

    const lines = [];
    if (['R3', 'R4'].includes(result.risk)) {
        lines.push(`[preflight, advisory] this prompt reads as ${result.route} · ${result.risk}` +
            (result.requiredSkills?.length ? ` · skills: ${result.requiredSkills.join(', ')}` : '') +
            '. Gates arm from the files you write, not from this.');
    }
    if (result.verifyNotes.length) lines.push(`Verify before relying (OPEN_QUESTIONS §B): ${result.verifyNotes.join('; ')}`);
    if (result.openLessonHits.length) lines.push(`OPEN lessons touched: ${result.openLessonHits.join(', ')}`);
    return lines.length ? lines.join('\n') : null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    try {
        const payload = await readStdinJson();
        const context = payload && evaluatePromptPayload(payload, payload.cwd || process.cwd());
        if (context) {
            console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }));
        }
    } catch { /* a preflight failure must never block the user's prompt */ }
}
