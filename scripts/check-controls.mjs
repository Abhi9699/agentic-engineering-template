#!/usr/bin/env node
/**
 * check:controls - the control catalog (doc 33 §3, GOV-13) is checked against reality.
 *
 *   npm run check:controls                  # catalog + coverage + generated checklist (gate, CI)
 *   npm run check:controls -- --strict      # also fail on overdue records (release)
 *   npm run check:controls -- --write       # regenerate docs/generated/controls-checklist.md
 *   npm run check:controls -- --diff [ref]  # controls touched by the paths changed vs ref
 *   npm run check:controls -- --route <id>  # controls that apply to an agent-system route
 *
 * WHY (doc 33 §2): the repo had 135 named controls spread over prose, and a control
 * that exists only as a sentence protects nothing (L-042). Each row in
 * agent-system/controls.json must name a mechanism that EXISTS and, when it claims to
 * block, one that CI actually runs. Planned rows are allowed and reported as planned:
 * a mechanism may ship before its catalog fills (L-061), never the reverse.
 *
 *   mechanism   `npm:` script exists (block + active: reachable from gate:full or a
 *               workflow) · `rule:` a block rule in scripts/lib/hard-rules.mjs · `test:`
 *               a Vitest file · `workflow:` / `ruleset:` / `file:` exist · `evidence:`
 *               an evidence.json id · `record:` a doc carrying `Last reviewed: YYYY-MM-DD` ·
 *               `hook:` a guard script wired into a git hook, .claude/settings.json or an
 *               agent adapter (it blocks at the tool call, not in CI; its selfTest runs in CI)
 *   self-test   an active block control names the test that seeds a violation (L-053);
 *               the gaps that predate this check are a ratchet (SELF_TEST_GAPS)
 *   records     a record older than reviewEveryDays warns; `--strict` fails it
 *   coverage    every id vendored in agent-system/frameworks.json is referenced by a
 *               control or carries a disposition; a ref to an unknown id fails
 *   checklist   judgment controls and record due dates are generated for reviewer
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RULES, FILE_RULES } from './lib/hard-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CHECKLIST = 'docs/generated/controls-checklist.md';
const VITEST_DIRS = /^(app|components|lib|scripts|infra)\/.*\.test\.tsx?$/;
const PREFIX = {
    SEC: 'security', AI: 'ai', AGT: 'agents', SUP: 'supply-chain', PRV: 'privacy', REL: 'reliability',
    PERF: 'performance', COST: 'cost', A11Y: 'accessibility', OBS: 'observability', DATA: 'data',
    GOV: 'governance', QUAL: 'quality', VEN: 'vendor', EXEC: 'review', LEG: 'legal',
};
/** Active block controls without a seeded-violation test when this check landed. Shrink only. */
export const SELF_TEST_GAPS = ['AGT-01', 'AGT-03', 'AGT-04', 'AGT-05', 'AGT-06', 'AGT-07', 'GOV-01', 'GOV-02'];
const ENFORCED_KINDS = new Set(['rule', 'test', 'workflow', 'ruleset', 'hook']);
const HOOK_SOURCES = ['.claude/settings.json', 'agent-system/hooks.json', '.githooks', '.claude/agents'];
const DAY = 86_400_000;

const readJson = (root, rel) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));

/** Everything the checks read, gathered once so tests can hand in a seeded copy. */
export function loadContext(root = ROOT, today = new Date()) {
    const wfDir = path.join(root, '.github/workflows');
    const workflowsText = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f))
        .map((f) => readFileSync(path.join(wfDir, f), 'utf8')).join('\n');
    const hookText = HOOK_SOURCES.flatMap((rel) => {
        const abs = path.join(root, rel);
        if (!existsSync(abs)) return [];
        if (statSync(abs).isDirectory()) return readdirSync(abs).map((f) => readFileSync(path.join(abs, f), 'utf8'));
        return [readFileSync(abs, 'utf8')];
    }).join('\n');
    return {
        hookText,
        catalog: readJson(root, 'agent-system/controls.json'),
        frameworks: readJson(root, 'agent-system/frameworks.json').frameworks,
        routing: readJson(root, 'agent-system/routing.json'),
        scripts: readJson(root, 'package.json').scripts,
        evidenceIds: new Set(readJson(root, 'agent-system/evidence.json').evidenceTypes.map((e) => e.id)),
        blockRules: new Set([...RULES, ...FILE_RULES].filter((r) => r.severity === 'block').map((r) => r.id)),
        workflowsText,
        exists: (rel) => existsSync(path.join(root, rel)),
        read: (rel) => readFileSync(path.join(root, rel), 'utf8'),
        today,
    };
}

