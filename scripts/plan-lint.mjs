#!/usr/bin/env node
/**
 * plan:lint - a plan's citations are checked for TRUTH, not just presence.
 *
 *   npm run plan:lint                       # plan docs changed vs origin/develop (gate)
 *   npm run plan:lint -- --base <ref>       # ... vs a given base (CI passes the PR base)
 *   npm run plan:lint -- <doc.md> [...]     # explicit docs, every check (the new-doc bar)
 *
 * WHY (doc 32 section 3 item 7; doc 33 GOV-04, P0): `exec:review --check` only checked that
 * a citation EXISTS. The coach plan passed that bar through three revisions while it still
 * carried a decision claim #65 never made, a colliding decision number (#101), a feature
 * with no column to hold its data, and a retention rule with no mechanism. Each check
 * below is a pattern an agent cannot argue its way around. They catch those classes of
 * mistake, not every mistake: owner review of the decision stays the final gate.
 *
 *   dead-file-line     `path:line` (or `path:a-b`) whose file is missing or too short.
 *   decision-collision a draft `### #N` / `P-N` whose number is already a section A
 *                      decision, and that section A never mentions (a silent reuse).
 *   decision-claim     "decision #N" must quote, in backticks on the same line, a phrase
 *                      that occurs in #N's text. A range ("#59-65") is a pointer, not a claim.
 *   cost-without-pool  a paragraph with a per-action/day/generation USD figure must name
 *                      its pool: `freeActionBudgetUsd` or `AI_CREDIT_COSTS`.
 *   readiness          the `## Readiness` block (doc 32 section 3 item 1, the two
 *                      section 3.7 fields and GOV-03 threat model) is missing, or a field is empty or too vague.
 *
 * RATCHET (see MODES). A plan ADDED on the branch gets every check. An existing plan that
 * is edited gets the line-local checks on the edited lines only: its old citations are
 * history (files move), but new text meets the new bar. `exec:review --check` runs the
 * citation checks on an assessment. "Plan doc" = markdown under docs/ whose file name
 * says plan or proposal, or whose opening lines say "Status: proposed".
 *
 * Offline and fast: git plus the filesystem. Exit 0 clean, 1 findings.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { checkPrOrigin } from './check-main-merge-origin.mjs';
import { loadRouting } from './agent-system/resolve-task.mjs';
import { checkPlanReview, riskRaised } from './lib/plan-review-gate.mjs';

const ROOT = process.cwd();
const DECISIONS_DOC = 'docs/OPEN_QUESTIONS.md';

/* ── Parsing helpers ─────────────────────────────────────────────────── */

