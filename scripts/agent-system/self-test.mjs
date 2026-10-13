#!/usr/bin/env node
/**
 * Control-plane self-test (A7) — prove every blocking gate still bites.
 *
 *   node scripts/agent-system/self-test.mjs
 *
 * A gate that has never rejected anything is indistinguishable from a gate that cannot.
 * This repository has already been bitten by exactly that: `skills-lock.json` carried
 * integrity hashes nothing verified, and an `agent:doctor` test passed while its parser
 * silently returned nothing at all.
 *
 * So each check below plants a specific, realistic failure IN MEMORY, asserts the
 * relevant validator rejects it for the right reason, and discards it. Nothing on disk
 * is modified — a self-test that mutates the repository is a self-test nobody runs.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validate } from './validate-manifests.mjs';
import { checkGraph, buildGraph } from './check-graph.mjs';
import { composeBody, loadControlPlane, renderAntigravity, renderClaude, validateForGeneration } from './generate-adapters.mjs';
import { buildMirrors, renderMirror } from './generate-skill-mirrors.mjs';
import { measure } from './check-context-budget.mjs';
import { requiredEvidenceFor } from './check-evidence.mjs';
import { classify } from './resolve-task.mjs';
import { isGeneratedSubagent } from './agent-kinds.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));
const schema = JSON.parse(readFileSync('agent-system/manifest.schema.json', 'utf8'));

/** @type {Array<{ name: string, expectation: string, caught: boolean, detail: string }>} */
const results = [];
function plant(name, expectation, fn) {
    let outcome;
    try {
        outcome = fn();
    } catch (e) {
        outcome = { caught: false, detail: `self-test threw: ${e instanceof Error ? e.message : String(e)}` };
    }
    results.push({ name, expectation, ...outcome });
}

const graph = buildGraph();

// --- schema gates -----------------------------------------------------------------
plant('schema rejects an unbounded loop budget', 'no implicit infinity', () => {
    const doc = {
        kind: 'loops', version: 1,
        loops: [{ id: 'runaway', controller: 'parent-coordinator', state: 'shadow',
            budgets: { attempts: {}, wallTimeMinutes: { max: 5 }, providerCostUsd: { max: 1 } },
            stopConditions: ['x'], escalation: 'founder', rollback: 'last-known-good' }],
    };
    const errors = validate(schema, doc, schema);
    return { caught: errors.length > 0, detail: errors[0] ?? 'ACCEPTED — gate is blind' };
});

plant('schema rejects an unknown property', 'no silent typos', () => {
    const doc = { kind: 'capabilities', version: 1, capabilities: [{ id: 'x', description: 'long enough description', risk: 'R1', tpyo: 1 }] };
    const errors = validate(schema, doc, schema);
    return { caught: errors.some((e) => /unexpected property/.test(e)), detail: errors[0] ?? 'ACCEPTED — gate is blind' };
});

// --- graph invariants -------------------------------------------------------------
plant('graph rejects a route requiring a quarantined skill', 'untrusted skills stay unroutable', () => {
    const g = { ...graph, raw: clone(graph.raw) };
    g.raw.routes[1].requiredSkills = ['ui-styling'];
    const problems = checkGraph(g);
    return { caught: problems.some((p) => /quarantined skill/.test(p)), detail: problems.find((p) => /quarantined/.test(p)) ?? 'ACCEPTED — gate is blind' };
});

plant('graph rejects an R3 route with no human gate', 'high risk needs a human', () => {
    const g = { ...graph, raw: clone(graph.raw) };
    g.raw.routes.find((r) => r.risk === 'R3').humanGate = false;
    const problems = checkGraph(g);
    return { caught: problems.some((p) => /no human gate/.test(p)), detail: problems.find((p) => /human gate/.test(p)) ?? 'ACCEPTED — gate is blind' };
});