/** npm scripts reachable from gate:full or any workflow step, following nested `npm run`. */
export function ciReachableScripts(scripts, workflowsText) {
    const seen = new Set();
    const visit = (text) => {
        for (const [, name] of text.matchAll(/npm run ([\w:.-]+)/g)) {
            if (seen.has(name) || !(name in scripts)) continue;
            seen.add(name);
            visit(scripts[name]);
        }
        if (/\bnpm (?:run )?test\b/.test(text)) seen.add('test');
    };
    visit(`npm run gate:full\n${workflowsText}`);
    return seen;
}

const reviewedOn = (text) => text.match(/Last reviewed:\*{0,2}\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;

/** @returns {{ errors: string[], warnings: string[], coverage: object[], records: object[] }} */
export function checkCatalog(ctx, { strict = false } = {}) {
    const errors = [];
    const warnings = [];
    const records = [];
    const { controls, pillarPaths } = ctx.catalog;
    const reachable = ciReachableScripts(ctx.scripts, ctx.workflowsText);
    const seen = new Set();

    for (const c of controls) {
        const at = `${c.id}:`;
        if (seen.has(c.id)) errors.push(`${at} duplicate id`);
        seen.add(c.id);
        const pillar = PREFIX[c.id.split('-')[0]];
        if (pillar !== c.pillar) errors.push(`${at} pillar "${c.pillar}" does not match its prefix (expected "${pillar}")`);
        if (!pillarPaths[c.pillar]) errors.push(`${at} pillar "${c.pillar}" has no pillarPaths entry`);

        const live = c.status !== 'planned';
        if (c.status === 'active' && c.phase !== 'now') errors.push(`${at} active controls have phase "now"`);
        if (c.status !== 'active' && c.phase === 'now') errors.push(`${at} a ${c.status} control needs the phase of its remaining work`);
        const judgmentOnly = c.modes.every((m) => m === 'judgment');
        if (live && !judgmentOnly && c.mechanisms.length === 0 && c.status === 'active') {
            errors.push(`${at} active but names no mechanism (a control that is only a sentence protects nothing)`);
        }

        let ciEnforced = false;
        for (const m of c.mechanisms) {
            const [kind, ...rest] = m.split(':');
            const ref = rest.join(':');
            const bad = (why) => errors.push(`${at} mechanism ${m}: ${why}`);
            if (kind === 'npm') {
                if (!(ref in ctx.scripts)) bad('no such npm script');
                else if (reachable.has(ref)) ciEnforced = true;
            } else if (kind === 'rule') {
                if (!ctx.blockRules.has(ref)) bad('not a block rule in scripts/lib/hard-rules.mjs');
            } else if (kind === 'test') {
                if (!VITEST_DIRS.test(ref)) bad('not a Vitest file under app/ components/ lib/ scripts/ infra/');
                else if (!ctx.exists(ref)) bad('file does not exist');
            } else if (kind === 'workflow' || kind === 'ruleset') {
                if (!ctx.exists(`.github/${kind}s/${ref}`)) bad('file does not exist');
            } else if (kind === 'hook') {
                if (!ctx.exists(ref)) bad('file does not exist');
                else if (!ctx.hookText.includes(path.posix.basename(ref))) bad('not wired into any git hook, settings.json or agent adapter');
            } else if (kind === 'file') {
                if (!ctx.exists(ref)) bad('file does not exist');
            } else if (kind === 'evidence') {
                if (!ctx.evidenceIds.has(ref)) bad('not an evidence.json id');
            } else if (kind === 'record') {
                if (!ctx.exists(ref)) { bad('record does not exist'); continue; }
                const date = reviewedOn(ctx.read(ref));
                if (!date) { bad('record has no "Last reviewed: YYYY-MM-DD" line'); continue; }
                if (!c.reviewEveryDays) { errors.push(`${at} a record mechanism needs reviewEveryDays`); continue; }
                const due = new Date(Date.parse(date) + c.reviewEveryDays * DAY);
                records.push({ id: c.id, record: ref, reviewed: date, due: due.toISOString().slice(0, 10) });
                if (due < ctx.today) (strict ? errors : warnings).push(`${at} ${ref} last reviewed ${date}, overdue since ${due.toISOString().slice(0, 10)}`);
            }
            if (ENFORCED_KINDS.has(kind)) ciEnforced = true;
        }

        if (c.status === 'active' && c.modes.includes('block') && !ciEnforced) {
            errors.push(`${at} claims to block but none of its mechanisms runs in CI or a hook`);
        }
        if (c.status === 'active' && c.modes.includes('record') && !c.mechanisms.some((m) => m.startsWith('record:'))) {
            errors.push(`${at} an active record control needs a record: mechanism`);
        }
        if (c.selfTest !== null) {
            if (!VITEST_DIRS.test(c.selfTest) || !ctx.exists(c.selfTest)) errors.push(`${at} selfTest ${c.selfTest} is not an existing Vitest file`);
        } else if (c.status === 'active' && c.modes.includes('block') && !SELF_TEST_GAPS.includes(c.id)) {
            errors.push(`${at} active block control has no seeded-violation selfTest (L-053)`);
        }
    }
    for (const id of SELF_TEST_GAPS) {
        const c = controls.find((x) => x.id === id);
        if (c?.selfTest) errors.push(`${id}: has a selfTest now; remove it from SELF_TEST_GAPS`);
    }

    return { errors, warnings, records, coverage: checkCoverage(ctx, errors, warnings) };
}

function checkCoverage(ctx, errors, warnings) {
    const byFramework = new Map(ctx.frameworks.map((f) => [f.id, f]));
    const refs = new Map(); // "fw:id" -> statuses
    for (const c of ctx.catalog.controls) {
        for (const r of c.refs) {
            const m = r.match(/^([a-z0-9]+):(.+)$/);
            if (!m) continue;
            const fw = byFramework.get(m[1]);
            if (!fw) { errors.push(`${c.id}: ref ${r} names an unknown framework`); continue; }
            if (!fw.items.some((i) => i.id === m[2])) { errors.push(`${c.id}: ref ${r} is not an id in ${fw.name}`); continue; }
            refs.set(r, [...(refs.get(r) ?? []), c.status]);
        }
    }
    return ctx.frameworks.map((fw) => {
        const row = { id: fw.id, name: fw.name, total: fw.items.length, active: 0, planned: 0, disposed: 0 };
        for (const d of Object.keys(fw.dispositions)) {
            if (!fw.items.some((i) => i.id === d)) errors.push(`frameworks ${fw.id}: disposition for unknown id ${d}`);
            if (fw.dispositions[d].status === 'accepted-risk' && !fw.dispositions[d].decision) errors.push(`frameworks ${fw.id}:${d}: accepted-risk needs an owner decision (OQ-n)`);
        }
        for (const item of fw.items) {
            const statuses = refs.get(`${fw.id}:${item.id}`) ?? [];
            const disposed = fw.dispositions[item.id];
            if (statuses.some((s) => s !== 'planned')) {
                row.active++;
                if (disposed) warnings.push(`frameworks ${fw.id}:${item.id}: covered by a live control and also disposed as ${disposed.status}`);
            } else if (statuses.length) row.planned++;
            else if (disposed) row.disposed++;
            else errors.push(`frameworks ${fw.id}:${item.id} (${item.title}): no control and no disposition`);
        }
        return row;
    });
}

const esc = (s) => s.replace(/\|/g, '\\|');

/** The reviewer's generated section: judgment controls plus the record schedule. */
export function renderChecklist(ctx, records) {
    const lines = [
        '# Controls checklist (generated)',
        '',
        '> Generated by `npm run check:controls -- --write` from `agent-system/controls.json`. Do not edit.',
        '> `reviewer` walks the judgment list on every review; no machine catches these.',
        '',
        '## Judgment controls (review every diff that touches the pillar)',
        '',
        '| ID | Pillar | Control | Status |',
        '|---|---|---|---|',
    ];
    for (const c of ctx.catalog.controls.filter((x) => x.modes.includes('judgment'))) {
        lines.push(`| ${c.id} | ${c.pillar} | ${esc(c.title)} | ${c.status} |`);
    }
    lines.push('', '## Records and their next review', '', '| ID | Record | Last reviewed | Due |', '|---|---|---|---|');
    for (const r of records) lines.push(`| ${r.id} | \`${r.record}\` | ${r.reviewed} | ${r.due} |`);
    return `${lines.join('\n')}\n`;
}

const globToRegex = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);

