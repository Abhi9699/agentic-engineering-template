#!/usr/bin/env node
/**
 * One review per PR, from one packet, with every claim checked against the code.
 *
 *   node scripts/agent-system/review.mjs pack  [--base <ref>] [--delta]
 *   node scripts/agent-system/review.mjs check <review.md> --actor <main-session|reviewer|human:role>
 *
 * WHY (2026-10-08). The fresh-context reviewer cost a median 2.3M and up to 13.9M context
 * tokens per run: 42 Opus runs, 129M tokens in all. The review itself was not the cost. The
 * cost was 50-127 turns spent rebuilding the diff with `grep`/`sed`/`git diff`, re-running
 * tests the gate had already proved, and fixing PATH. Each turn re-sends the whole context.
 * The receipt also went stale on every edit, so one task paid for several full reviews.
 *
 * So, as in human code review, the reviewer reads one prepared change set, and the CI results
 * arrive attached rather than re-run:
 * - `pack` writes the packet: the branch diff of the reviewed paths, the role checklist with
 *   item ids, and a template. With `--delta` the diff runs from the last receipt's commit, so a
 *   re-review after a BLOCK reads only the fix.
 * - `check` is what stops a review from being a hallucinated "looks good":
 *   - every checklist id must be answered;
 *   - every `ok` or `finding` must quote text that really sits at the cited `file:line` of a
 *     file in the change;
 *   - an `n/a` must say why;
 *   - the verdict must agree with the findings.
 *   Only a review that passes is recorded. `evidence-receipt.mjs` refuses these types without one.
 *
 * Who reviews: the main session, for the control plane (`self-review`); it already holds the
 * context, so this costs a few turns. The fresh-context `reviewer` (`review`) keeps money,
 * auth, schema and prompts, where independence is worth a spawn. Both use this packet and
 * this check.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { changedPaths, mergeBase } from './check-evidence.mjs';
import { RECEIPT_DIR, receiptPath, record } from './evidence-receipt.mjs';
import { reviewLenses } from './exec-review.mjs';

/** Evidence types whose receipt needs a checked review file. */
export const REVIEW_TYPES = ['review', 'self-review'];
/** Answered in every review, whatever the paths: the two questions self-review most often skips. */
export const ALWAYS_ITEMS = [
    ['PREMISE', 'Is this the right change at all: not a reopened §A decision, not a duplicate of something that exists?'],
    ['RISK', 'The most likely way this breaks after merge, and the line that shows it is handled'],
];
const STATUSES = new Set(['ok', 'finding', 'n/a']);
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
/** Generated or vendored files: their source is what gets reviewed. */
const NOT_REVIEWED = /^(docs\/generated\/|\.claude\/agents\/|\.codex\/|\.agents\/agents\/|package-lock\.json$)/;

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

