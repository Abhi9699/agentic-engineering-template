#!/usr/bin/env node
/**
 * Agent-loop scorecard: is the harness getting faster and catching more, or only growing?
 *
 *   node scripts/agent-system/scorecard.mjs              last 30 days
 *   node scripts/agent-system/scorecard.mjs --days 7 --json
 *   node scripts/agent-system/scorecard.mjs --no-ci      offline (skips `gh`)
 *
 * WHY (2026-10-08): every gate in this repo was added after a defect, and none was ever
 * measured afterwards. The hook audit log had no records after 2026-10-03, because agents
 * moved into worktrees and their `logs/` were deleted with them. This reads the shared
 * state dir (scripts/lib/shared-state.mjs), which every checkout and every coding tool
 * writes to, so the numbers survive worktree cleanup.
 *
 * Scope: the agent loop only (gate latency, Stop outcomes, CI escapes, startup context).
 * Delivery stability (change fail rate, rework) is `npm run dora:report`; not duplicated here.
 *
 * "CI escape" = a CI run that failed on a commit whose local gate:quick had passed. That
 * is the number that says whether the fast local gate (and its cache) can be trusted.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readShared } from '../lib/shared-state.mjs';

/** Repo files every tool loads at session start (AGENTS.md is imported by CLAUDE.md and GEMINI.md). */
export const STARTUP_FILES = ['AGENTS.md', 'CLAUDE.md', 'vault/_START-HERE.md', 'vault/Active-Context.md'];

