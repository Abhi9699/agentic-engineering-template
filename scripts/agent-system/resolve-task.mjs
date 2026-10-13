#!/usr/bin/env node
/**
 * Task routing (A4) — turn a request into the compact contract from plan §4.
 *
 *   node scripts/agent-system/resolve-task.mjs "the paywall returns 403"
 *   node scripts/agent-system/resolve-task.mjs --paths lib/db/schema.ts app/studio/page.tsx
 *   node scripts/agent-system/resolve-task.mjs --json "..."
 *
 * This makes routing.json load-bearing rather than decorative: the same manifest that
 * check-graph validates is what decides which specialist, which skills, and which
 * evidence a request needs.
 *
 * DELIBERATE LIMITATION. Classification is keyword-and-path based, not a model call —
 * it is deterministic, free, and offline, and it is also easily fooled by unusual
 * phrasing. It therefore RECOMMENDS; it never authorizes. When two routes tie, the
 * higher risk wins, because being over-careful costs time and being under-careful
 * costs money or data. An unmatched request resolves to the highest-risk plausible
 * route rather than the lowest, and says so.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const RISK_ORDER = ['R0', 'R1', 'R2', 'R3', 'R4'];

/** Changed-path → route hints. Paths are stronger evidence than words. */
const PATH_ROUTES = [
    [/^lib\/db\/(schema\.ts|migrations\/)/, 'data-schema-change'],
    [/^lib\/config\/(prompt-registry|gemini\.config)\.ts$|^lib\/config\/prompts\//, 'ai-pipeline-change'],
    [/^lib\/repositories\/gemini\.repository\.ts$/, 'ai-pipeline-change'],
    [/^lib\/services\/subscription\.service\.ts$/, 'money-change'],
    [/^app\/api\/webhooks\//, 'money-change'],
    [/^(lib|src)\/config\/constants\.ts$/, 'money-change'],
    [/^(app|components)\//, 'ui-change'],
    [/^lib\//, 'backend-change'],
    // Instruction files every provider loads (AGT-06): editing one changes what every
    // agent does next, so it is the control-plane route and its human gate.
    [/^(AGENTS|CLAUDE|GEMINI)\.md$|^\.cursorrules$|^llms\.txt$|^\.github\/copilot-instructions\.md$/, 'control-plane-change'],
    [/^(agent-system|\.claude|\.codex|\.agents|\.agent|\.githooks)\//, 'control-plane-change'],
    [/^\.github\/agents\//, 'control-plane-change'],
    [/^\.cursor\/agents\//, 'control-plane-change'],
    [/^\.github\/workflows\//, 'control-plane-change'],
    // Guards, hooks and the gate decide what every agent may do: control plane.
    [/^scripts\/(guard-[^/]+|gate)\.mjs$|^scripts\/(hooks|agent-system)\//, 'control-plane-change'],
    // Fail closed (2026-10-08 review): any other code or config path (auth proxy, package
    // manifests, build config, scripts) floors at R2, so "typo" wording cannot drop it to R1.
    // Only prose and static assets stay unfloored.
    [/^(?!docs\/|vault\/|public\/)(?!.*\.(md|mdx|txt|png|jpe?g|svg|webp|gif)$)./, 'backend-change'],
];

export function loadRouting(root = process.cwd()) {
    return {
        routes: readJson(path.join(root, 'agent-system/routing.json')).routes,
        agents: readJson(path.join(root, 'agent-system/agents.json')).agents,
        evidence: readJson(path.join(root, 'agent-system/evidence.json')).evidenceTypes,
        skills: readJson(path.join(root, 'agent-system/skills.json')).skills,
    };
}

/** Score each route against the request text and any changed paths. */
/**
 * A read-only question is R0 even when it names money. The risk lives in mutation,
 * not in the noun: "where is the credits deduction implemented?" must not be routed
 * into the money lane behind a human gate. Changed paths override this — if files
 * actually moved, it is not a question regardless of phrasing.
 */
const QUESTION_FORM = /^\s*(where|what|how|why|which|who|when|does|do|is|are|can|should)\b|\?\s*$/i;
const MUTATION_INTENT = /\b(add|build|implement|update|delete|remove|change|fix|write|store|persist|migrate|publish|schedule|deploy)\b/i;

export function classify(request, changedPaths, { routes }) {
    const text = (request ?? '').toLowerCase();
    const scores = new Map(routes.map((r) => [r.id, 0]));

    const contentConsultation = routes.find((route) => route.id === 'content-growth-consultation');
    const asksForContentConsultation = contentConsultation?.triggers?.some((trigger) => text.includes(trigger.toLowerCase()))
        && !MUTATION_INTENT.test(request ?? '');
    if (QUESTION_FORM.test(request ?? '') && !(changedPaths ?? []).length && !asksForContentConsultation) {
        const answer = routes.find((r) => r.id === 'answer-question');
        if (answer) return { route: answer, confidence: 'matched', scores, tied: [answer] };
    }

    for (const route of routes) {
        if (route.id === 'content-growth-consultation' && MUTATION_INTENT.test(request ?? '')) continue;
        for (const trigger of route.triggers ?? []) {
            if (text.includes(trigger.toLowerCase())) scores.set(route.id, scores.get(route.id) + 2);
        }
    }
    // A content consultation that is explicitly named outranks incidental domain nouns
    // such as "voice" that also appear in implementation routes. This keeps a strategy
    // question advisory instead of escalating it into a prompt mutation.
    if (asksForContentConsultation) {
        scores.set('content-growth-consultation', (scores.get('content-growth-consultation') ?? 0) + 1);
    }
    /*
     * A small edit is R1 only when nothing riskier is named. "Fix the typo in the studio
     * button" names a UI noun too, and the tie-break below would always hand that to the
     * R2 route; "fix the typo in the credit cost" names money, so R3 must still win.
     */
    const riskOf = (id) => RISK_ORDER.indexOf(routes.find((r) => r.id === id)?.risk ?? 'R0');
    if ((scores.get('minor-change') ?? 0) > 0
        && ![...scores].some(([id, s]) => s > 0 && riskOf(id) >= RISK_ORDER.indexOf('R3'))) {
        for (const [id, s] of scores) if (s > 0 && riskOf(id) === RISK_ORDER.indexOf('R2')) scores.set(id, 0);
    }

    const pick = (table) => {
        const best = Math.max(0, ...table.values());
        if (best === 0) return null;
        // Tie-break toward the higher risk class, never the cheaper one.
        const tied = routes.filter((r) => table.get(r.id) === best);
        tied.sort((a, b) => RISK_ORDER.indexOf(b.risk) - RISK_ORDER.indexOf(a.risk));
        return { route: tied[0], tied };
    };
    const fromText = pick(scores);

    /*
     * Paths are the floor; the prompt can only raise it. Scores used to be summed, so
     * "credits" in the request plus a touched component scored ui-change 3 against
     * money-change 2, and the wording lowered the lane. Now each path names its route,
     * the riskiest path route is the floor, and a riskier text route lifts it.
     */
    const pathScores = new Map(routes.map((r) => [r.id, 0]));
    for (const p of changedPaths ?? []) {
        const rel = p.replace(/\\/g, '/').replace(/^\.\//, '');
        const hit = PATH_ROUTES.find(([pattern]) => pattern.test(rel)); // first (most specific) match
        if (hit) pathScores.set(hit[1], riskOf(hit[1]) + 1);
    }
    const fromPaths = pick(pathScores);

    if (!fromText && !fromPaths) return { route: null, confidence: 'none', scores };
    const chosen = !fromPaths || (fromText && riskOf(fromText.route.id) > riskOf(fromPaths.route.id))
        ? fromText
        : fromPaths;
    for (const [id, s] of pathScores) if (s > 0) scores.set(id, (scores.get(id) ?? 0) + s);
    return { route: chosen.route, confidence: chosen.tied.length > 1 ? 'ambiguous' : 'matched', scores, tied: chosen.tied };
}

/** Build the plan §4 task contract for a resolved route. */
export function buildContract(request, changedPaths, cp) {
    const { route, confidence, tied } = classify(request, changedPaths, cp);
    if (!route) {
        return {
            request, resolved: false, confidence,
            recommendation: 'No route matched. Do NOT guess: state the ambiguity and ask, or name the route explicitly. An unrouted change has no evidence contract, which means nothing would verify it.',
        };
    }
    const agentById = new Map(cp.agents.map((a) => [a.id, a]));
    const implementers = route.implementers.map((id) => agentById.get(id)).filter(Boolean);
    const advisors = (route.advisors ?? []).map((id) => agentById.get(id)).filter(Boolean);
    const inactive = implementers.filter((a) => a.status !== 'active').map((a) => a.id);

    const requiredSkills = [...new Set([
        ...(route.requiredSkills ?? []),
        ...implementers.flatMap((a) => a.requiredSkills ?? []),
    ])];
    const advisorSkills = advisors.map((advisor) => ({ advisor: advisor.id, skills: advisor.requiredSkills ?? [] }));
    const quarantined = cp.skills.filter((s) => requiredSkills.includes(s.id) && s.status === 'quarantined').map((s) => s.id);

    return {
        request,
        resolved: true,
        confidence,
        route: route.id,
        risk: route.risk,
        lane: route.lane ?? null,
        specialists: route.implementers,
        advisors: route.advisors ?? [],
        advisorSkills,
        verifiers: route.verifiers ?? [],
        requiredSkills,
        requiredEvidence: route.evidence,
        humanGates: route.humanGate ? ['founder approval before the change is applied'] : [],
        decisionRefs: route.decisionRefs ?? [],
        pillars: route.pillars ?? [],
        attemptLimit: 3,
        warnings: [
            ...(confidence === 'ambiguous' ? [`Ambiguous between ${tied.map((t) => t.id).join(', ')}; resolved to the highest risk. Confirm before acting.`] : []),
            ...(inactive.length ? [`Route names agent(s) that do not exist yet: ${inactive.join(', ')}. Use the active fallback or add the agent first.`] : []),
            ...(quarantined.length ? [`Required skill(s) are quarantined: ${quarantined.join(', ')}. Do not rely on them.`] : []),
        ],
    };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const argv = process.argv.slice(2);
    const json = argv.includes('--json');
    const pathsIdx = argv.indexOf('--paths');
    const changedPaths = pathsIdx >= 0 ? argv.slice(pathsIdx + 1).filter((a) => !a.startsWith('--')) : [];
    const request = argv.filter((a, i) => !a.startsWith('--') && (pathsIdx < 0 || i < pathsIdx)).join(' ');

    if (!request && !changedPaths.length) {
        console.error('usage: resolve-task.mjs "<request>" [--paths <file>...] [--json]');
        process.exit(2);
    }
    const contract = buildContract(request, changedPaths, loadRouting());
    if (json) {
        console.log(JSON.stringify(contract, null, 2));
        process.exit(0);
    }
    if (!contract.resolved) {
        console.log(`route      : UNRESOLVED (${contract.confidence})`);
        console.log(`\n${contract.recommendation}`);
        process.exit(0);
    }
    console.log(`route      : ${contract.route}  (${contract.confidence})`);
    console.log(`risk       : ${contract.risk}`);
    console.log(`specialists: ${contract.specialists.join(', ')}`);
    if (contract.advisors.length) console.log(`advisors    : ${contract.advisors.join(', ')}`);
    if (contract.advisorSkills.some((entry) => entry.skills.length)) {
        console.log(`advisor skills: ${contract.advisorSkills.map((entry) => `${entry.advisor} (${entry.skills.join(', ')})`).join('; ')} - load only when consulted`);
    }
    if (contract.verifiers.length) console.log(`verifiers  : ${contract.verifiers.join(', ')}`);
    if (contract.requiredSkills.length) console.log(`skills     : ${contract.requiredSkills.join(', ')}`);
    console.log(`evidence   : ${contract.requiredEvidence.join(', ')}`);
    if (contract.pillars.length) console.log(`controls   : ${contract.pillars.join(', ')} - list them with npm run check:controls -- --route ${contract.route}`);
    if (contract.humanGates.length) console.log(`human gate : ${contract.humanGates.join('; ')}`);
    for (const w of contract.warnings) console.log(`\n  ⚠ ${w}`);
}
