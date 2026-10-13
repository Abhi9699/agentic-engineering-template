/**
 * The Executive Review gate — the lane decision, and the citation contract.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is a DETERMINISTIC script. It does not call a model and it is not the CPO or
 * the CTO. Pretending otherwise would be the most expensive way to be wrong: a
 * "council" that is really one model talking to itself produces agreement, and
 * agreement reads as verification.
 *
 * It does two jobs a script can actually do, both free:
 *
 *   1. **Decide the lane.** `agent-system/routing.json` already carries a risk tier
 *      per route, so the fast/strategic split is data, not judgment. A CSS tweak must
 *      never pay for deliberation — that is the cost control without which the whole
 *      programme is unaffordable (Anthropic measure multi-agent at ~15x single-agent).
 *
 *   2. **Assemble the brief, then refuse a verdict that cites nothing.** The facts a
 *      reviewer needs — binding decisions this request touches, lessons already
 *      learned about it, the evidence its route requires — are greppable. Gathering
 *      them costs no tokens. And `--check` turns "a verdict without a citation is
 *      void" from a convention into an exit code.
 *
 * WHY THE CITATION RULE IS THE WHOLE POINT
 *
 * On 2026-09-12 a plan asserted that outbound links cost LinkedIn posts "35-52%" of
 * reach and told the product to print "avoids LinkedIn's 40% reach penalty" in the
 * UI. No source says 40%. The real 2026 figure is 18.8% for body links, and the
 * first-comment workaround it recommended had itself been penalised months earlier.
 * It was caught by a human choosing to check, which is exactly the thing that does
 * not scale.
 *
 * A confident, well-formatted, entirely wrong assessment is indistinguishable from a
 * correct one UNLESS it has to show its sources. So: CPO findings cite a URL with a
 * date; CTO findings cite `file:line`. `--check` fails the review otherwise.
 *
 * ROLE LENSES BY STAGE (doc 34 W10)
 *
 * Every role is a stage-bound checklist, not a persona. `spec` roles write the cited
 * assessment below. `review` roles hand their checklist items, and only those, to the
 * fresh reviewer: `--review` picks them from the diff's paths, so a pure CSS change gets
 * Design and QA and nothing else. `launch` items (DevOps: rollback, flag, migration
 * compatibility, monitoring) print for R3+ routes.
 *
 * THE OTHER ROLES (agent-system/executive-roles.json)
 *
 * CFO, CISO, Legal and DevOps switch on only when a task touches their paths or words,
 * so a CSS change pays for none of them. Each names the framework a real practitioner
 * works from, and its citations must come from an OFFICIAL source (a standards body,
 * a statute, or the vendor's own docs) with a retrieval date: a model without internet
 * access can produce a plausible URL, but not one it was forced to date and that a
 * reviewer can check. A claim nobody could verify is written UNKNOWN, and then the
 * only verdict allowed is BLOCKED — the gate prefers a truthful stop to a fluent guess.
 *
 * Usage:
 *   node scripts/agent-system/exec-review.mjs "<request>" [--paths a,b]
 *   node scripts/agent-system/exec-review.mjs --check <assessment.md>
 *   node scripts/agent-system/exec-review.mjs --review [--paths a,b] [--base develop]
 *   node scripts/agent-system/exec-review.mjs --self-test
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadRouting, buildContract } from './resolve-task.mjs';
import { createContext as createPlanLintContext, lintPlan } from '../plan-lint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Where the lane boundaries sit.
 *
 * R0/R1 are read-only or trivial: routing them through a council spends two model
 * calls to confirm that renaming a variable is fine.
 *
 * R2 (ordinary UI and backend work) is the STANDARD lane: decisions and lessons print,
 * the reviewer's lenses apply to the diff, and the route's evidence is owed, but no
 * written assessment. Until 2026-10-08 R2 was strategic, so "add a tooltip" asked for a
 * CPO market source with a URL and a year. A gate that demands an invented citation for
 * a tooltip teaches agents to invent citations, which is the failure it exists to stop.
 *
 * R3+ (money, schema, prompts, publishing, control plane, release) is STRATEGIC: the
 * cited assessment plus a pre-mortem, before code.
 */
const STRATEGIC_FROM = 'R3';
const STANDARD_FROM = 'R2';
const RISK_ORDER = ['R0', 'R1', 'R2', 'R3', 'R4'];

/**
 * The control-plane lane (2026-10-08): R3, but the assessment is the CTO's option record and
 * the pre-mortem only. The CPO's market source (a URL and a year) has no market to cite for a
 * hook or a gate, and the release checklist (feature flag, migration, production signal) has
 * nothing to flag or migrate, so both asked for filler. The self-review is still owed once per
 * PR. A route opts in with `"lane": "control-plane"` in routing.json.
 */
