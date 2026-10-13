#!/usr/bin/env node
/**
 * Complexity budget (doc 36 G1): a ratchet on how big the harness is.
 *
 *   node scripts/agent-system/check-complexity-budget.mjs           # enforce (check:control-plane)
 *   node scripts/agent-system/check-complexity-budget.mjs --update  # lower budgets to what is measured
 *   node scripts/agent-system/check-complexity-budget.mjs --raise   # set budgets to what is measured
 *
 * WHY (2026-10-11): every gate here was added after a defect, and nothing ever came out. By
 * doc 36's audit the repo carried 111 npm scripts, about 55K lines under scripts/, and 34 KB
 * of context every session paid before reading the task. Each addition was reasonable. The
 * sum was the problem, and no check ever saw the sum.
 *
 * Three counts, each in agent-system/budgets.json `complexity`:
 *   npmScripts    entries in package.json `scripts`
 *   scriptsLines  lines in files under scripts/ (tracked, plus new files git does not ignore)
 *   startupBytes  bytes of the files every tool loads at session start (scorecard STARTUP_FILES)
 *
 * A count over its budget fails. A count under it passes, and `--update` locks in the cut.
 * Growing a budget takes `--raise` in a commit whose message carries `Budget-Raise: <reason>`;
 * the trailer check reads every commit since `origin/develop` that raised one.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { contextBytes } from './scorecard.mjs';

export const COUNTS = ['npmScripts', 'scriptsLines', 'startupBytes'];
const BUDGETS = 'agent-system/budgets.json';

const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** @param {string} root */
export function measure(root = process.cwd()) {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const files = git(['ls-files', '-co', '--exclude-standard', '--', 'scripts'], root).stdout.split('\n').filter(Boolean);
    let scriptsLines = 0;
    for (const f of files) {
        let text;
        try { text = readFileSync(path.join(root, f), 'utf8'); } catch { continue; } // deleted, not yet staged
        scriptsLines += text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    }
    return { npmScripts: Object.keys(pkg.scripts ?? {}).length, scriptsLines, startupBytes: contextBytes(root).total };
}

/**
 * Counts over budget, and counts under it (the ratchet can tighten).
 * @param {Record<string, number>} measured
 * @param {Record<string, number>} budget
 */
export function compare(measured, budget) {
    const over = COUNTS.filter((k) => measured[k] > budget[k]);
    const under = COUNTS.filter((k) => measured[k] < budget[k]);
    return { over, under };
}

/**
 * Budget values a commit raised, from the budgets file before and after it.
 * @param {string} before JSON text, '' when the file did not exist
 * @param {string} after JSON text
 */
export function raisedCounts(before, after) {
    const b = before ? JSON.parse(before).complexity ?? {} : {};
    const a = JSON.parse(after).complexity ?? {};
    return COUNTS.filter((k) => typeof b[k] === 'number' && typeof a[k] === 'number' && a[k] > b[k]);
}

/**
 * Commits since `base` that raised a budget without a `Budget-Raise:` trailer.
 * @param {string} base
 * @param {string} root
 */
export function unexplainedRaises(base, root = process.cwd()) {
    const log = git(['log', '--format=%H%x1f%(trailers:key=Budget-Raise,valueonly,separator=%x2c)', `${base}..HEAD`, '--', BUDGETS], root);
    if (log.status !== 0) return [];
    const out = [];
    for (const line of log.stdout.split('\n').filter(Boolean)) {
        const [sha, reason] = line.split('\x1f');
        const after = git(['show', `${sha}:${BUDGETS}`], root).stdout;
        const before = git(['show', `${sha}^:${BUDGETS}`], root);
        const raised = after ? raisedCounts(before.status === 0 ? before.stdout : '', after) : [];
        if (raised.length && !reason?.trim()) out.push({ sha: sha.slice(0, 8), raised });
    }
    return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const argv = process.argv.slice(2);
    const file = path.join(process.cwd(), BUDGETS);
    const budgets = JSON.parse(readFileSync(file, 'utf8'));
    const budget = budgets.complexity;
    const measured = measure();

    if (argv.includes('--update') || argv.includes('--raise')) {
        const raise = argv.includes('--raise');
        for (const k of COUNTS) budget[k] = raise ? measured[k] : Math.min(budget[k], measured[k]);
        writeFileSync(file, `${JSON.stringify(budgets, null, 2)}\n`);
        console.log(`complexity budget ${raise ? 'set' : 'lowered'} to ${COUNTS.map((k) => `${k} ${budget[k]}`).join(' · ')}`);
        if (raise) console.log('Commit it with a `Budget-Raise: <why the harness had to grow>` trailer.');
        process.exit(0);
    }

    const { over, under } = compare(measured, budget);
    const base = git(['merge-base', 'HEAD', 'origin/develop']).stdout.trim();
    const unexplained = base ? unexplainedRaises(base) : [];
    for (const k of over) {
        console.error(`complexity budget: ${k} ${measured[k]} > ${budget[k]}. Subtract something, or run --raise and commit with a \`Budget-Raise: <reason>\` trailer (doc 36 G1).`);
    }
    for (const u of unexplained) {
        console.error(`complexity budget: commit ${u.sha} raised ${u.raised.join(', ')} without a \`Budget-Raise:\` trailer. Amend or reword it (doc 36 G1).`);
    }
    if (over.length || unexplained.length) process.exit(1);
    const hint = under.length ? ` (${under.join(', ')} under budget: --update locks the cut in)` : '';
    console.log(`complexity budget OK — ${COUNTS.map((k) => `${k} ${measured[k]}/${budget[k]}`).join(' · ')}${hint}`);
}
