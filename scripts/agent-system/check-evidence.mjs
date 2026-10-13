#!/usr/bin/env node
/**
 * Change-aware evidence gate (A5 — AA-GAP-06, AA-GAP-25).
 *
 *   node scripts/agent-system/check-evidence.mjs                 what does my working tree owe?
 *   node scripts/agent-system/check-evidence.mjs --state pr-ready
 *   node scripts/agent-system/check-evidence.mjs --json
 *
 * THE PROBLEM THIS ADDRESSES
 * `npm run gate` is change-blind: it runs the same checks whether you touched a README
 * or the credit ledger. So prompt work could pass without an eval, and UI work without
 * anyone looking at a rendered pixel — the offline gate stayed green either way.
 *
 * This maps the paths you actually changed to the evidence those paths owe, and reports
 * which of it exists. It is REPORT-ONLY (plan §15: new controls start in shadow), so it
 * informs a human rather than blocking one. Promotion to blocking is A7's decision, and
 * requires the receipt infrastructure that is deliberately still absent.
 *
 * WHAT IT WILL NEVER DO
 * Accept prose. "I ran the tests" is not evidence; a command's recorded output is. Where
 * evidence can only be human judgement (visual taste, Server Component placement), it
 * says so and names the reviewer instead of pretending a script covered it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verify as verifyReceipt } from './evidence-receipt.mjs';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** Where this branch left develop; the base a PR's reviews are checked against. */
export function mergeBase(root) {
    try {
        return execFileSync('git', ['merge-base', 'HEAD', 'origin/develop'], { cwd: root, encoding: 'utf8' }).trim();
    } catch {
        return 'origin/develop';
    }
}

/** Paths changed against a base ref, or the working tree if none given. */
export function changedPaths(root = process.cwd(), base = null) {
    try {
        const args = base ? ['diff', '--name-only', base] : ['status', '--porcelain=v1', '-uall'];
        const out = execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        return out
            .split('\n')
            .map((l) => (base ? l.trim() : l.slice(3).trim()))
            .filter(Boolean)
            .map((p) => p.replace(/\\/g, '/').replace(/^"|"$/g, ''));
    } catch {
        return [];
    }
}

