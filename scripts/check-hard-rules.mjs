#!/usr/bin/env node
/**
 * Deterministic checker for AGENTS.md §4 hard rules that ESLint can't express.
 * Runs in CI, locally via `npm run check:rules`, and in the pre-commit hook
 * (`--staged`). Rules live in scripts/lib/hard-rules.mjs (unit-tested).
 *
 * Flags:
 *   --staged    scan only staged .ts/.tsx files under app/ lib/ components/
 *   --coverage  print the enforced-rule table and exit 0
 *
 * Exit 1 with file:line evidence on any 'block' violation; 'warn' rules print
 * but never fail the run.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { RULES, FILE_RULES, findViolations, SCAN_DIRS, EXTS } from './lib/hard-rules.mjs';
import { stagedEntries } from './lib/staged.mjs';

const ROOT = process.cwd();
const args = new Set(process.argv.slice(2));

if (args.has('--coverage')) {
    console.log('Hard-rule coverage (machine-enforced):\n');
    for (const r of [...RULES, ...FILE_RULES]) {
        const summary = r.message.replace(/^[^:]+:\s*/, '').split(/\.\s|\.$/)[0];
        console.log(`  [${r.severity.toUpperCase().padEnd(5)}] ${r.id.padEnd(22)} ${summary}`);
    }
    const all = [...RULES, ...FILE_RULES];
    const blocks = all.filter((r) => r.severity === 'block').length;
    console.log(`\n  ${blocks} blocking · ${all.length - blocks} warn.`);

    /*
     * AGENTS.md §9 points at this report as the answer to "what is actually enforced",
     * so a rule enforced by a DEDICATED gate rather than by this line-based engine has
     * to appear here too. Listing only the nine above understates coverage — and the
     * whole point of Pillar 2 was that prose must never be mistaken for enforcement, in
     * either direction. Each of these is a `gate:full` step with a CI backstop.
     */
    console.log('\n  Enforced by a dedicated gate (same force, different mechanism):\n');
    for (const [cmd, what] of [
        ['check:server-actions', 'every exported Server Action establishes a caller — a `use server` export is a public endpoint'],
        ['check:ownership', 'every query on a user-owned table names the owner — §4b\'s second half, judgment until 2026-09-12'],
        ['check:tokens', 'no raw colour values outside the token layer; scoped tokens stay in their scope (ratcheted)'],
        ['check:line-caps', 'components and modules target <= 400 lines (ratcheted baseline)'],
        ['check:css-modules', 'no undefined CSS Module classes, and no dead ones (ratcheted)'],
        ['check:knip', 'no undeclared dependencies (hard); unused exports/files ratcheted'],
        ['check:control-plane', 'agent manifest schema, graph invariants, skill pins, adapter drift'],
    ]) {
        console.log(`  [BLOCK] ${cmd.padEnd(22)} ${what}`);
    }

    console.log('\n  Judgment-only (NOT machine-checked): Server-Components-default, Zod on Server Action arguments (route bodies are route-zod), right-abstraction, new config via lib/env.ts, rejection-path tests, prompt-template escaping, one concern per PR, fail-closed — reviewer / PR review.');
    /*
     * Said out loud, because the danger of a security gate is that its green gets read as
     * more than it proves. `check:ownership` proves the owner column is MENTIONED in the
     * query, not that it is compared against the authenticated caller.
     */
    console.log('  Partial: check:ownership proves the owner column is MENTIONED in a query, not that it is compared against the CALLER — that comparison is still judgment.');
    process.exit(0);
}

function* walk(dir) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
            if (entry === 'node_modules' || entry.startsWith('.')) continue;
            yield* walk(full);
        } else if (EXTS.has(full.slice(full.lastIndexOf('.')))) {
            yield full;
        }
    }
}

function fileList() {
    if (args.has('--staged')) {
        const staged = stagedEntries()
            .filter((e) => e.status !== 'D')
            .map((e) => e.path.replaceAll('\\', '/'))
            .filter((p) => SCAN_DIRS.some((d) => p.startsWith(d + '/')) && EXTS.has(p.slice(p.lastIndexOf('.'))));
        return [...new Set(staged)].map((p) => join(ROOT, p));
    }
    const out = [];
    for (const dir of SCAN_DIRS) {
        try {
            for (const f of walk(join(ROOT, dir))) out.push(f);
        } catch {
            /* scan dir absent — nothing to check */
        }
    }
    return out;
}

const blocks = [];
const warns = [];
for (const file of fileList()) {
    let content;
    try {
        content = readFileSync(file, 'utf8');
    } catch {
        continue; // staged-but-deleted race or unreadable — nothing to scan
    }
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    const readSibling = (name) => {
        try {
            return readFileSync(join(dirname(file), name), 'utf8');
        } catch {
            return null;
        }
    };
    for (const v of findViolations(rel, content, { readSibling })) {
        (v.severity === 'block' ? blocks : warns).push(`${rel}:${v.line}  [${v.id}]  ${v.message}`);
    }
}

if (warns.length) {
    console.warn(`\n[warn] Hard-rule warnings (${warns.length}):\n` + warns.join('\n') + '\n');
}
if (blocks.length) {
    console.error(`\nHard-rule violations (${blocks.length}):\n\n` + blocks.join('\n') + '\n');
    process.exit(1);
}
console.log(`check:rules OK — 0 violations, ${warns.length} warning(s)${args.has('--staged') ? ' (staged scope)' : ''}.`);