function globRe(glob) {
    return new RegExp('^' + glob.split('**').map((s) => s.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*') + '$');
}

/** The default base: where this branch left develop. */
export const defaultBase = mergeBase;

/**
 * Which review types this change owes and which paths are reviewed. Changed tests ride along
 * so the QA items can be judged from their assertions.
 */
export function reviewScope(root, paths) {
    const types = readJson(path.join(root, 'agent-system/evidence.json')).evidenceTypes.filter((e) => REVIEW_TYPES.includes(e.id));
    const owed = [];
    const reviewed = new Set();
    for (const t of types) {
        const res = (t.changedPaths ?? []).map(globRe);
        const hit = paths.filter((p) => res.some((re) => re.test(p)));
        if (hit.length) {
            owed.push(t.id);
            hit.forEach((p) => reviewed.add(p));
        }
    }
    for (const p of paths) if (/(__tests__\/|\.test\.)/.test(p)) reviewed.add(p);
    return { owed, reviewed: [...reviewed].filter((p) => !NOT_REVIEWED.test(p)).sort() };
}

/** Checklist items, each with a stable id such as `CISO.4`. */
export function checklistFor(paths) {
    const items = ALWAYS_ITEMS.map(([id, text]) => ({ id, text }));
    for (const lens of reviewLenses(paths)) lens.items.forEach((text, i) => items.push({ id: `${lens.id}.${i + 1}`, text }));
    return items;
}

const TEMPLATE_RULES = `Answer EVERY id, one line each; \`review:check\` rejects the file otherwise:
- \`- <ID> ok: path:line "exact text on that line"\`. The quote proves the item holds; at least 6 characters, found within 3 lines of the cited line.
- \`- <ID> finding <Critical|High|Medium|Low>: path:line "exact text" - what is wrong\`
- \`- <ID> n/a: <why this item does not apply to this diff>\`
Cite files from the diff below. Do not re-run tests or tsc, because the gate already proved them; read an assertion only to judge it. Open a file outside the packet only to confirm a specific suspicion.
The first line is \`verdict: PASS\` or \`verdict: BLOCK\`. BLOCK is required when a Critical or High finding stands.`;

/** Build the packet text. Pure apart from git. */
export function buildPacket(root, { base = defaultBase(root), delta = false } = {}) {
    let from = base;
    let prior = '';
    if (delta) {
        const last = REVIEW_TYPES.map((id) => receiptPath(root, id)).filter(existsSync).map(readJson).sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1))[0];
        if (!last?.head) throw new Error('no earlier review receipt with a commit to diff from - run a full pack first');
        from = last.head;
        prior = last.reviewFile && existsSync(path.join(root, last.reviewFile)) ? readFileSync(path.join(root, last.reviewFile), 'utf8') : '';
    }
    const scope = reviewScope(root, changedPaths(root, from));
    if (!scope.owed.length && !delta) return { owed: [], text: '' };
    const items = checklistFor(scope.reviewed);
    const diff = scope.reviewed.length ? git(root, ['diff', '-U8', from, '--', ...scope.reviewed]) : '';
    const text = [
        `# Review packet${delta ? ' (delta)' : ''}`,
        '',
        `base: ${base}`,
        `${delta ? 'delta-from' : 'diff-from'}: ${from}`,
        `head: ${git(root, ['rev-parse', 'HEAD'])}`,
        `owed: ${scope.owed.join(', ') || '(only the delta of an earlier review)'}`,
        `reviewer: ${scope.owed.includes('review') ? 'the fresh-context reviewer subagent (money, auth, schema, prompts or the security boundary changed)' : 'the main session (self-review)'}`,
        `files (${scope.reviewed.length}): ${scope.reviewed.join(', ')}`,
        '',
        '## How to answer',
        '',
        TEMPLATE_RULES,
        '',
        '## Template',
        '',
        'verdict: PASS',
        ...(delta ? [`delta-from: ${from}`] : []),
        ...items.map((it) => `- ${it.id} ?: ${it.text}`),
        ...(prior ? ['', '## Earlier review (check each of its findings is fixed)', '', prior.trim()] : []),
        '',
        '## Diff',
        '',
        '```diff',
        diff,
        '```',
    ].join('\n');
    return { owed: scope.owed, text, items };
}

const LINE = /^- ([A-Za-z]+(?:\.\d+)?) (ok|finding|n\/a)(?: (Critical|High|Medium|Low))?: (.*)$/;
const CITE = /([\w./@[\]-]+):(\d+)\s+"([^"]{6,})"/;

/**
 * Validate a review against the code. Pure apart from reading the cited files.
 * @returns {{ ok: boolean, problems: string[], verdict?: string }}
 */