/** Lines with fenced code blocks blanked, so examples are not read as claims. */
export function proseLines(text) {
    let fenced = false;
    return text.split(/\r?\n/).map((line) => {
        if (/^\s*(```|~~~)/.test(line)) {
            fenced = !fenced;
            return '';
        }
        return fenced ? '' : line;
    });
}

const normalize = (s) => s.toLowerCase().replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Section A decisions as { number -> text }. Section A is the numbered list under
 * `## A.`; each item runs until the next item or heading.
 */
export function parseDecisions(text) {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((l) => /^## A\b/.test(l));
    const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
    const section = lines.slice(start + 1, end === -1 ? undefined : end);
    const decisions = new Map();
    let current = null;
    for (const line of section) {
        const item = line.match(/^(\d+)\.\s+(.*)$/);
        if (item) {
            current = Number(item[1]);
            decisions.set(current, item[2]);
        } else if (/^#{1,6} /.test(line)) {
            current = null;
        } else if (current !== null) {
            decisions.set(current, `${decisions.get(current)} ${line}`);
        }
    }
    return { decisions, sectionText: section.join('\n') };
}

/**
 * Line counts for every tracked file a citation could mean, or [null] when none exists.
 * Plans cite repo-relative paths, and also shortened ones (`refine/route.ts`,
 * `.../list/row.tsx`, a bare file name); those resolve by path suffix.
 */
export function makeLineCounter(root, trackedFiles) {
    const cache = new Map();
    const count = (rel) => {
        if (!cache.has(rel)) {
            const abs = path.join(root, rel);
            cache.set(rel, existsSync(abs) ? readFileSync(abs, 'utf8').split(/\r?\n/).length : null);
        }
        return cache.get(rel);
    };
    return (cited) => {
        const rel = cited.replace(/^(?:\.{2,3}\/|\.\/)+/, '');
        if (rel === cited && count(rel) !== null) return [count(rel)];
        const matches = trackedFiles().filter((f) => f === rel || f.endsWith(`/${rel}`));
        return matches.length ? matches.map(count) : [null];
    };
}

/* ── Checks ──────────────────────────────────────────────────────────── */

const FILE_LINE = /(?<![\w/.:-])((?:\.{2,3}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|mjs|cjs|js|css|json|sql|md|tf|ya?ml|sh)):(\d+)(?:-(\d+))?\b/g;

export function checkFileLines(lines, lineCounts) {
    const findings = [];
    lines.forEach((line, i) => {
        const prose = line.replace(/https?:\/\/\S+/g, '');
        for (const m of prose.matchAll(FILE_LINE)) {
            const [, file, a, b] = m;
            const last = Number(b ?? a);
            const counts = lineCounts(file);
            if (counts.every((c) => c === null)) {
                findings.push({ check: 'dead-file-line', line: i + 1, detail: `${m[0]}: no such file` });
            } else if (!counts.some((c) => c !== null && last <= c && Number(a) >= 1)) {
                const size = counts.filter((c) => c !== null).join('/');
                findings.push({ check: 'dead-file-line', line: i + 1, detail: `${m[0]}: file has ${size} lines` });
            }
        }
    });
    return findings;
}

export function checkCollisions(lines, { decisions, sectionText }) {
    const findings = [];
    lines.forEach((line, i) => {
        const draft = line.match(/^#{2,6}\s+#(\d+)\b/) ?? line.match(/^\s*(?:[-*]\s+)?(?:#{2,6}\s+|\*\*)P-(\d+)\b/);
        if (!draft) return;
        const n = Number(draft[1]);
        const id = draft[0].includes('P-') ? `P-${n}` : `#${n}`;
        if (!decisions.has(n)) return;
        // A P-number section A itself mentions has been reconciled by the owner (e.g. "P-117 -> #115").
        if (id.startsWith('P-') && new RegExp(`\\b${id}\\b`).test(sectionText)) return;
        findings.push({
            check: 'decision-collision',
            line: i + 1,
            detail: `${id} reuses the number of section A decision #${n}; renumber the draft or reconcile it in section A`,
        });
    });
    return findings;
}

const DECISION_CITE = /\b(?:decisions?|§A|section A)\s+\**#(\d+)\**(?!\d|\s*[-–]\s*#?\d)/gi;

export function checkDecisionClaims(lines, { decisions }) {
    const findings = [];
    lines.forEach((line, i) => {
        for (const m of line.matchAll(DECISION_CITE)) {
            const n = Number(m[1]);
            const text = decisions.get(n);
            if (text === undefined) {
                findings.push({ check: 'decision-claim', line: i + 1, detail: `decision #${n} does not exist in section A` });
                continue;
            }
            const quotes = [...line.slice(m.index + m[0].length).matchAll(/`([^`]{3,})`/g)].map((q) => q[1]);
            if (!quotes.length) {
                findings.push({ check: 'decision-claim', line: i + 1, detail: `decision #${n} cited without a \`quoted phrase\` from its text` });
            } else if (!quotes.some((q) => normalize(text).includes(normalize(q)))) {
                const listed = quotes.map((q) => `"${q}"`).join(', ');
                findings.push({ check: 'decision-claim', line: i + 1, detail: `decision #${n} contains none of: ${listed}` });
            }
        }
    });
    return findings;
}

const RATE = /[$]\s?\d[\d,.]*\s*(?:\/|per\s+)\s*(?:day|action|generation|gen|call|request|user)\b/i;
const POOL = /freeActionBudgetUsd|AI_CREDIT_COSTS/;

export function checkCostPools(lines) {
    const findings = [];
    let para = [];
    const flush = () => {
        const text = para.map((p) => p.text).join(' ');
        if (para.length && RATE.test(text) && !POOL.test(text)) {
            findings.push({
                check: 'cost-without-pool',
                line: para[0].n,
                span: [para[0].n, para[para.length - 1].n],
                detail: `"${text.match(RATE)[0]}" names no budget pool (freeActionBudgetUsd or AI_CREDIT_COSTS)`,
            });
        }
        para = [];
    };
    lines.forEach((text, i) => (text.trim() ? para.push({ text, n: i + 1 }) : flush()));
    flush();
    return findings;
}

/** doc 32 section 3 item 1, the two fields section 3.7 adds, and doc 33 GOV-03's threat model. */
export const READINESS_FIELDS = [
    'Data classes', 'Retention', 'Cost per action', 'Failure mode', 'SLO impact',
    'Load expectation', 'Abuse vector', 'Data model delta', 'Retention mechanism', 'Threat model',
];
/**
 * GOV-03, STRIDE lite: name at least one STRIDE category and its mitigation, or say "none"
 * with the tier that exempts it (R0-R2). An R3+ plan cannot claim "none".
 */
const STRIDE = /\b(spoofing|tampering|repudiation|information disclosure|denial of service|elevation of privilege)\b/i;
const EMPTY = /^(?:|-|—|tbd|todo|n\/a|\?|\.\.\.)$/i;
const CODE_REF = /`[^`]+`|\b[\w./-]+\.(?:ts|tsx|mjs|js|sql)\b/;

export function checkReadiness(lines) {
    const start = lines.findIndex((l) => /^##\s+Readiness\b/i.test(l));
    if (start === -1) {
        return [{ check: 'readiness', line: 1, detail: 'no `## Readiness` section (doc 32 section 3 item 1)' }];
    }
    const end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l));
    const block = lines.slice(start + 1, end === -1 ? undefined : end);
    const findings = [];
    for (const field of READINESS_FIELDS) {
        // Bullet `- **Field:** value` or table row `| Field | value |`. The label may run on
        // ("Data classes touched", "Cost per action (typical/worst)") up to its colon.
        const re = new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\|\\s*)?\\**${field}[^:|*]{0,40}\\**\\s*(?::|\\|)\\**\\s*(.*)$`, 'i');
        const idx = block.findIndex((l) => re.test(l) && !(field === 'Retention' && /retention mechanism/i.test(l)));
        if (idx === -1) {
            findings.push({ check: 'readiness', line: start + 1, detail: `Readiness field "${field}" is missing` });
            continue;
        }
        const value = block[idx].match(re)[1].replace(/\|\s*$/, '').trim();
        const at = start + 2 + idx;
        if (EMPTY.test(value)) {
            findings.push({ check: 'readiness', line: at, detail: `Readiness field "${field}" is empty` });
        } else if (field === 'Data model delta' && !/^none\b/i.test(value) && !/`\w+\.\w+`/.test(value)) {
            findings.push({ check: 'readiness', line: at, detail: 'Data model delta must name each new column as `table.column`, or say "none"' });
        } else if (field === 'Retention mechanism' && !/^none\b/i.test(value) && !(CODE_REF.test(value) && /\btest/i.test(value))) {
            findings.push({ check: 'readiness', line: at, detail: 'Retention mechanism must name the enforcing code path (or cron) and its test; a period alone ("90-day TTL") fails' });
        } else if (field === 'Threat model' && !STRIDE.test(value) && !/^none\b.*\bR[0-2]\b/i.test(value)) {
            findings.push({ check: 'readiness', line: at, detail: 'Threat model must name a STRIDE category and its mitigation, or say "none" with the R0-R2 tier that exempts it' });
        }
    }
    return findings;
}

/* ── Orchestration ───────────────────────────────────────────────────── */

/**
 * Which checks run. `full`: a new plan, every check. `changed`: an existing plan that was
 * edited; the line-local checks, limited to the edited lines. `assessment`: an
 * `exec:review --check` file, whose citations must be true but which is not a plan.
 */
export const MODES = {
    full: ['file-line', 'collision', 'claim', 'cost', 'readiness', 'review'],
    changed: ['file-line', 'collision', 'claim', 'cost'],
    assessment: ['file-line', 'collision', 'claim'],
};

/**
 * @param {string} text  the document
 * @param {{ decisionsText: string, lineCounts: (f: string) => (number|null)[],
 *           mode?: 'full'|'changed'|'assessment', onlyLines?: Set<number>, routing?: object,
 *           baseText?: string }} ctx
 *   `routing` (from createContext) arms the `review` check; a fixture without it tests the rest.
 *   `baseText` (changed mode): the plan before the edit. If the edit raises the plan's risk
 *   tier, `review` runs on the whole document, not only the edited lines (L-083).
 */
export function lintPlan(text, { decisionsText, lineCounts, mode = 'full', onlyLines, routing, baseText }) {
    const lines = proseLines(text);
    const parsed = parseDecisions(decisionsText);
    const run = new Set(MODES[mode]);
    const armed = routing && (run.has('review') || (baseText !== undefined && riskRaised(baseText, text, routing)));
    const review = armed ? checkPlanReview(lines, { routing, riskText: text }) : [];
    const findings = [
        ...(run.has('file-line') ? checkFileLines(lines, lineCounts) : []),
        ...(run.has('collision') ? checkCollisions(lines, parsed) : []),
        ...(run.has('claim') ? checkDecisionClaims(lines, parsed) : []),
        ...(run.has('cost') ? checkCostPools(lines) : []),
        ...(run.has('readiness') ? checkReadiness(lines) : []),
    ];
    const touched = (f) => {
        if (!onlyLines) return true;
        const [a, b] = f.span ?? [f.line, f.line];
        for (let n = a; n <= b; n++) if (onlyLines.has(n)) return true;
        return false;
    };
    return [...findings.filter(touched), ...review]
        .sort((a, b) => a.line - b.line)
        .map(({ span: _span, ...f }) => f);
}

/** New-side line numbers that a `git diff -U0` adds or changes. */
export function changedLines(unifiedDiff) {
    const out = new Set();
    for (const m of unifiedDiff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
        const start = Number(m[1]);
        const len = m[2] === undefined ? 1 : Number(m[2]);
        for (let n = start; n < start + len; n++) out.add(n);
    }
    return out;
}

export function isPlanDoc(file, text) {
    if (!/^docs\/.*\.md$/.test(file) || file.startsWith('docs/generated/')) return false;
    if (/(?:^|[-_/])(?:plan|proposal)s?(?:[-_.]|$)/i.test(path.posix.basename(file))) return true;
    const head = text.split(/\r?\n/).slice(0, 12).join('\n');
    return /status:\s*\**\s*proposed/i.test(head) || /^\|\s*\**Lifecycle\**\s*\|\s*\**\s*proposed/im.test(head);
}

const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/**
 * The repo's decisions and a line counter over its files. Untracked (not ignored) files
 * count too: a plan may cite a file written on the same branch, not yet committed.
 */
export function createContext(root = ROOT) {
    let tracked;
    const trackedFiles = () => (tracked ??= git(['ls-files', '--cached', '--others', '--exclude-standard'], root).split('\n'));
    const candidates = [
        path.join(root, 'vault/Open-Questions.md'),
        path.join(root, 'vault/Decisions.md'),
        path.join(root, DECISIONS_DOC)
    ];
    const foundDoc = candidates.find((p) => existsSync(p));
    return {
        decisionsText: foundDoc ? readFileSync(foundDoc, 'utf8') : '',
        lineCounts: makeLineCounter(root, trackedFiles),
        routing: loadRouting(root),
    };
}

/**
 * A release PR is this repo's `develop` into `main`. Every plan doc it carries already
 * passed plan:lint on its own PR into develop (PR-only ruleset), so diffing it against
 * main would re-lint, as "added", every plan since the last release (#304: 45 findings
 * on docs that were legal when merged). Anything else into main is not a release.
 *
 * @param {Record<string, string | undefined>} env CI's BASE_REF, HEAD_REF, HEAD_REPO, BASE_REPO
 */
export function isReleasePr(env) {
    const pr = { baseRef: env.BASE_REF, headRef: env.HEAD_REF, headRepo: env.HEAD_REPO, baseRepo: env.BASE_REPO };
    return pr.baseRef === 'main' && checkPrOrigin(pr).ok;
}

function resolveBase(explicit) {
    for (const ref of explicit ? [explicit] : ['origin/develop', 'develop']) {
        try {
            return git(['merge-base', ref, 'HEAD']);
        } catch { /* try the next ref */ }
    }
    return null;
}

/** The file at the base, read from its old path when it was renamed (`from`). */
function baseVersion(base, file) {
    try {
        return git(['show', `${base}:${file}`]);
    } catch {
        return '';
    }
}

/** Plan docs changed vs the base, working tree included. */
function changedPlanDocs(base) {
    const rows = git(['diff', '--name-status', '-M', '--diff-filter=AMR', base]).split('\n').filter(Boolean);
    const untracked = git(['ls-files', '--others', '--exclude-standard', 'docs']).split('\n').filter(Boolean);
    return [
        ...rows.map((row) => {
            const parts = row.split('\t');
            // A rename (`git mv`, e.g. into docs/archive/) is linted like an edit: only the lines
            // it changes against the old path, not the whole history it carries (doc 36 C3).
            return { status: parts[0][0], file: parts[parts.length - 1], from: parts[0][0] === 'R' ? parts[1] : undefined };
        }),
        ...untracked.map((file) => ({ status: 'A', file })),
    ].filter(({ file }) => existsSync(path.join(ROOT, file)) && isPlanDoc(file, readFileSync(path.join(ROOT, file), 'utf8')));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const argv = process.argv.slice(2).filter((a) => a !== '--terse');
    const baseAt = argv.indexOf('--base');
    const baseRef = baseAt === -1 ? null : argv[baseAt + 1];
    const args = baseAt === -1 ? argv : argv.filter((_, i) => i !== baseAt && i !== baseAt + 1);
    const ctx = createContext();

    let targets;
    if (args.length) {
        targets = args.map((f) => ({ file: f.replace(/\\/g, '/'), mode: 'full' }));
    } else if (isReleasePr(process.env)) {
        console.log(`plan:lint - release PR (${process.env.HEAD_REPO}:develop into main): plan docs were linted on their PRs into develop.`);
        targets = [];
    } else {
        const base = resolveBase(baseRef);
        if (!base) {
            // Fail closed: an unresolvable base must not read as "no plans changed".
            console.error(`plan:lint - cannot resolve ${baseRef ?? 'origin/develop'}; pass --base <ref> or the docs to lint.`);
            process.exit(1);
        }
        targets = changedPlanDocs(base).map(({ file, status, from }) => (status === 'A'
            ? { file, mode: 'full' }
            : { file, mode: 'changed', onlyLines: changedLines(git(['diff', '-U0', '-M', base, '--', ...(from ? [from] : []), file])), baseText: baseVersion(base, from ?? file) }));
    }

    let total = 0;
    for (const { file, mode, onlyLines, baseText } of targets) {
        if (!existsSync(path.join(ROOT, file))) {
            console.error(`plan:lint - ${file}: not found`);
            total++;
            continue;
        }
        const findings = lintPlan(readFileSync(path.join(ROOT, file), 'utf8'), { ...ctx, mode, onlyLines, baseText });
        for (const f of findings) console.error(`plan:lint - ${file}:${f.line} [${f.check}] ${f.detail}`);
        total += findings.length;
    }
    if (total) {
        console.error(`\nplan:lint - ${total} finding(s). Fix the citation; do not weaken the check (doc 32 section 3.7).`);
        process.exit(1);
    }
    console.log(`plan:lint - OK (${targets.length} plan doc(s) checked)`);
}
