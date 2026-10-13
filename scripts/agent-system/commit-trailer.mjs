#!/usr/bin/env node
/**
 * prepare-commit-msg (doc 36 M1): append `Agent-Tool: <tool>` to an agent's commit, so the
 * scorecard can measure gate failures and fix commits per tool.
 *
 *   node scripts/agent-system/commit-trailer.mjs <message-file> [source]
 *
 * - git itself places the trailer (`git interpret-trailers`), so it joins an existing
 *   trailer block such as Co-Authored-By and leaves comment lines alone.
 * - An existing Agent-Tool trailer is kept as written (the Antigravity guard adds its own).
 * - An empty message is left empty, so git still aborts the commit as it would without us.
 * - Telemetry never blocks a commit: every failure exits 0 (the .githooks shim also
 *   ignores the status).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { detectTool } from '../lib/agent-tool.mjs';

export const TRAILER_KEY = 'Agent-Tool';

/** Whether a trailer should be added to this message. */
export function shouldTag(message, tool) {
    if (!tool) return false;
    const content = String(message).split('\n').filter((l) => !l.startsWith('#')).join('\n');
    if (!content.trim()) return false;
    return !new RegExp(`^${TRAILER_KEY}:`, 'mi').test(content);
}

/** @returns {boolean} whether the file was tagged */
export function tagMessageFile(file, tool = detectTool()) {
    let message;
    try { message = fs.readFileSync(file, 'utf8'); } catch { return false; }
    if (!shouldTag(message, tool)) return false;
    const r = spawnSync('git', ['interpret-trailers', '--in-place', '--if-exists', 'doNothing',
        '--trailer', `${TRAILER_KEY}: ${tool}`, file], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    try { if (process.argv[2]) tagMessageFile(process.argv[2]); } catch { /* never block a commit */ }
    process.exit(0);
}