plant('graph rejects a declared node type nothing instantiates', 'no schema that describes nothing', () => {
    // Contract v1 carried SIX node types and THREE edge types with zero instances. That
    // is the same defect as a rule with no gate: it reads as coverage and enforces
    // nothing, and it made the graph look rich enough that adding another type looked
    // like a small change. Deleting them was a cleanup; this is what stops it refilling.
    const g = { ...graph, contract: clone(graph.contract) };
    g.contract.nodeTypes.push('trajectory');
    const problems = checkGraph(g);
    return { caught: problems.some((p) => /declares node type "trajectory" but buildGraph creates none/.test(p)), detail: problems.find((p) => /trajectory/.test(p)) ?? 'ACCEPTED — gate is blind' };
});

plant('graph rejects a declared edge type nothing instantiates', 'same rule, both halves of the contract', () => {
    const g = { ...graph, contract: clone(graph.contract) };
    g.contract.edgeTypes.push({ name: 'grounds', from: ['route'], to: ['agent'] });
    const problems = checkGraph(g);
    return { caught: problems.some((p) => /declares edge type "grounds" but buildGraph creates none/.test(p)), detail: problems.find((p) => /grounds/.test(p)) ?? 'ACCEPTED — gate is blind' };
});

plant('graph rejects a real cycle', 'the acyclicity check must be able to fire', () => {
    /*
     * THE POINT OF THIS CASE. Contract v1 declared three edge types `acyclic`, and not one
     * could ever cycle: `routes-to` and `advises` run route: -> agent: only, and
     * `authorizes` had no nodes at all. Invariant 3 was unfireable and no self-test had
     * ever planted a cycle — a gate nobody has watched fail is a rumour.
     *
     * v2 declares `acyclic` on nothing, precisely because nothing in this graph can cycle.
     * The machinery is kept for a future edge type that could, so this plants a synthetic
     * agent -> agent edge to prove the code still detects one.
     */
    const g = {
        nodes: new Map([['agent:a', { type: 'agent', id: 'a', key: 'agent:a' }], ['agent:b', { type: 'agent', id: 'b', key: 'agent:b' }]]),
        edges: [
            { name: 'delegates', from: 'agent:a', to: 'agent:b', source: 'synthetic', field: 'x' },
            { name: 'delegates', from: 'agent:b', to: 'agent:a', source: 'synthetic', field: 'x' },
        ],
        contract: { nodeTypes: ['agent'], edgeTypes: [{ name: 'delegates', from: ['agent'], to: ['agent'], acyclic: true }] },
        raw: { routes: [], agents: [], skills: [], evidence: [], providers: [], loops: [], capabilities: [], budgets: { modelTiers: {} } },
    };
    const problems = checkGraph(g);
    return { caught: problems.some((p) => /^cycle in "delegates"/.test(p)), detail: problems.find((p) => /cycle/.test(p)) ?? 'ACCEPTED — gate is blind' };
});

plant('graph rejects a high-risk route on the economy tier', 'no cheap lane for money or schema', () => {
    const g = { ...graph, raw: clone(graph.raw) };
    g.raw.budgets.modelTiers['reviewer'] = 'economy';
    const problems = checkGraph(g);
    return { caught: problems.some((p) => /economy cognitive tier/.test(p)), detail: problems.find((p) => /economy cognitive tier/.test(p)) ?? 'ACCEPTED — gate is blind' };
});

plant('graph rejects an agent verifying its own work', 'the actor is never its own critic', () => {
    // Finds nothing today - all nine routes already have disjoint sets. It guards the
    // edit that names the implementer as its own verifier, which would read as compliant
    // because invariant 4 only COUNTS verifiers.
    const g = { ...graph, raw: clone(graph.raw) };
    const route = g.raw.routes.find((r) => (r.verifiers ?? []).length);
    route.verifiers.push(route.implementers[0]);
    const problems = checkGraph(g);
    return { caught: problems.some((p) => /both implementer and verifier/.test(p)), detail: problems.find((p) => /both implementer/.test(p)) ?? 'ACCEPTED — gate is blind' };
});