export function checkReview(root, text, { reviewed, items }) {
    const problems = [];
    const lines = text.split(/\r?\n/);
    const verdict = lines.find((l) => l.trim())?.match(/^verdict:\s*(PASS|BLOCK)\s*$/)?.[1];
    if (!verdict) problems.push('the first line must be "verdict: PASS" or "verdict: BLOCK"');
    const answered = new Map();
    for (const l of lines) {
        const m = l.match(LINE);
        if (!m) continue;
        const [, id, status, severity, rest] = m;
        if (!STATUSES.has(status)) continue;
        answered.set(id, true);
        if (status === 'n/a') {
            if (rest.trim().length < 10) problems.push(`${id}: an n/a needs a reason`);
            continue;
        }
        if (status === 'finding' && !SEVERITIES.includes(severity ?? '')) problems.push(`${id}: a finding needs a severity`);
        if (status === 'finding' && (severity === 'Critical' || severity === 'High') && verdict === 'PASS') {
            problems.push(`${id}: a ${severity} finding stands, so the verdict must be BLOCK`);
        }
        const c = rest.match(CITE);
        if (!c) {
            problems.push(`${id}: cite path:line "exact text" (6+ chars) - an uncited ${status} is a claim, not evidence`);
            continue;
        }
        const [, file, lineNo, quote] = c;
        const rel = file.replace(/\\/g, '/').replace(/^\.\//, '');
        if (!reviewed.includes(rel)) {
            problems.push(`${id}: ${rel} is not a file in this change - cite the diff`);
            continue;
        }
        const abs = path.join(root, rel);
        if (!existsSync(abs)) {
            problems.push(`${id}: ${rel} does not exist`);
            continue;
        }
        const src = readFileSync(abs, 'utf8').split(/\r?\n/);
        const n = Number(lineNo);
        const window = src.slice(Math.max(0, n - 4), n + 3).join('\n');
        if (!window.includes(quote)) problems.push(`${id}: "${quote}" is not at ${rel}:${n} (checked lines ${Math.max(1, n - 3)}-${n + 3})`);
    }
    for (const it of items) if (!answered.has(it.id)) problems.push(`${it.id}: not answered (${it.text.slice(0, 60)})`);
    return { ok: problems.length === 0, problems, verdict };
}

/** Check the review and, only if it holds, record the receipts the change owes. */
export function checkAndRecord(root, file, { actor, base = defaultBase(root) }) {
    const text = readFileSync(file, 'utf8');
    const scope = reviewScope(root, changedPaths(root, base));
    // A delta review answers for the fix only, so it must follow a recorded review of that commit.
    const deltaFrom = text.match(/^delta-from:\s*([0-9a-f]{7,40})\s*$/m)?.[1];
    let judged = scope;
    if (deltaFrom) {
        const prior = REVIEW_TYPES.map((id) => receiptPath(root, id)).filter(existsSync).map(readJson);
        if (!prior.some((r) => r.head?.startsWith(deltaFrom) || deltaFrom.startsWith(r.head ?? '-'))) {
            return { ok: false, problems: [`delta-from ${deltaFrom} is not the commit of a recorded review - run a full pack`] };
        }
        judged = reviewScope(root, changedPaths(root, deltaFrom));
    }
    const items = checklistFor(judged.reviewed);
    const result = checkReview(root, text, { reviewed: judged.reviewed, items });
    if (!result.ok) return { ok: false, problems: result.problems };
    // Independence is the point of `review`: the session that wrote the change cannot sign it.
    // Checked before anything is recorded, so a refusal leaves no half-written receipts.
    if (scope.owed.includes('review') && actor === 'main-session') {
        return { ok: false, problems: ['money, auth, schema, prompts or the security boundary changed: the fresh-context reviewer must sign this review, not the main session'] };
    }
    mkdirSync(path.join(root, RECEIPT_DIR), { recursive: true });
    const recorded = [];
    for (const id of scope.owed) {
        const keep = path.join(RECEIPT_DIR, `${id}.review.md`);
        writeFileSync(path.join(root, keep), text);
        const r = record(root, id, { actor, base, artifact: `${result.verdict}: ${keep}`, reviewFile: keep, verdict: result.verdict });
        if (!r.ok) return { ok: false, problems: [r.reason] };
        recorded.push(id);
    }
    return { ok: true, recorded, verdict: result.verdict };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const args = process.argv.slice(2);
    const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
    const root = process.cwd();
    const base = value('--base') ?? defaultBase(root);
    if (args[0] === 'pack') {
        const { owed, text } = buildPacket(root, { base, delta: args.includes('--delta') });
        if (!text) {
            console.log('review:pack - this change owes no review.');
            process.exit(0);
        }
        mkdirSync(path.join(root, RECEIPT_DIR), { recursive: true });
        const out = path.join(RECEIPT_DIR, 'review-packet.md');
        writeFileSync(path.join(root, out), text);
        console.log(`review:pack - ${out} (${Math.round(text.length / 1024)} KB, owes ${owed.join(', ') || 'delta'}). Copy its Template into a review file, answer every id, then: npm run review:check -- <file> --actor <main-session|reviewer>`);
        process.exit(0);
    }
    if (args[0] === 'check' && args[1]) {
        const r = checkAndRecord(root, args[1], { actor: value('--actor') ?? null, base });
        if (!r.ok) {
            console.error(`review:check - rejected (${r.problems.length}):\n${r.problems.map((p) => `  - ${p}`).join('\n')}`);
            process.exit(1);
        }
        console.log(`review:check - ${r.verdict}; recorded ${r.recorded.join(', ') || 'nothing (no review owed)'}.${r.verdict === 'BLOCK' ? ' A BLOCK does not clear pre-push: fix, then review:pack -- --delta.' : ''}`);
        process.exit(0);
    }
    console.error('usage: review.mjs pack [--base <ref>] [--delta] | check <review.md> --actor <id> [--base <ref>]');
    process.exit(2);
}