export function median(xs) {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** `tests (changed since <sha>)` is one stage; the base sha in its label is not part of its identity. */
export const stageKey = (label) => String(label).replace(/^tests \(.*\)$/, 'tests');

const since = (days, now) => (r) => Date.parse(r.ts ?? r.createdAt ?? 0) >= now - days * 86_400_000;

/** @param {Record<string, any>[]} runs gate-timings.jsonl rows */
export function gateStats(runs) {
    const quick = runs.filter((r) => r.mode === 'quick');
    const okQuick = quick.filter((r) => r.ok);
    /** @type {Record<string, number[]>} */
    const perStage = {};
    for (const r of okQuick) for (const st of r.stages ?? []) (perStage[stageKey(st.label)] ??= []).push(st.s);
    const slowest = Object.entries(perStage)
        .map(([label, xs]) => ({ label, p50: median(xs) }))
        .sort((a, b) => (b.p50 ?? 0) - (a.p50 ?? 0)).slice(0, 5);
    return { runs: runs.length, quickRuns: quick.length, quickFailed: quick.length - okQuick.length, quickP50: median(okQuick.map((r) => r.total)), slowest };
}

/** @param {Record<string, any>[]} rows agent-hooks.jsonl rows */
export function stopStats(rows) {
    const stops = rows.filter((r) => r.hook === 'stop');
    return {
        stops: stops.length,
        blocks: stops.filter((r) => r.block).length,
        unverified: stops.filter((r) => r.why === 'block cap reached').length,
    };
}

/** Rows written before doc 36 M1 carry no `tool`, and a human's carry ''. */
const toolOf = (r) => r.tool || 'unknown';

/**
 * Gate results per agent tool (doc 36 M2).
 * @param {Record<string, any>[]} runs gate-timings.jsonl rows
 */
export function gateByTool(runs) {
    /** @type {Record<string, { quickRuns: number, quickFailed: number }>} */
    const out = {};
    for (const r of runs.filter((x) => x.mode === 'quick')) {
        const t = (out[toolOf(r)] ??= { quickRuns: 0, quickFailed: 0 });
        t.quickRuns += 1;
        if (!r.ok) t.quickFailed += 1;
    }
    return out;
}

/**
 * How often each gate stage stopped a run (doc 36 M2). A stage that ran but never failed is
 * listed with 0: that list is the input to the gate-retirement review (doc 36 G2).
 * @param {Record<string, any>[]} runs gate-timings.jsonl rows
 */
export function stageCatches(runs) {
    /** @type {Record<string, number>} */
    const counts = {};
    for (const r of runs) {
        for (const st of r.stages ?? []) counts[stageKey(st.label)] ??= 0;
        if (r.failed) counts[stageKey(r.failed)] = (counts[stageKey(r.failed)] ?? 0) + 1;
    }
    return Object.entries(counts).map(([label, catches]) => ({ label, catches }))
        .sort((a, b) => b.catches - a.catches || a.label.localeCompare(b.label));
}

/**
 * Stages the retirement review never proposes (doc 36 G2). They guard secrets, money, auth or
 * migrations, where one missed defect costs more than any friction they add. `check:rules`
 * carries the money and Server Action rules; `check:server-actions` and `check:ownership` are
 * auth; `check:control-plane` backs the secret-read control; `db:check` and `check:migrations`
 * are migrations. A future stage named for one of those areas is exempt too.
 */
export const RETIREMENT_EXEMPT = new Set([
    'check:rules', 'check:server-actions', 'check:ownership', 'check:control-plane', 'check:migrations', 'db:check',
]);
const EXEMPT_NAME = /secret|money|credit|billing|auth|migration/;

/**
 * The gate-retirement review (doc 36 G2): each stage that caught nothing in the window, marked
 * `candidate`, `exempt`, or `too new` when its first recorded run falls inside the window (a
 * 0 over a shorter span is no evidence).
 * @param {Record<string, any>[]} windowRuns gate-timings.jsonl rows inside the window
 * @param {Record<string, any>[]} allRuns every row, to date each stage's first run
 * @param {number} days
 * @param {number} now ms
 */
export function retirementReview(windowRuns, allRuns, days, now = Date.now()) {
    /** @type {Record<string, number>} */
    const firstSeen = {};
    for (const r of allRuns) {
        const ts = Date.parse(r.ts ?? 0);
        for (const st of r.stages ?? []) {
            const k = stageKey(st.label);
            if (!(k in firstSeen) || ts < firstSeen[k]) firstSeen[k] = ts;
        }
    }
    const cutoff = now - days * 86_400_000;
    return stageCatches(windowRuns).filter((s) => s.catches === 0).map(({ label }) => {
        const exempt = RETIREMENT_EXEMPT.has(label) || EXEMPT_NAME.test(label);
        const status = exempt ? 'exempt' : (firstSeen[label] ?? now) > cutoff ? 'too new' : 'candidate';
        return { label, status, firstSeen: Number.isFinite(firstSeen[label]) ? new Date(firstSeen[label]).toISOString().slice(0, 10) : null };
    });
}

/**
 * Fix share and rework per tool (doc 36 M2). Rework = a `fix` commit touching a file that a
 * `feat` commit changed in the `reworkDays` before it. Delivery stability stays in dora:report.
 * @param {{ ts: number, subject: string, tool: string, files: string[] }[]} commits newest first or any order
 */
export function commitStats(commits, reworkDays = 14) {
    const isFix = (c) => /^fix(\(|!|:)/.test(c.subject);
    const isFeat = (c) => /^feat(\(|!|:)/.test(c.subject);
    const feats = commits.filter(isFeat);
    /** @type {Record<string, { commits: number, fixes: number, rework: number }>} */
    const out = {};
    for (const c of commits) {
        const t = (out[toolOf(c)] ??= { commits: 0, fixes: 0, rework: 0 });
        t.commits += 1;
        if (!isFix(c)) continue;
        t.fixes += 1;
        const reworked = feats.some((f) => f.ts < c.ts && c.ts - f.ts <= reworkDays * 86_400
            && f.files.some((p) => c.files.includes(p)));
        if (reworked) t.rework += 1;
    }
    return out;
}

/** Non-merge commits of the last `days`, with their `Agent-Tool` trailer and files. */
export function readCommits(days, cwd = process.cwd()) {
    const r = spawnSync('git', ['log', `--since=${days}.days`, '--no-merges', '--name-only',
        '--format=%x1e%ct%x1f%s%x1f%(trailers:key=Agent-Tool,valueonly,separator=%x2c)'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) return [];
    return r.stdout.split('\x1e').filter((b) => b.trim()).map((block) => {
        const [head, ...rest] = block.split('\n');
        const [ts, subject, tool] = head.split('\x1f');
        return { ts: Number(ts), subject: subject ?? '', tool: (tool ?? '').trim().toLowerCase(), files: rest.map((l) => l.trim()).filter(Boolean) };
    });
}

/**
 * @param {{ conclusion: string, headSha: string }[]} ci completed CI runs
 * @param {Record<string, any>[]} gateRuns
 */
export function ciStats(ci, gateRuns) {
    const done = ci.filter((r) => r.conclusion === 'success' || r.conclusion === 'failure');
    const failed = done.filter((r) => r.conclusion === 'failure');
    const green = gateRuns.filter((r) => r.mode === 'quick' && r.ok && r.sha).map((r) => r.sha);
    const afterGreen = done.filter((r) => green.some((s) => r.headSha.startsWith(s)));
    const escapes = afterGreen.filter((r) => r.conclusion === 'failure').length;
    return { runs: done.length, failed: failed.length, afterGreen: afterGreen.length, escapes };
}

function readCi(days) {
    const r = spawnSync('gh', ['run', 'list', '--workflow', 'ci.yml', '--limit', '200', '--json', 'conclusion,headSha,createdAt'],
        { encoding: 'utf8', timeout: 30_000 });
    if (r.status !== 0) return null;
    try { return JSON.parse(r.stdout).filter(since(days, Date.now())); } catch { return null; }
}

export function contextBytes(root = process.cwd()) {
    const files = STARTUP_FILES.map((f) => {
        try { return { file: f, bytes: fs.statSync(path.join(root, f)).size }; } catch { return { file: f, bytes: 0 }; }
    });
    return { files, total: files.reduce((a, f) => a + f.bytes, 0) };
}

/**
 * Tokens per session from Claude Code transcripts (`~/.claude/projects/<slug>/*.jsonl`).
 * Claude-only and best effort: the other tools keep no local usage record this script can
 * read, so they report n/a rather than a guess.
 */
export function claudeTokens(days, root = process.cwd(), home = os.homedir()) {
    // Claude names the project folder after the main checkout path, with separators as '-'.
    const top = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).stdout?.trim();
    const main = top ? path.dirname(top) : root;
    const dir = path.join(home, '.claude', 'projects', main.replace(/[:\\/.]/g, '-'));
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return null; }
    const cutoff = Date.now() - days * 86_400_000;
    const sessions = [];
    for (const f of files) {
        const p = path.join(dir, f);
        if (fs.statSync(p).mtimeMs < cutoff) continue;
        let input = 0, output = 0;
        for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
            if (!line.includes('"usage"')) continue;
            try {
                const u = JSON.parse(line)?.message?.usage;
                if (!u) continue;
                input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
                output += u.output_tokens ?? 0;
            } catch { /* partial line */ }
        }
        if (input || output) sessions.push({ input, output });
    }
    return { sessions: sessions.length, inputP50: median(sessions.map((s) => s.input)), outputP50: median(sessions.map((s) => s.output)) };
}

const fmtS = (s) => (typeof s !== 'number' ? 'n/a' : s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s` : `${s.toFixed(1)}s`);
const fmtK = (n) => (typeof n !== 'number' ? 'n/a' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}K`);

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const argv = process.argv.slice(2);
    const days = Number(argv[argv.indexOf('--days') + 1]) || 30;
    const now = Date.now();
    const allGateRuns = readShared('gate-timings.jsonl');
    const gateRuns = allGateRuns.filter(since(days, now));
    const hooks = readShared('agent-hooks.jsonl').filter(since(days, now));
    const ci = argv.includes('--no-ci') ? null : readCi(days);
    const report = {
        days,
        gate: gateStats(gateRuns),
        gateByTool: gateByTool(gateRuns),
        stageCatches: stageCatches(gateRuns),
        retirement: retirementReview(gateRuns, allGateRuns, days, now),
        commits: commitStats(readCommits(days)),
        stop: stopStats(hooks),
        ci: ci ? ciStats(ci, gateRuns) : null,
        context: contextBytes(),
        tokens: claudeTokens(days),
    };
    if (argv.includes('--json')) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        const { gate, stop, ci: c, context, tokens } = report;
        console.log(`Agent scorecard, last ${days} days (targets: docs/engineering/agent-enforcement.md "Scorecard")`);
        console.log(`  gate:quick p50       ${fmtS(gate.quickP50)}  (${gate.quickRuns} runs, ${gate.quickFailed} failed)`);
        for (const st of gate.slowest) console.log(`    ${st.label.padEnd(30)} ${fmtS(st.p50)}`);
        console.log(`  gate:quick per tool  ${Object.entries(report.gateByTool).map(([t, s]) => `${t} ${s.quickFailed}/${s.quickRuns} failed`).join(' · ') || 'n/a'}`);
        console.log(`  stage catches        (a 0 is reviewed under doc 36 G2: agent-enforcement.md "Gate retirement")`);
        const review = new Map(report.retirement.map((r) => [r.label, r]));
        for (const st of report.stageCatches) {
            const r = review.get(st.label);
            const note = !r ? '' : r.status === 'too new' ? `  too new (first run ${r.firstSeen})` : `  ${r.status}`;
            console.log(`    ${st.label.padEnd(30)} ${st.catches}${note}`);
        }
        console.log(`  commits per tool     ${Object.entries(report.commits).map(([t, s]) => `${t} ${s.commits} (fix ${Math.round((100 * s.fixes) / s.commits)}%, rework ${s.rework})`).join(' · ') || 'n/a'}`);
        console.log(`  stop hook            ${stop.stops} stops · ${stop.blocks} blocks · ${stop.unverified} UNVERIFIED`);
        console.log(c
            ? `  CI                   ${c.runs - c.failed}/${c.runs} passed · escapes after a green gate: ${c.escapes}/${c.afterGreen}`
            : '  CI                   n/a (gh unavailable or --no-ci)');
        console.log(`  startup context      ${(context.total / 1024).toFixed(1)} KB (${context.files.map((f) => `${f.file} ${(f.bytes / 1024).toFixed(1)}`).join(', ')})`);
        console.log(tokens
            ? `  tokens/session p50   input ${fmtK(tokens.inputP50)} incl. cache reads · output ${fmtK(tokens.outputP50)} (${tokens.sessions} Claude sessions; other tools n/a)`
            : '  tokens/session       n/a (no Claude transcripts on this machine)');
    }
}
