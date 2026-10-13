#!/usr/bin/env node
/**
 * Generate every provider's hook wiring from agent-system/hooks.json, so Claude and
 * Antigravity cannot drift apart.
 *
 *  - .agents/hooks.json is pure output (the whole file).
 *  - .claude/settings.json also holds hand-maintained hooks and permissions, so only
 *    MANAGED entries — commands under scripts/agent-system/hooks/ — are owned here.
 *    Everything else in that file is left byte-for-byte alone.
 *
 * Usage:
 *   node scripts/agent-system/generate-hooks.mjs          # write
 *   node scripts/agent-system/generate-hooks.mjs --check  # exit 1 on drift (check:control-plane)
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MANAGED_PREFIX = 'node scripts/agent-system/hooks/';
/** The same prefix after anchorToProject() — recognised so a re-render replaces, not duplicates. */
const ANCHORED_PREFIX = 'node "${CLAUDE_PROJECT_DIR}/scripts/agent-system/hooks/';
const ANTIGRAVITY_OUT = '.agents/hooks.json';
const CLAUDE_OUT = '.claude/settings.json';

function hookCommand({ command, timeout }) {
    return { type: 'command', command, timeout };
}

/**
 * Claude runs a command hook in the SESSION'S current directory, which follows every
 * `cd` the agent makes. A relative `node scripts/...` then dies with "Cannot find
 * module" from any subdirectory, and a crashed PreToolUse hook does not block — the
 * guard silently fails open. Observed 2026-08-30 → 2026-09-24 in transcripts.
 * `${CLAUDE_PROJECT_DIR}` is the documented placeholder for the session's project
 * root (https://code.claude.com/docs/en/hooks, verified 2026-09-24); it is double-
 * quoted because the root may contain spaces.
 */
export function anchorToProject(command) {
    return command.replace(/^node (scripts\/\S+)/, 'node "${CLAUDE_PROJECT_DIR}/$1"');
}

/** Antigravity: PreToolUse entries carry a matcher + hooks[]; lifecycle events are flat. */
export function renderAntigravity(manifest) {
    const events = {};
    for (const guard of manifest.guards) {
        const b = guard.antigravity;
        if (!b) continue;
        events[b.event] ??= [];
        events[b.event].push(b.matcher ? { matcher: b.matcher, hooks: [hookCommand(b)] } : hookCommand(b));
    }
    return JSON.stringify({ 'antigravity-guard': events }, null, 2) + '\n';
}

function isManaged(hook) {
    return typeof hook?.command === 'string'
        && (hook.command.startsWith(MANAGED_PREFIX) || hook.command.startsWith(ANCHORED_PREFIX));
}

/** Claude: strip managed hooks from settings.hooks, then append one group per guard. */
export function renderClaudeSettings(manifest, settingsText) {
    const settings = JSON.parse(settingsText);
    const hooks = settings.hooks ?? {};
    for (const event of Object.keys(hooks)) {
        hooks[event] = hooks[event]
            .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((h) => !isManaged(h)) }))
            .filter((group) => group.hooks.length);
        if (!hooks[event].length) delete hooks[event];
    }
    for (const guard of manifest.guards) {
        const b = guard.claude;
        if (!b) continue;
        hooks[b.event] ??= [];
        const hook = hookCommand({ ...b, command: anchorToProject(b.command) });
        hooks[b.event].push(b.matcher ? { matcher: b.matcher, hooks: [hook] } : { hooks: [hook] });
    }
    settings.hooks = hooks;
    return JSON.stringify(settings, null, 2) + '\n';
}

export function generateHooks(root = process.cwd(), { write = false } = {}) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'agent-system/hooks.json'), 'utf8'));
    const targets = [
        [ANTIGRAVITY_OUT, () => renderAntigravity(manifest)],
        [CLAUDE_OUT, (current) => renderClaudeSettings(manifest, current)],
    ];
    const changed = [];
    for (const [rel, render] of targets) {
        const file = path.join(root, rel);
        const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}';
        const next = render(current);
        if (next !== current) {
            changed.push(rel);
            if (write) fs.writeFileSync(file, next);
        }
    }
    return changed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const check = process.argv.includes('--check');
    const changed = generateHooks(process.cwd(), { write: !check });
    if (check && changed.length) {
        console.error(`generate-hooks --check - ${changed.length} file(s) drifted from agent-system/hooks.json:\n`);
        changed.forEach((f) => console.error(`  - ${f}`));
        console.error('\nRun `npm run agent:generate` and commit the result.');
        process.exit(1);
    }
    console.log(check
        ? 'generate-hooks --check OK - provider hook wiring matches agent-system/hooks.json.'
        : `generate-hooks - ${changed.length ? `wrote ${changed.join(', ')}` : 'already current'}.`);
}
