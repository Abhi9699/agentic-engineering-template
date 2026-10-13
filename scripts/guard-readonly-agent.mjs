#!/usr/bin/env node
/**
 * PreToolUse guard for the READ-ONLY generated subagents (reviewer,
 * content-growth-strategist).
 *
 * WHY THIS EXISTS — the gap it closes (audited 2026-08-27):
 * AGENTS.md §10 described these agents as "read-only: no Write/Edit", and their
 * frontmatter does omit the Write and Edit tools. But all of them carry `Bash`,
 * and a shell is a write tool: `sed -i`, `echo x > file`, `rm`, `git checkout`
 * and `npm install` all mutate the repository without ever touching Write/Edit.
 * The boundary was documentation, not enforcement.
 *
 * Claude subagent frontmatter supports a `hooks` field, so the generator now
 * attaches this guard to every agent the manifest marks `readOnly: true`.
 * Source: https://code.claude.com/docs/en/sub-agents, verified 2026-08-27.
 *
 * SCOPE — be honest about what this does and does not prove. It blocks the
 * mutation shapes an agent reaches for by habit. It is NOT a sandbox: a
 * determined interpreter invocation (`node -e`, `python -c`) can still write.
 * Real isolation is a worktree or a container; this is defense in depth on top
 * of the tool allowlist, not a replacement for either.
 */
import { pathToFileURL } from 'node:url';

/** Commands that mutate the working tree no matter what follows them. */
const MUTATING = [
    /\bsed\b[^|;&]*\s-i\b/,                         // in-place edit
    /(^|[|;&]\s*)(rm|mv|cp|mkdir|rmdir|touch|truncate|dd|chmod|chown|ln)\b/,
    /(^|[|;&]\s*)tee\b/,
    /(^|[|;&]\s*)git\s+(add|commit|checkout|switch|restore|reset|revert|apply|am|cherry-pick|merge|rebase|stash|push|clean|rm|mv|tag|branch\s+-[dD])\b/,
    /(^|[|;&]\s*)(npm|pnpm|yarn|bun)\s+(i|install|ci|add|remove|uninstall|link|update|upgrade)\b/,
    /(^|[|;&]\s*)npx\s+drizzle-kit\s+(generate|push|migrate|drop)\b/,
];

/** Redirect targets a read-only agent may legitimately write (evidence, scratch, noise). */
const ALLOWED_TARGET = /^(\/dev\/null|\.playwright-shots\/|\.next\/|node_modules\/|.*[/\\][Tt]e?mp[/\\]|\/tmp\/)/;

/** @returns {string[]} reasons this command mutates state; empty means read-only. */
export function mutationsIn(command) {
    if (typeof command !== 'string') return ['unparseable command'];
    const reasons = [];
    for (const pattern of MUTATING) {
        const hit = command.match(pattern);
        if (hit) reasons.push(`mutating command: ${hit[0].trim()}`);
    }
    // Output redirection is a file write. `2>/dev/null` and evidence dirs are fine.
    for (const [, target] of command.matchAll(/(?<![0-9])>>?\s*(\S+)/g)) {
        const clean = target.replace(/^['"]|['"]$/g, '').replace(/\\/g, '/');
        if (!ALLOWED_TARGET.test(clean)) reasons.push(`writes to ${clean} via redirect`);
    }
    return [...new Set(reasons)];
}

const deny = (reason) => JSON.stringify({
    hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
    },
});

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    let raw = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;

    let command;
    try {
        command = JSON.parse(raw)?.tool_input?.command;
    } catch {
        console.log(deny('guard-readonly-agent: could not parse the hook payload, so it cannot prove this command is read-only. Failing closed.'));
        process.exit(0);
    }

    const reasons = mutationsIn(command);
    if (reasons.length) {
        console.log(deny(
            `Blocked — this is a read-only role (${reasons.join('; ')}). `
            + 'Report the finding with file:line and let the owning implementer fix it. '
            + 'Fixing what you were asked to audit destroys the independent review that is the whole point of this lane (AGENTS.md §10).',
        ));
    }
    process.exit(0);
}