export const CONTROL_PLANE = 'control-plane';
/** Roles the control-plane lane waives: a required section the route has nothing to put in. */
export const CONTROL_PLANE_WAIVES = ['CPO'];

export function laneFor(risk) {
    const at = RISK_ORDER.indexOf(risk);
    if (at >= RISK_ORDER.indexOf(STRATEGIC_FROM)) return 'strategic';
    return at >= RISK_ORDER.indexOf(STANDARD_FROM) ? 'standard' : 'fast-track';
}

/**
 * The pre-mortem (Klein, HBR 2007: imagine the project has already failed, then explain
 * why). It finds the risks a forward-looking "looks good" review skips, because it asks
 * the author to argue against their own plan. Each answer must be filled; the blast
 * radius must name code.
 */
export const PRE_MORTEM = [
    { field: 'Failure story', hint: 'It is three months later and this change caused an incident. What most likely happened?' },
    { field: 'Blast radius', hint: 'Who and what breaks, with file:line' },
    { field: 'Detection', hint: 'Which test, check, metric or alert catches it, and how fast' },
    { field: 'Rollback', hint: 'How it is undone, and whether any part is a one-way door (data, money, published posts)' },
];

/* ── Executive roles ────────────────────────────────────────────────────── */

/**
 * @typedef {'spec' | 'gates' | 'review' | 'launch'} Stage
 * @typedef {{ id: string, title: string, always: boolean, stages: Stage[], framework: string, citation: string[],
 *   requiredFields: string[], paths: string[], keywords: string[], ownerGates: string[],
 *   checklist: Partial<Record<Stage, string[]>> }} Role
 * @typedef {{ version: number, roles: Role[], officialSources: Record<string, string[] | string> }} RolesConfig
 */

/** @returns {RolesConfig} */
export function loadRoles(root = ROOT) {
    return JSON.parse(readFileSync(path.join(root, 'agent-system/executive-roles.json'), 'utf8'));
}

/** Every official host, flattened. A subdomain of a listed host also counts. */
/** @param {RolesConfig} config @returns {string[]} */
export function officialHosts(config) {
    return Object.entries(config.officialSources)
        .filter(([k]) => !k.startsWith('$'))
        .flatMap(([, hosts]) => /** @type {string[]} */ (hosts));
}