/** Pillars whose pillarPaths match any of the paths. */
export function pillarsForPaths(catalog, paths) {
    const hits = new Set();
    for (const [pillar, globs] of Object.entries(catalog.pillarPaths)) {
        const res = globs.map(globToRegex);
        if (paths.some((p) => res.some((re) => re.test(p)))) hits.add(pillar);
    }
    return [...hits].sort();
}

export function controlsForPillars(catalog, pillars) {
    return catalog.controls.filter((c) => pillars.includes(c.pillar) && c.status !== 'planned');
}

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

function changedPaths(ref) {
    let base = null;
    for (const r of ref ? [ref] : ['origin/develop', 'develop']) {
        try { base = git(['merge-base', r, 'HEAD']); break; } catch { /* next */ }
    }
    if (!base) throw new Error(`cannot resolve a base (${ref ?? 'origin/develop'})`);
    const tracked = git(['diff', '--name-only', base]).split('\n');
    const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n');
    return [...tracked, ...untracked].filter(Boolean);
}

const printControls = (list) => {
    for (const c of list) console.log(`  ${c.id.padEnd(8)} ${c.status.padEnd(8)} ${c.title}`);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const argv = process.argv.slice(2);
    const ctx = loadContext();
    const flag = (name) => argv.indexOf(name);

    if (flag('--route') !== -1) {
        const id = argv[flag('--route') + 1];
        const route = ctx.routing.routes.find((r) => r.id === id);
        if (!route) { console.error(`unknown route ${id}`); process.exit(1); }
        console.log(`Controls for route ${id} (pillars: ${(route.pillars ?? []).join(', ') || 'none'}):`);
        printControls(controlsForPillars(ctx.catalog, route.pillars ?? []));
        process.exit(0);
    }
    if (flag('--diff') !== -1) {
        const next = argv[flag('--diff') + 1];
        const pillars = pillarsForPaths(ctx.catalog, changedPaths(next && !next.startsWith('--') ? next : null));
        console.log(`Changed paths touch pillars: ${pillars.join(', ') || 'none'}. Live controls to satisfy:`);
        printControls(controlsForPillars(ctx.catalog, pillars));
        process.exit(0);
    }

    const { errors, warnings, records, coverage } = checkCatalog(ctx, { strict: flag('--strict') !== -1 });
    const checklist = renderChecklist(ctx, records);
    if (flag('--write') !== -1) {
        writeFileSync(path.join(ROOT, CHECKLIST), checklist);
        console.log(`wrote ${CHECKLIST}`);
    } else if (!ctx.exists(CHECKLIST) || ctx.read(CHECKLIST).replace(/\r\n/g, '\n') !== checklist) {
        errors.push(`${CHECKLIST} is stale: run npm run check:controls -- --write`);
    }

    for (const w of warnings) console.warn(`WARN ${w}`);
    if (errors.length) {
        for (const e of errors) console.error(`FAIL ${e}`);
        console.error(`\ncheck:controls: ${errors.length} problem(s).`);
        process.exit(1);
    }
    const n = (s) => ctx.catalog.controls.filter((c) => c.status === s).length;
    console.log(`check:controls OK - ${ctx.catalog.controls.length} controls (${n('active')} active, ${n('partial')} partial, ${n('planned')} planned), ${records.length} records.`);
    console.log(`  coverage (live / planned-only / n-a or inherited, of total): ${coverage.map((c) => `${c.id} ${c.active}/${c.planned}/${c.disposed} of ${c.total}`).join(' · ')}`);
}