plant('graph rejects an agent taking a human-only capability', 'no standing deploy rights', () => {
    const g = { ...graph, raw: clone(graph.raw) };
    g.raw.agents.find((a) => a.status === 'active').capabilities.push('deploy');
    const problems = checkGraph(g);
    return { caught: problems.some((p) => /humanOnly/.test(p)), detail: problems.find((p) => /humanOnly/.test(p)) ?? 'ACCEPTED — gate is blind' };
});

// --- adapter generation -----------------------------------------------------------
const instructions = loadControlPlane().instructions;
/** Real instruction files, so a planted failure is the ONLY problem reported. */
const cpBase = () => ({ agents: clone(graph.raw.agents), skills: graph.raw.skills, instructions, tiers: clone(graph.raw.budgets.modelTiers) });
// Generator fixtures must target an agent the generator emits: main-session and built-in
// agents (doc 34 W5) carry no adapter, providerConfig, tier or instructions.
const firstGenerated = (cp, extra = () => true) => cp.agents.find((a) => isGeneratedSubagent(a) && extra(a));
// The UI specialist whose prose named Claude-only skills was retired in doc 34 W5, so these
// fixtures plant a synthetic clone of a live generated agent that does the same.
const SYNTHETIC_UI = 'synthetic-ui';
const withSyntheticUi = (cp) => {
    const base = firstGenerated(cp, (a) => a.providers.includes('codex') && a.providers.includes('antigravity'));
    cp.agents.push({ ...clone(base), id: SYNTHETIC_UI, requiredSkills: [], conditionalSkills: ['dataviz', 'frontend-design'] });
    const entry = cp.instructions[base.id];
    cp.instructions = { ...cp.instructions, [SYNTHETIC_UI]: { ...entry, shared: `${entry.shared}\n\nLoad \`dataviz\` before a chart and \`frontend-design\` for a new screen.` } };
    cp.tiers[SYNTHETIC_UI] = cp.tiers[base.id];
    return cp;
};
const only = (problems, re) => problems.find((p) => re.test(p)) ?? 'ACCEPTED — gate is blind';

plant('generator refuses an unknown tool identifier', 'an unmapped tool can hang a subagent', () => {
    const cp = cpBase();
    firstGenerated(cp, (a) => a.providers.includes('claude')).providerConfig.claude.tools.push('Telekinesis');
    const problems = validateForGeneration(cp);
    return { caught: problems.some((p) => /unknown tool identifier/.test(p)), detail: only(problems, /unknown tool identifier/) };
});

plant('generator refuses to preload a quarantined skill', 'never inject untrusted instructions', () => {
    const cp = cpBase();
    firstGenerated(cp).requiredSkills = ['ui-styling'];
    const problems = validateForGeneration(cp);
    return { caught: problems.some((p) => /quarantined skill/.test(p)), detail: only(problems, /quarantined skill/) };
});

plant('generator refuses an agent with no normative contract', 'an adapter with no rules is worse than none', () => {
    const cp = cpBase();
    cp.instructions = { ...instructions };
    const victim = firstGenerated(cp);
    cp.instructions[victim.id] = { shared: null, byProvider: {} };
    const problems = validateForGeneration(cp);
    return { caught: problems.some((p) => /no normative contract/.test(p)), detail: only(problems, /no normative contract/) };
});

plant('generator refuses a second source of truth for prose', 'prose lives in exactly one place', () => {
    const cp = cpBase();
    firstGenerated(cp).instructions = 'a competing body in the manifest';
    const problems = validateForGeneration(cp);
    return { caught: problems.some((p) => /one home/.test(p)), detail: only(problems, /one home/) };
});

plant('generator refuses an instruction file for an unclaimed provider', 'silent dead files hide intent', () => {
    const cp = cpBase();
    cp.instructions = { ...instructions };
    const victim = firstGenerated(cp, (a) => !a.providers.includes('cursor'));
    cp.instructions[victim.id] = { ...instructions[victim.id], byProvider: { cursor: 'orphaned' } };
    const problems = validateForGeneration(cp);
    return { caught: problems.some((p) => /does not claim provider/.test(p)), detail: only(problems, /does not claim provider/) };
});