const globToRegExp = (glob) =>
    new RegExp('^' + glob.split('**').map((s) => s.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*') + '$');

/** Which evidence types do these paths owe? */
export function requiredEvidenceFor(paths, evidenceTypes) {
    const required = [];
    for (const e of evidenceTypes) {
        if (!e.changedPaths?.length) continue;
        const matchers = e.changedPaths.map(globToRegExp);
        const hits = paths.filter((p) => matchers.some((m) => m.test(p)));
        if (hits.length) required.push({ evidence: e, triggeredBy: hits.slice(0, 5), triggeredCount: hits.length });
    }
    return required;
}

/** Best-effort detection that a piece of evidence was actually produced. */
export function findEvidenceArtifacts(root, evidenceId) {
    const probes = {
        'prompt-eval-report': () => {
            const dir = path.join(root, 'docs/engineering/audits/evals');
            if (!existsSync(dir)) return null;
            const files = readdirSync(dir).filter((f) => f.endsWith('.md') && !f.includes('DRYRUN'));
            return files.length ? `${files.length} recorded eval report(s) in docs/engineering/audits/evals/` : null;
        },
        'runtime-screenshot': () => {
            const dir = path.join(root, '.playwright-shots');
            return existsSync(dir) ? 'screenshot captured in .playwright-shots/' : null;
        },
    };
    try {
        return probes[evidenceId]?.() ?? null;
    } catch {
        return null;
    }
}

export function buildReport(root = process.cwd(), { base = null, state = 'locally-verified' } = {}) {
    const evidenceTypes = readJson(path.join(root, 'agent-system/evidence.json')).evidenceTypes;
    const states = readJson(path.join(root, 'agent-system/completion-states.json')).states;
    const paths = changedPaths(root, base);
    const required = requiredEvidenceFor(paths, evidenceTypes);

    const target = states.find((s) => s.id === state);
    const stateRequires = target?.requires ?? [];
    const stateEvidence = stateRequires
        .map((id) => evidenceTypes.find((e) => e.id === id))
        .filter(Boolean)
        .map((e) => ({ evidence: e, triggeredBy: [`completion state "${state}"`], triggeredCount: 0 }));

    const merged = [...stateEvidence];
    for (const r of required) if (!merged.some((m) => m.evidence.id === r.evidence.id)) merged.push(r);

    return {
        reportOnly: true,
        changedFileCount: paths.length,
        targetState: state,
        stateGrantsNo: target?.doesNotAuthorize ?? [],
        required: merged.map((r) => ({
            id: r.evidence.id,
            producer: r.evidence.producer,
            machineCheckable: r.evidence.machineCheckable !== false,
            reviewer: r.evidence.reviewerRole ?? null,
            phase: r.evidence.phase ?? 'task',
            triggeredBy: r.triggeredBy,
            triggeredCount: r.triggeredCount,
            artifactHint: findEvidenceArtifacts(root, r.evidence.id),
        })),
    };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const argv = process.argv.slice(2);
    const stateIdx = argv.indexOf('--state');
    const baseIdx = argv.indexOf('--base');
    // `--pr` checks the once-per-PR evidence (the reviews) over the whole branch; pre-push runs
    // it. Without it, Stop checks only per-task evidence, so an edit mid-task does not demand a
    // fresh review each time (2026-10-08, owner: "once per PR + delta").
    const pr = argv.includes('--pr');
    const base = baseIdx >= 0 ? argv[baseIdx + 1] : pr ? mergeBase(process.cwd()) : null;
    const report = buildReport(process.cwd(), {
        state: stateIdx >= 0 ? argv[stateIdx + 1] : 'locally-verified',
        base,
    });
    if (argv.includes('--json')) {
        console.log(JSON.stringify(report, null, 2));
        process.exit(0);
    }
    const enforce = argv.includes('--enforce');
    console.log(enforce
        ? 'check-evidence — ENFORCING (machine-checkable evidence must have a current receipt)\n'
        : 'check-evidence — report only (add --enforce to block)\n');
    console.log(`changed files : ${report.changedFileCount}`);
    console.log(`target state  : ${report.targetState}`);
    console.log(`\nEvidence this change owes:`);
    if (!report.required.length) console.log('  (none — no changed path maps to an evidence contract)');
    for (const r of report.required) {
        const kind = r.machineCheckable ? 'command' : `HUMAN (${r.reviewer ?? 'unassigned'})`;
        console.log(`\n  ${r.id}  [${kind}]`);
        console.log(`    produce with : ${r.producer}`);
        console.log(`    triggered by : ${r.triggeredBy.join(', ')}${r.triggeredCount > 5 ? ` (+${r.triggeredCount - 5} more)` : ''}`);
        if (r.artifactHint) console.log(`    note         : ${r.artifactHint}`);
    }
    console.log(`\nReaching "${report.targetState}" does NOT authorize: ${report.stateGrantsNo.join(', ')}.`);

    if (!enforce) process.exit(0);

    // Only machine-checkable evidence can be enforced. Judgement evidence (visual taste,
    // Server Component placement) names a reviewer instead — a script asserting a human
    // "reviewed" something would be theatre, and worse than an honest gap.
    const failures = [];
    const changed = changedPaths(process.cwd(), base);
    for (const r of report.required.filter((x) => x.machineCheckable && (x.phase === 'pr') === pr)) {
        const { status, detail } = verifyReceipt(process.cwd(), r.id, base, changed);
        if (status === 'missing' || status === 'stale') failures.push(`${r.id}: ${status} — ${detail}`);
    }
    const judgement = report.required.filter((x) => !x.machineCheckable);
    if (judgement.length) {
        console.log(`\nNot enforceable by a script — owed to a human reviewer: ${judgement.map((j) => `${j.id} (${j.reviewer ?? 'unassigned'})`).join(', ')}`);
    }
    if (failures.length) {
        console.error('\ncheck-evidence — BLOCKED:\n');
        for (const f of failures) console.error(`  - ${f}`);
        console.error(pr
            ? '\nReview the branch once: npm run review:pack, answer the packet, then npm run review:check -- <review.md> --actor <main-session|reviewer>.'
            : '\nProduce the evidence, then record it:  npm run evidence:record -- <evidence-id>');
        console.error('A receipt binds the evidence to the exact content it attests to, so an edit');
        console.error('afterwards invalidates it. That is the point — do not re-record without re-running.');
        process.exit(1);
    }
    console.log('\ncheck-evidence OK — every machine-checkable requirement has a current receipt.');
}
