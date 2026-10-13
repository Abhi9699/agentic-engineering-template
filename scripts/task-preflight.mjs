#!/usr/bin/env node
/**
 * Task preflight — classifies a task with the agent:task resolver and notes open §B
 * verify-before-relying items and OPEN lessons it touches. ADVISORY (doc 34 W3): the
 * write and stop guards arm from the files a session writes, not from this. Policy lives
 * in scripts/agent-system/hooks/core.mjs.
 *
 * Claude runs this automatically on every prompt (UserPromptSubmit hook). Other tools may
 * run it by hand before a task; skipping it disables no guard.
 *
 * Usage:
 *   node scripts/task-preflight.mjs "<task description>" [--conv <conversationId>]
 *
 * Prints JSON: { route, risk, requiredSkills, verifyNotes, openLessonHits }.
 * Always exits 0 on a classified task — §B items are build-time checks, not owner stops.
 */
import { pathToFileURL } from 'node:url';
import { preflight, recordPreflight } from './agent-system/hooks/core.mjs';

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const args = process.argv.slice(2);
    const convIdx = args.indexOf('--conv');
    const conversationId = convIdx >= 0 ? args[convIdx + 1] : process.env.ANTIGRAVITY_CONVERSATION_ID ?? '';
    const taskDesc = args.filter((a, i) => !a.startsWith('--') && !(convIdx >= 0 && i === convIdx + 1)).join(' ');

    if (!taskDesc.trim()) {
        console.error('Usage: node scripts/task-preflight.mjs "<task description>" [--conv <id>]');
        process.exit(1);
    }

    const result = preflight(taskDesc);
    if (conversationId) recordPreflight(conversationId, taskDesc, result);

    if (result.verifyNotes.length) {
        console.warn('\nVerify before relying (OPEN_QUESTIONS §B, build-time checks):');
        result.verifyNotes.forEach((n) => console.warn(`  - ${n}`));
    }
    if (result.openLessonHits.length) {
        console.warn('\nOPEN lessons touched by this task — review before implementing:');
        result.openLessonHits.forEach((l) => console.warn(`  - ${l}`));
    }
    const { route, risk, requiredSkills, verifyNotes, openLessonHits } = result;
    console.log(JSON.stringify({ route, risk, requiredSkills, verifyNotes, openLessonHits }, null, 2));
}