plant('every read-only agent with a shell carries the mutation guard', 'a shell is a write tool', () => {
    // "read-only: no Write/Edit" was documentation only: sed -i, `echo > file` and
    // git checkout all mutate through Bash without touching Write or Edit.
    const unguarded = graph.raw.agents
        .filter((a) => a.status === 'active' && a.readOnly && a.providerConfig?.claude?.tools?.includes('Bash'))
        .filter((a) => !renderClaude(a, instructions).includes('guard-readonly-agent.mjs'))
        .map((a) => a.id);
    return {
        caught: unguarded.length === 0,
        detail: unguarded.length ? `UNGUARDED SHELL: ${unguarded.join(', ')}` : 'every read-only generated agent with a shell emits the PreToolUse guard',
    };
});

plant('generator refuses an Antigravity adapter with no tools of its own', 'Antigravity defaults `tools` to [], not to everything', () => {
    // The 2026-09-02 regression this closes: the renderer fell back to
    // providerConfig.claude.tools, so seven adapters shipped Claude's names, while the
    // validator read providerConfig.antigravity.tools - undefined for those seven - and
    // never ran. Both halves of that failure are planted here.
    const cp = cpBase();
    delete firstGenerated(cp, (a) => a.providers.includes('antigravity')).providerConfig.antigravity.tools;
    const problems = validateForGeneration(cp);
    return { caught: problems.some((p) => /missing or empty/.test(p)), detail: only(problems, /missing or empty/) };
});

plant('generator refuses a Claude tool name in an Antigravity adapter', 'an unmapped name can hang the subagent', () => {
    const cp = cpBase();
    firstGenerated(cp, (a) => a.providers.includes('antigravity')).providerConfig.antigravity.tools.push('Bash');
    const problems = validateForGeneration(cp);
    return { caught: problems.some((p) => /unknown Antigravity tool identifier/.test(p)), detail: only(problems, /unknown Antigravity tool/) };
});

plant('generator refuses a model authored in providerConfig', 'the cost of an agent has ONE home', () => {
    // Until 2026-09-03 the cost of an agent was written in three places nothing
    // reconciled, and the only one named "budgets" was the one no code read. The model
    // is now DERIVED from budgets.json modelTiers, so authoring one here is a second
    // source of truth for the same decision.
    const cp = cpBase();
    firstGenerated(cp, (a) => a.providers.includes('antigravity')).providerConfig.antigravity.model = 'pro';
    const problems = validateForGeneration(cp);
    return { caught: problems.some((p) => /second source of truth for the cost/.test(p)), detail: only(problems, /second source of truth for the cost/) };
});

plant('generator refuses an unknown cognitive tier', 'economy | standard are the only tiers', () => {
    const cp = cpBase();
    cp.tiers[firstGenerated(cp).id] = 'turbo';
    const problems = validateForGeneration(cp);
    return { caught: problems.some((p) => /unknown cognitive tier/.test(p)), detail: only(problems, /unknown cognitive tier/) };
});

plant('generator refuses an active agent with no declared tier', 'no cost decision by omission', () => {
    // "Whatever the provider gives us" is a cost decision made by not making one.
    const cp = cpBase();
    delete cp.tiers[firstGenerated(cp).id];
    const problems = validateForGeneration(cp);
    return { caught: problems.some((p) => /no entry in budgets.json modelTiers/.test(p)), detail: only(problems, /modelTiers/) };
});

plant('generator refuses the Antigravity write tool on a read-only agent', 'the tools allowlist is the only write denial Antigravity has', () => {
    // Antigravity has no PreToolUse hook, so the Claude-side mutation guard has no twin.
    // The allowlist is the whole enforcement surface; granting the write tool there
    // makes the read-only role prose, exactly as it was before this change.
    const cp = cpBase();
    firstGenerated(cp, (a) => a.readOnly && a.providers.includes('antigravity'))
        .providerConfig.antigravity.tools.push('replace_file_content');
    const problems = validateForGeneration(cp);
    return { caught: problems.some((p) => /only write denial/.test(p)), detail: only(problems, /write denial/) };
});