export function isOfficialUrl(url, hosts) {
    let host;
    try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
    return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/** A role path matches a changed path as a prefix (`infra/`) or a suffix (`.tsx`, `actions.ts`). */
/** @param {Role} role @param {string[]} changedPaths */
function pathTriggers(role, changedPaths) {
    const paths = changedPaths.map((p) => p.replace(/\\/g, '/'));
    return role.paths.some((part) => paths.some((p) => p.startsWith(part) || p.endsWith(part)));
}

/**
 * The roles whose assessment a request needs (the `spec` stage): CPO and CTO always, the
 * rest when a changed path starts with one of theirs or the request uses one of their
 * words (whole words, so "trial" does not fire on "industrial"). Review-only roles
 * (Design, QA) never ask for an assessment; their checklist reaches the reviewer instead.
 *
 * @param {string} request @param {string[]} [changedPaths] @param {RolesConfig} [config] @returns {Role[]}
 */
export function rolesFor(request, changedPaths = [], config = loadRoles()) {
    const words = new Set(String(request).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    return config.roles.filter((r) =>
        r.stages.includes('spec') &&
        (r.always || pathTriggers(r, changedPaths) || r.keywords.some((k) => words.has(k))),
    );
}

/**
 * The checklist items the fresh reviewer gets for a diff (doc 34 W10). Paths only, never
 * request words: the diff is a fact, the prompt is a guess. Only the items travel, never
 * the framework prose, so the reviewer's input stays inside its budget (doc 34 W4).
 *
 * @param {string[]} changedPaths @param {RolesConfig} [config]
 * @returns {{ id: string, title: string, items: string[] }[]}
 */
export function reviewLenses(changedPaths, config = loadRoles()) {
    return config.roles
        .filter((r) => r.stages.includes('review') && (r.always || pathTriggers(r, changedPaths)))
        .map((r) => ({ id: r.id, title: r.title, items: r.checklist.review ?? [] }));
}

/**
 * The launch checklist: every `launch` item, for R3+ routes only. Below R3 a change is
 * small and reversible enough that a release checklist is ceremony.
 *
 * @param {string} risk @param {RolesConfig} [config]
 * @returns {{ id: string, title: string, items: string[] }[]}
 */
export function launchChecklist(risk, config = loadRoles()) {
    if (RISK_ORDER.indexOf(risk) < RISK_ORDER.indexOf('R3')) return [];
    return config.roles
        .filter((r) => r.stages.includes('launch'))
        .map((r) => ({ id: r.id, title: r.title, items: r.checklist.launch ?? [] }));
}

/**
 * What the JSON schema cannot say: a stage the role claims needs the matching content,
 * and content may not sit under a stage the role does not claim. Run by check:control-plane
 * (check-graph.mjs), so a role that would silently send the reviewer nothing fails there.
 *
 * @param {RolesConfig} config @returns {string[]}
 */
export function validateRoles(config) {
    const problems = [];
    const seen = new Set();
    for (const r of config.roles) {
        if (seen.has(r.id)) problems.push(`executive role "${r.id}" is declared twice`);
        seen.add(r.id);
        if (r.stages.includes('spec') && r.citation.length === 0) {
            problems.push(`executive role "${r.id}" acts at spec but names no citation rule, so --check could pass it uncited`);
        }
        if (!r.stages.includes('spec') && (r.citation.length > 0 || r.requiredFields.length > 0 || r.keywords.length > 0)) {
            problems.push(`executive role "${r.id}" has spec-only fields (citation, requiredFields, keywords) but no spec stage`);
        }
        for (const stage of ['gates', 'review', 'launch']) {
            const items = r.checklist[stage] ?? [];
            if (r.stages.includes(stage) && items.length === 0) problems.push(`executive role "${r.id}" acts at ${stage} but has no checklist.${stage} items`);
            if (!r.stages.includes(stage) && items.length > 0) problems.push(`executive role "${r.id}" has checklist.${stage} items but no ${stage} stage`);
        }
        if (!r.always && r.paths.length === 0 && r.keywords.length === 0) {
            problems.push(`executive role "${r.id}" can never trigger: not always, no paths, no keywords`);
        }
    }
    return problems;
}

/** Lens lists as text: one heading per role, its items numbered. */
/** @param {string} heading @param {{ id: string, title: string, items: string[] }[]} lenses */
export function renderLenses(heading, lenses) {
    if (lenses.length === 0) return [];
    const out = ['', heading];
    for (const l of lenses) {
        out.push(`  ${l.id} — ${l.title}`);
        l.items.forEach((item, i) => out.push(`    ${i + 1}. ${item}`));
    }
    return out;
}

/**
 * The changed files for `--review` when no `--paths` are given: everything that differs
 * from the base (committed or not) plus untracked files, which is what the reviewer reviews.
 *
 * @param {string} base @param {string} [root]
 */
export function diffPaths(base, root = ROOT) {
    /** @param {string[]} args */
    const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return [...new Set([...git(['diff', '--name-only', base]), ...git(['ls-files', '--others', '--exclude-standard'])])].sort();
}

/**
 * Words worth matching on.
 *
 * SIX characters, not four. At four, "first" and "field" matched seven binding
 * decisions for a request about a first-comment field, of which one was relevant — and
 * a brief that surfaces six false positives teaches the reader to skim past the true
 * one. The floor is a precision/recall trade made deliberately towards precision,
 * because the cost of a missed decision is a conversation and the cost of a noisy brief
 * is the gate being ignored.
 */
const STOPWORDS = new Set([
    'the', 'and', 'for', 'that', 'this', 'with', 'from', 'into', 'when', 'what', 'where',
    'which', 'should', 'would', 'could', 'add', 'make', 'use', 'using', 'new', 'has', 'have',
    'are', 'was', 'were', 'can', 'will', 'our', 'its', 'his', 'her', 'their', 'them', 'they',
    'not', 'but', 'all', 'any', 'how', 'why', 'who', 'get', 'set', 'put', 'run',
]);

export function keywordsOf(request) {
    return [...new Set(
        String(request).toLowerCase().match(/[a-z][a-z-]{5,}/g) ?? [],
    )].filter((w) => !STOPWORDS.has(w));
}

/**
 * Strongest matches first, and not too many of them.
 *
 * A brief is read before work starts, which is the moment attention is scarcest.
 * Five is enough to be useful and few enough to actually be read.
 */
const MAX_HITS = 5;

function rankAndCap(hits) {
    return hits
        .sort((a, b) => b.matched.length - a.matched.length)
        .slice(0, MAX_HITS);
}

/**
 * A numbered §A decision's bold title — which may WRAP.
 *
 * The first version matched the title with `(.+?)` — and `.` does not match a
 * newline. Multi-line binding decision titles can wrap across lines,
 * so a single-line matcher skipped them in silence. Multi-line matching ensures all decisions are scanned.
 *
 * A matcher that silently sees 89% of the corpus is worse than no matcher, because an
 * empty result reads as "nothing to worry about". `[\s\S]` spans lines; the 400-char
 * bound stops a stray `**` from swallowing the rest of the document.
 */
const DECISION_TITLE = /^(\d+)\. \*\*([\s\S]{1,400}?)\*\*/gm;

/**
 * Binding decisions this request appears to touch.
 *
 * `AGENTS.md` §8: §A decisions are binding and must not be re-litigated. A reviewer
 * who does not know one exists will happily re-open it — which has happened, and is
 * cheap to prevent by grepping before anyone thinks.
 */
export function bindingDecisions(request, root = ROOT) {
    const file = path.join(root, 'docs/OPEN_QUESTIONS.md');
    if (!existsSync(file)) return [];

    const text = readFileSync(file, 'utf8');
    const resolvedAt = text.indexOf('## A. Resolved Decisions');
    if (resolvedAt === -1) return [];

    const words = keywordsOf(request);
    if (words.length === 0) return [];

    const hits = [];
    for (const match of text.slice(resolvedAt).matchAll(DECISION_TITLE)) {
        const title = match[2].replace(/\s+/g, ' ').trim();
        const matched = words.filter((w) => title.toLowerCase().includes(w));
        if (matched.length > 0) hits.push({ id: `#${match[1]}`, title, matched });
    }
    return rankAndCap(hits);
}

/**
 * Lessons already recorded about this shape of work.
 *
 * The ledger exists so a defect is not re-derived. Surfacing the relevant ones before
 * the work starts is the difference between a ledger and an archive.
 */
export function relevantLessons(request, root = ROOT) {
    const file = path.join(root, 'vault/_Lessons.md');
    if (!existsSync(file)) return [];

    const text = readFileSync(file, 'utf8');
    const words = keywordsOf(request);
    if (words.length === 0) return [];

    const hits = [];
    for (const match of text.matchAll(/^## (L-\d+) — (.+)$/gm)) {
        const title = match[2];
        const matched = words.filter((w) => title.toLowerCase().includes(w));
        if (matched.length > 0) hits.push({ id: match[1], title, matched });
    }
    return rankAndCap(hits);
}

/** The brief: everything a reviewer needs that a script can establish for free. */
export function buildBrief(request, changedPaths = [], root = ROOT) {
    const cp = loadRouting(root);
    const contract = buildContract(request, changedPaths, cp);

    /*
     * Decisions and lessons are computed BEFORE the routing check, and returned even
     * when routing fails.
     *
     * The original order made the most valuable output conditional on the least
     * reliable input. A request modifying a core subsystem could match no
     * trigger and print NO ROUTE MATCHED while a binding architectural decision
     * forbade the change. The check now scans unconditionally.
     *
     * Neither scan depends on the route. Withholding them costs nothing to fix.
     */
    const decisions = bindingDecisions(request, root);
    const lessons = relevantLessons(request, root);
    const roles = rolesFor(request, changedPaths, loadRoles(root));

    if (!contract.resolved) {
        return {
            request,
            resolved: false,
            recommendation: contract.recommendation,
            bindingDecisions: decisions,
            lessons,
            roles,
        };
    }

    return {
        request,
        resolved: true,
        route: contract.route,
        risk: contract.risk,
        lane: contract.lane === CONTROL_PLANE ? CONTROL_PLANE : laneFor(contract.risk),
        confidence: contract.confidence,
        specialists: contract.specialists,
        requiredEvidence: contract.requiredEvidence,
        humanGates: contract.humanGates,
        decisionRefs: contract.decisionRefs,
        bindingDecisions: decisions,
        lessons,
        roles: contract.lane === CONTROL_PLANE ? roles.filter((r) => !CONTROL_PLANE_WAIVES.includes(r.id)) : roles,
        launch: contract.lane === CONTROL_PLANE ? [] : launchChecklist(contract.risk, loadRoles(root)),
    };
}

/** One line per hit; titles wrap in the source, so they are flattened and clipped here. */
const TITLE_WIDTH = 96;

function renderContext(brief) {
    const out = [];
    const clip = (s) => (s.length > TITLE_WIDTH ? `${s.slice(0, TITLE_WIDTH - 1)}…` : s);

    if (brief.bindingDecisions?.length > 0) {
        out.push('', 'BINDING DECISIONS this request appears to touch (AGENTS.md §8 — do not re-litigate):');
        for (const d of brief.bindingDecisions) out.push(`  ${d.id}  ${clip(d.title)}`);
    }
    if (brief.lessons?.length > 0) {
        out.push('', 'LESSONS already recorded on this shape of work:');
        for (const l of brief.lessons) out.push(`  ${l.id}  ${clip(l.title)}`);
    }
    return out;
}

/* ── The citation contract ──────────────────────────────────────────────── */

const BLOCKED = 'BLOCKED — NEEDS VERIFICATION';
/** Longest first: `includes` would otherwise read every verdict as plain ENDORSED. */
const VERDICTS = [BLOCKED, 'STRONGLY ADVISE AGAINST', 'ENDORSED WITH ARCHITECTURAL REDIRECT', 'ENDORSED'];

/** A URL plus a year, because an undated source is an assertion with a link on it. */
const DATED_SOURCE = /https?:\/\/\S+[\s\S]{0,200}?\b20\d{2}\b|\b20\d{2}\b[\s\S]{0,200}?https?:\/\/\S+/;
/** `path/to/file.ts:123` — the CTO's equivalent of a source. */
const FILE_LINE = /\b[\w./-]+\.(?:ts|tsx|mjs|js|css|json|sql|md|tf|ya?ml):\d+/;
const URLS = /https?:\/\/[^\s)>\]"']+/g;
/** The date the source was read: what makes an official URL a checkable claim. */
const RETRIEVED = /retrieved\s+20\d{2}-\d{2}-\d{2}/i;
const MONEY = /[$₹€]\s?\d|\b\d[\d,.]*\s?(?:USD|INR|EUR|minutes|min)\b/i;
/** An unknown the author judged immaterial must say so; any other UNKNOWN blocks. */
const BLOCKING_UNKNOWN = /\bUNKNOWN\b(?!\s*\(non-blocking)/;

const CITATION_RULES = {
    'dated-url': {
        test: (sec) => DATED_SOURCE.test(sec),
        problem: (id) => `${id} section cites no dated source. A market or platform claim needs a URL and a year — ` +
            'the "40% reach penalty" that prompted this gate was confident, well-formatted and invented.',
    },
    'file-line': {
        test: (sec) => FILE_LINE.test(sec),
        problem: (id) => `${id} section cites no file:line. A blast-radius claim that names no code is a guess ` +
            'about a repository the reviewer can read.',
    },
    'official-url': {
        test: (sec, hosts) => (sec.match(URLS) ?? []).some((u) => isOfficialUrl(u, hosts)) && RETRIEVED.test(sec),
        problem: (id) => `${id} section cites no official source with a retrieval date. Needs a URL from ` +
            'agent-system/executive-roles.json officialSources plus "retrieved YYYY-MM-DD"; a blog cannot stand alone.',
    },
    money: {
        test: (sec) => MONEY.test(sec),
        problem: (id) => `${id} section states no figure. A cost claim without a number is not a cost claim.`,
    },
};

/**
 * Validate a filled-in assessment.
 *
 * This is the enforcement half. Everything above is a convenience; this is the part
 * that makes "a verdict without a citation is void" true rather than aspirational.
 *
 * `requiredRoles` adds the triggered roles (the brief prints them). A role section that
 * is present is always checked, required or not: a CISO opinion does not get to skip
 * the CISO's rules by being volunteered.
 *
 * `waivedRoles` drops an always-required role for a lane that has nothing for it to cite
 * (CONTROL_PLANE_WAIVES); a waived section that is present is still checked.
 *
 * @param {string} text @param {{ requiredRoles?: string[], waivedRoles?: string[], config?: RolesConfig, preMortem?: boolean }} [options]
 */
export function checkAssessment(text, { requiredRoles = [], waivedRoles = [], config = loadRoles(), preMortem = false } = {}) {
    const problems = [];
    const hosts = officialHosts(config);

    if (preMortem) {
        const sec = sectionOf(text, 'Pre-mortem');
        if (!sec) {
            problems.push('No Pre-mortem section. R3+ work answers the four pre-mortem questions before code.');
        } else {
            for (const { field } of PRE_MORTEM) {
                if (!new RegExp(`${escapeRegExp(field)}[ \\t]*:[ \\t]*\\S`, 'i').test(sec)) {
                    problems.push(`Pre-mortem is missing "${field}:".`);
                }
            }
            const radius = /blast radius\s*:([^\n]*)/i.exec(sec)?.[1] ?? '';
            if (radius && !FILE_LINE.test(radius)) problems.push('Pre-mortem "Blast radius:" names no file:line.');
        }
    }

    const verdict = VERDICTS.find((v) => text.includes(v));
    if (!verdict) {
        problems.push(`No verdict. Exactly one of: ${VERDICTS.join(' | ')}`);
    }

    for (const role of config.roles) {
        const required = (role.always && !waivedRoles.includes(role.id)) || requiredRoles.includes(role.id);
        const sec = sectionOf(text, role.id);
        if (!sec) {
            if (required) problems.push(`No ${role.id} section. Expected a heading containing "${role.id}".`);
            continue;
        }
        for (const kind of role.citation) {
            const rule = CITATION_RULES[kind];
            if (!rule.test(sec, hosts)) problems.push(rule.problem(role.id));
        }
        for (const field of role.requiredFields) {
            // Same line only: `\s*` let "Option A:" match across the newline into the
            // next "- Option B:", so an assessment of empty fields passed.
            const filled = new RegExp(`${escapeRegExp(field)}[ \\t]*:[ \\t]*\\S`, 'i');
            if (!filled.test(sec)) problems.push(`${role.id} section is missing "${field}:" (${role.framework}).`);
        }
    }

    if (verdict && verdict !== BLOCKED && BLOCKING_UNKNOWN.test(text)) {
        problems.push(
            `An UNKNOWN is present but the verdict is "${verdict}". Verify it from an official source, ` +
            `mark it "UNKNOWN (non-blocking): <why>", or return "${BLOCKED}".`,
        );
    }

    return { ok: problems.length === 0, verdict: verdict ?? null, problems };
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The text under a heading mentioning `role`, up to the next heading of equal or higher rank. */
function sectionOf(text, role) {
    const heading = new RegExp(`^(#{1,6})\\s*.*\\b${role}\\b.*$`, 'mi');
    const found = heading.exec(text);
    if (!found) return null;

    const depth = found[1].length;
    const rest = text.slice(found.index + found[0].length);
    const next = new RegExp(`^#{1,${depth}}\\s`, 'm').exec(rest);
    return next ? rest.slice(0, next.index) : rest;
}

/* ── Output ─────────────────────────────────────────────────────────────── */

/** What each citation rule demands, shown in the template so the author knows before --check says so. */
const RULE_HINT = {
    'dated-url': '<URL + year. REQUIRED — an undated claim fails --check>',
    'file-line': '<file:line. REQUIRED — an uncited claim fails --check>',
    'official-url': '<official URL (executive-roles.json officialSources) + "retrieved YYYY-MM-DD" + a short verbatim quote. REQUIRED>',
    money: '<a figure: $, ₹ or CI minutes. REQUIRED>',
};

/**
 * The assessment skeleton, generated from the role data so the template and --check cannot drift.
 *
 * @param {Role[]} roles @param {{ preMortem?: boolean, lane?: string | null }} [options]
 */
export function templateFor(roles, { preMortem = false, lane = null } = {}) {
    const extra = roles.filter((r) => !r.always).map((r) => r.id);
    const out = [
        '',
        'Fill this in, then verify it:  node scripts/agent-system/exec-review.mjs --check <file>' +
            (extra.length > 0 ? ` --roles ${extra.join(',')}` : '') + (preMortem ? ' --pre-mortem' : '') +
            (lane === CONTROL_PLANE ? ` --lane ${CONTROL_PLANE}` : ''),
        'Cannot verify a claim from an official source? Write UNKNOWN and use the BLOCKED verdict.',
        '',
        '# Executive Assessment: <task>',
        '',
        '## Verdict',
        `<one of: ${VERDICTS.join(' | ')}>`,
    ];
    for (const r of roles) {
        out.push('', `## ${r.id} — ${r.title}`, `Framework: ${r.framework}`);
        for (const f of r.requiredFields) out.push(`- ${f}:`);
        for (const c of r.citation) out.push(`- Source: ${RULE_HINT[c]}`);
        if (r.ownerGates.length > 0) out.push(`- Owner decides: ${r.ownerGates.join('; ')}`);
    }
    if (preMortem) {
        out.push('', '## Pre-mortem');
        for (const q of PRE_MORTEM) out.push(`- ${q.field}: <${q.hint}>`);
    }
    return out.join('\n');
}

function render(brief) {
    const out = [];
    if (!brief.resolved) {
        out.push('exec:review — NO ROUTE MATCHED', '', brief.recommendation);
        /*
         * Unrouted is not uninformed. A request the trigger table does not recognise is
         * often a NEW feature — exactly the case where an existing binding decision is
         * most likely to be about to be re-opened by someone who does not know it exists.
         */
        out.push('', `Roles that would apply: ${brief.roles.map((r) => r.id).join(', ')}`);
        out.push(...renderContext(brief));
        return out.join('\n');
    }

    out.push(`exec:review — ${brief.route}  [${brief.risk}]  lane: ${brief.lane}`, '');

    if (brief.lane === 'fast-track') {
        out.push(
            'FAST-TRACK. No executive review: this route is read-only or low risk, and a',
            'council here spends two model calls to confirm that a small change is small.',
            '',
            `Evidence still required: ${brief.requiredEvidence.join(', ')}`,
        );
        return out.join('\n');
    }

    if (brief.lane === 'standard') {
        out.push(
            'STANDARD. No written assessment. Before code, state in one line the assumption',
            'that would change the build if it were wrong, and check it against the code.',
            '',
            `Specialist:       ${brief.specialists.join(', ')}`,
            `Evidence:         ${brief.requiredEvidence.join(', ')}`,
            'Review:           the reviewer applies `exec:review --review` lenses to the diff',
        );
        out.push(...renderContext(brief));
        return out.join('\n');
    }

    const slim = brief.lane === CONTROL_PLANE;
    out.push(slim
        ? 'CONTROL PLANE. The CTO option record and a pre-mortem before code; a cited self-review once per PR (npm run review:pack).'
        : 'STRATEGIC. An Executive Assessment and a pre-mortem are required before code is written.', '');
    out.push(`Specialist:       ${brief.specialists.join(', ')}`);
    out.push(`Evidence:         ${brief.requiredEvidence.join(', ')}`);
    if (brief.humanGates.length > 0) out.push(`Human gate:       ${brief.humanGates.join('; ')}`);
    if (brief.decisionRefs.length > 0) out.push(`Route decisions:  ${brief.decisionRefs.join(', ')}`);

    out.push(`Roles:            ${brief.roles.map((r) => r.id).join(', ')}`);
    out.push(...renderContext(brief));
    out.push(...renderLenses('LAUNCH CHECKLIST (R3+; answer each in the PR description):', brief.launch ?? []));

    out.push(templateFor(brief.roles, { preMortem: true, lane: brief.lane }));
    return out.join('\n');
}

/* ── CLI ────────────────────────────────────────────────────────────────── */

function selfTest() {
    const cases = [];
    const ok = (name, pass) => cases.push({ name, pass });

    ok('R0 routes to fast-track', laneFor('R0') === 'fast-track');
    ok('R2 routes to standard', laneFor('R2') === 'standard');
    ok('R3 routes to strategic', laneFor('R3') === 'strategic');
    ok('R4 routes to strategic', laneFor('R4') === 'strategic');

    const missingAll = checkAssessment('nothing here');
    ok('an empty assessment fails', !missingAll.ok);
    ok('  ...and says a verdict is missing', missingAll.problems.some((p) => p.includes('No verdict')));

    const uncited = checkAssessment(
        '# A\n## Verdict\nENDORSED\n## CPO\nLooks good to me.\n## CTO\nNo real risk.\n',
    );
    ok('a verdict with no citations fails', !uncited.ok);
    ok('  ...naming the CPO source', uncited.problems.some((p) => p.includes('CPO section cites no dated source')));
    ok('  ...naming the CTO file:line', uncited.problems.some((p) => p.includes('CTO section cites no file:line')));

    const cited = checkAssessment(
        '# A\n## Verdict\n🛑 STRONGLY ADVISE AGAINST\n' +
        '## CPO — worth building\nPenalised in 2026, see https://example.com/study\n' +
        '## CTO — blast radius\nTwo callers at lib/services/orchestration.service.ts:463\n' +
        'Option A: keep. Option B: remove. Reversibility: two-way door.\n',
    );
    ok('a cited assessment passes', cited.ok);
    ok('  ...and reports the verdict', cited.verdict === 'STRONGLY ADVISE AGAINST');

    const base = '## CPO\nhttps://example.com 2026\n## CTO\na.ts:1 Option A: x Option B: y Reversibility: z\n';
    const blog = checkAssessment(
        `## Verdict\nENDORSED\n${base}## DevOps\nPlan: p Rollback: r Blast radius: b Monthly cost change: $0 ` +
        'infra/x.tf:1 https://blog.example.com retrieved 2026-09-25\n',
    );
    ok('a triggered role citing a blog fails', blog.problems.some((p) => p.includes('DevOps section cites no official source')));

    const unknown = checkAssessment(`## Verdict\nENDORSED\n${base}Region UNKNOWN\n`);
    ok('an UNKNOWN cannot be ENDORSED', unknown.problems.some((p) => p.includes('UNKNOWN is present')));
    const blocked = checkAssessment(`## Verdict\nBLOCKED — NEEDS VERIFICATION\n${base}Region UNKNOWN\n`);
    ok('  ...but can be BLOCKED', blocked.ok);

    const lensIds = (paths) => reviewLenses(paths).map((l) => l.id);
    ok('a pure CSS change gets only the Design and QA lenses', lensIds(['components/ui/button.module.css']).join() === 'Design,QA');
    ok('a Server Action gets the CISO, QA and Data lenses', ['CISO', 'QA', 'Data'].every((id) => lensIds(['app/studio/actions.ts']).includes(id)));
    ok('R3 prints the launch checklist; R2 does not', launchChecklist('R3').length > 0 && launchChecklist('R2').length === 0);
    ok('the shipped roles are internally consistent', validateRoles(loadRoles()).length === 0);

    for (const c of cases) console.log(`  ${c.pass ? 'ok  ' : 'FAIL'}  ${c.name}`);
    const failed = cases.filter((c) => !c.pass).length;
    if (failed > 0) {
        console.error(`\nexec:review --self-test FAILED — ${failed} case(s).`);
        process.exit(1);
    }
    console.log(`\nexec:review --self-test OK — ${cases.length} cases.`);
}

/*
 * Guarded the way `resolve-task.mjs` guards its own CLI: this module exports the
 * functions its tests import, and an unguarded `process.exit(1)` on the "no request"
 * path would fire the moment a test file imported it.
 */
/** `--flag a,b` or `--flag=a,b`, as a list. */
export function flagValue(args, flag) {
    const i = args.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
    if (i < 0) return [];
    const raw = args[i].includes('=') ? args[i].split('=')[1] : args[i + 1] ?? '';
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * The request words: everything that is neither a flag nor a flag's value. Filtering
 * only `--` prefixes let `--paths a,b` leak "a,b" into the request text.
 */
export function positionalArgs(args) {
    const out = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--paths' || args[i] === '--roles' || args[i] === '--base' || args[i] === '--lane') { i++; continue; }
        if (!args[i].startsWith('--')) out.push(args[i]);
    }
    return out;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
const argv = process.argv.slice(2);

if (!isMain) {
    /* Imported for its exports. The CLI below is not ours to run. */
} else if (argv.includes('--self-test')) {
    selfTest();
} else if (argv[0] === '--review') {
    /*
     * The reviewer's role lenses for the current diff (doc 34 W10). Read-only, so the
     * reviewer may run it itself under the read-only shell guard.
     */
    const given = flagValue(argv, '--paths');
    const paths = given.length > 0 ? given : diffPaths(flagValue(argv, '--base')[0] ?? 'develop');
    const lenses = reviewLenses(paths);
    console.log(`exec:review --review — ${paths.length} changed path(s); lenses: ${lenses.map((l) => l.id).join(', ') || 'none'}`);
    console.log(renderLenses('Check the diff against each item; report only the ones it breaks, with file:line:', lenses).join('\n'));
} else if (argv[0] === '--check') {
    const file = argv[1];
    if (!file || !existsSync(file)) {
        console.error('exec:review --check <file> — assessment file not found.');
        process.exit(1);
    }
    const text = readFileSync(file, 'utf8');
    const lane = flagValue(argv, '--lane')[0];
    const result = checkAssessment(text, {
        requiredRoles: flagValue(argv, '--roles'),
        waivedRoles: lane === CONTROL_PLANE ? CONTROL_PLANE_WAIVES : [],
        // The control-plane lane keeps the pre-mortem whether or not the flag was copied.
        preMortem: argv.includes('--pre-mortem') || lane === CONTROL_PLANE,
    });
    // A citation must also be TRUE (doc 32 section 3.7): no dead file:line, no decision
    // quote the decision does not contain. plan:lint's assessment mode checks exactly that.
    for (const f of lintPlan(text, { ...createPlanLintContext(), mode: 'assessment' })) {
        result.problems.push(`line ${f.line} [${f.check}] ${f.detail}`);
        result.ok = false;
    }
    if (!result.ok) {
        console.error('exec:review --check FAILED — this assessment does not meet the citation contract:\n');
        for (const p of result.problems) console.error(`  - ${p}`);
        console.error('\nA verdict without a citation is void. That is the entire point of the gate.');
        process.exit(1);
    }
    console.log(`exec:review --check OK — verdict "${result.verdict}", every role cited.`);
} else {
    const request = positionalArgs(argv).join(' ');
    if (!request) {
        console.error('Usage: node scripts/agent-system/exec-review.mjs "<request>" [--paths a,b]');
        process.exit(1);
    }
    const changedPaths = flagValue(argv, '--paths');

    console.log(render(buildBrief(request, changedPaths)));
}