plant('no shipped Antigravity adapter carries a Claude tool name', 'the borrowed-names defect cannot come back', () => {
    const claudeNames = /(Read|Edit|Write|Grep|Glob|Bash|Skill|WebFetch|WebSearch|NotebookEdit)/;
    const offenders = graph.raw.agents
        .filter((a) => isGeneratedSubagent(a) && a.providers.includes('antigravity'))
        .filter((a) => claudeNames.test(renderAntigravity(a, instructions).match(/^tools: \[.*\]$/m)?.[0] ?? ''))
        .map((a) => a.id);
    return {
        caught: offenders.length === 0,
        detail: offenders.length ? `BORROWED CLAUDE NAMES: ${offenders.join(', ')}` : 'every Antigravity adapter uses Antigravity identifiers',
    };
});

plant('generator refuses a prose-named skill that is declared nowhere', 'availability must be derivable for every skill the body names', () => {
    // The body is emitted verbatim to every provider, so naming a skill names it on tools
    // that may not have it. Declaring it is what lets the footer state the delta.
    const cp = withSyntheticUi(cpBase());
    const victim = cp.agents.find((a) => a.id === SYNTHETIC_UI);
    victim.conditionalSkills = victim.conditionalSkills.filter((s) => s !== 'dataviz');
    const problems = validateForGeneration(cp);
    return { caught: problems.some((p) => /names registered skill/.test(p)), detail: only(problems, /names registered skill/) };
});

plant('generator refuses to preload a skill the provider does not ship', 'a preload cannot be conditional', () => {
    const cp = withSyntheticUi(cpBase());
    // frontend-design is provider-native to Claude; preloading it anywhere else promises
    // a load that can never happen.
    cp.agents.find((a) => a.id === SYNTHETIC_UI).requiredSkills.push('frontend-design');
    const problems = validateForGeneration(cp);
    return { caught: problems.some((p) => /where it does not exist/.test(p)), detail: only(problems, /does not exist/) };
});

plant('every provider is told which named skills it does NOT have', 'never send an agent hunting for a skill that cannot resolve', () => {
    // The synthetic clone names frontend-design and dataviz; both are Claude-only.
    const cp = withSyntheticUi(cpBase());
    const agent = cp.agents.find((a) => a.id === SYNTHETIC_UI);
    const blind = agent.providers.filter((provider) => provider !== 'claude'
        && !composeBody(agent, provider, cp.instructions, graph.raw.skills).includes('Not available on this provider'));
    return {
        caught: blind.length === 0,
        detail: blind.length ? `SILENT ON UNAVAILABLE SKILLS: ${blind.join(', ')}` : 'codex and antigravity both carry the availability delta',
    };
});

plant('a skill mirror may not invent content its canonical lacks', 'a partial copy that reads complete is worse than a pointer', () => {
    // A mirror must not drift from its canonical skill.
    // Mirrors are generated, so any hand-edit is drift.
    const mirrors = buildMirrors();
    const target = mirrors[0]; if (!target) return { caught: true, detail: 'no mirrors to check' };
    const tampered = target.content.replace(`# ${target.id} (discovery mirror)`, `# ${target.id}\n\n## Driver Commands\n\n- \`launch\`\n- \`nav\``);
    return {
        caught: tampered !== target.content && !target.content.includes('Driver Commands'),
        detail: target.content.includes('Driver Commands') ? 'ACCEPTED — the generated mirror carries a command reference' : 'the generated mirror carries no reference content, so a hand-added one fails --check',
    };
});

plant('a mirror pointing at a nonexistent canonical is refused', 'a pointer to nothing is worse than no pointer', () => {
    const problems = buildMirrors().filter((m) => m.problem);
    const fake = renderMirror({ id: 'x', mirrorOf: '.claude/skills/x' }, { description: 'd' });
    return {
        caught: problems.length === 0 && fake.includes('.claude/skills/x/SKILL.md'),
        detail: problems.length ? `real mirror problem: ${problems[0].problem}` : 'every mirrorOf resolves, and the rendered pointer always names the canonical file',
    };
});

plant('context budget measures every provider, not just Claude', 'a budget met only on the cheapest tool is not met', () => {
    // Until 2026-09-02 this read .claude/agents + .claude/skills for everyone, so it could
    // not see that content-growth-intelligence had no Claude-side copy at all.
    const rows = measure();
    const singleProvider = rows.filter((r) => Object.keys(r.perProvider ?? {}).length < 2).map((r) => r.id);
    const worstIsMax = rows.every((r) => r.total === Math.max(...Object.values(r.perProvider).map((v) => v.total)));
    return {
        caught: singleProvider.length === 0 && worstIsMax,
        detail: singleProvider.length ? `MEASURED ON ONE PROVIDER ONLY: ${singleProvider.join(', ')}`
            : worstIsMax ? 'every agent is measured on each provider it claims, and the ceiling binds against the worst'
                : 'the enforced total is not the worst provider',
    };
});

plant('every provider receives the identical normative contract', 'a rule must not exist on one tool and not another', () => {
    // The defect this restructure removed: Antigravity's billing specialist shipped
    // boilerplate with no 402/idempotency/reserve-refund rules while Claude's had them.
    const missing = [];
    for (const agent of graph.raw.agents.filter(isGeneratedSubagent)) {
        const shared = instructions[agent.id]?.shared;
        for (const provider of agent.providers) {
            if (!composeBody(agent, provider, instructions).includes(shared)) missing.push(`${agent.id}/${provider}`);
        }
    }
    return {
        caught: missing.length === 0,
        detail: missing.length ? `PROVIDER SHORTCHANGED: ${missing.join(', ')}` : 'every generated agent carries _shared.md verbatim to every claimed provider',
    };
});

// --- evidence contracts -----------------------------------------------------------
plant('evidence gate demands an eval for a prompt-registry change', 'AI changes owe an eval', () => {
    const ev = JSON.parse(readFileSync('agent-system/evidence.json', 'utf8')).evidenceTypes;
    const required = requiredEvidenceFor(['lib/config/prompt-registry.ts'], ev).map((r) => r.evidence.id);
    return { caught: required.includes('prompt-eval-report'), detail: `required: ${required.join(', ') || 'NOTHING — gate is blind'}` };
});

plant('evidence gate demands runtime proof for a UI change', 'UI changes owe a rendered observation', () => {
    const ev = JSON.parse(readFileSync('agent-system/evidence.json', 'utf8')).evidenceTypes;
    const required = requiredEvidenceFor(['app/studio/page.tsx'], ev).map((r) => r.evidence.id);
    return { caught: required.includes('runtime-screenshot'), detail: `required: ${required.join(', ') || 'NOTHING — gate is blind'}` };
});

// --- routing ----------------------------------------------------------------------
plant('router sends a paywall bug to the money route', 'money work reaches the money lane', () => {
    const { route } = classify('the paywall returns 403 instead of 402', [], { routes: graph.raw.routes });
    return { caught: route?.id === 'money-change', detail: `routed to: ${route?.id ?? 'NOTHING'}` };
});

plant('router breaks ties toward higher risk', 'never resolve down into a cheaper lane', () => {
    const { route } = classify('update the credits constant on the settings screen', ['lib/config/constants.ts'], { routes: graph.raw.routes });
    return { caught: route?.risk === 'R3', detail: `routed to: ${route?.id} (${route?.risk})` };
});

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const failed = results.filter((r) => !r.caught);
    console.log('control-plane self-test — planted failures that MUST be caught\n');
    for (const r of results) {
        console.log(`  ${r.caught ? 'BITES ' : 'BLIND '} ${r.name}`);
        console.log(`          expectation: ${r.expectation}`);
        console.log(`          ${r.caught ? 'rejected: ' : 'PROBLEM:  '}${r.detail}`);
    }
    console.log(`\n${results.length - failed.length}/${results.length} gates bite.`);
    if (failed.length) {
        console.error(`\n${failed.length} gate(s) did NOT reject their planted failure. A gate that cannot fail is not a gate.`);
        process.exit(1);
    }
    process.exit(0);
}

export { results };
