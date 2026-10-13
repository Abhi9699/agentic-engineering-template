#!/usr/bin/env node
/**
 * Derived dependency graph + semantic invariants (A1 — AA-GAP-23).
 *
 *   node scripts/agent-system/check-graph.mjs          enforce invariants
 *   node scripts/agent-system/check-graph.mjs --json   emit the derived graph
 *
 * WHY A GRAPH
 * The control plane already IS a graph: routes require agents and skills, agents
 * supply capabilities, providers implement capabilities, evidence verifies routes.
 * Left as unrelated JSON fields, a cross-file error is invisible — a route can name
 * an agent that cannot do the work, or require a skill that is quarantined, and
 * every individual file still validates.
 *
 * The graph is DERIVED, never authored. It is rebuilt from the manifests on every
 * run and thrown away. There is no graph database and no second source of truth.
 *
 * Each failure prints the shortest offending path plus the file and field that
 * created the edge, because "invariant 4 failed" is not actionable.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CONTRACT v2 (2026-09-03) — what was removed, and what would bring it back
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * v1 declared 13 node types and 9 edge types. SIX node types (`rule`, `decision`,
 * `phase`, `risk`, `source-policy`, `budget`) and THREE edge types (`verifies`,
 * `authorizes`, `observed-by`) had **zero instances** — nothing in `buildGraph` ever
 * created one. A contract describing things the builder never creates is the same defect
 * as a rule with no gate: it reads as coverage and enforces nothing. Worse, it made the
 * graph look richer than it is, which is how a proposal to add a `trajectory` node type
 * came to be framed as a small addition.
 *
 * Two consequences were load-bearing and worth stating plainly:
 *   - `authorizes` was declared `acyclic`, and had no nodes, so the cycle check for it
 *     could never run.
 *   - `routes-to` and `advises` are also declared acyclic and are `route:` -> `agent:`
 *     only, so a cycle is structurally impossible. Invariant 3 could not fire on ANY
 *     edge type, and no self-test ever planted a cycle. `acyclic` is therefore no longer
 *     declared anywhere; the check remains (below) for any future edge type that could
 *     actually cycle, and `agent-system-graph.test.ts` pins that it still bites.
 *
 * To bring one back: create the nodes in `buildGraph` from real manifest data FIRST, then
 * add the type to `graph-contract.json`. `decision`/`phase`/`rule` need a manifest that
 * does not exist yet (the §A decisions live in `docs/OPEN_QUESTIONS.md` as prose).
 * `observed-by` needs loops to name the routes they observe, which `loops.json` does not
 * carry. `verifies` was the inverse of the `requires` route -> evidence-type edge that
 * already exists; one direction is enough.
 *
 * `routes-to` SPLIT into `implements-route` and `verifies-route`. v1 linked implementers
 * and verifiers with the same edge name, so actor and critic were indistinguishable in
 * the derived graph and no separation rule could be expressed on it at all.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRoles, validateRoles } from './exec-review.mjs';

const DIR = 'agent-system';
const load = (root, name) => JSON.parse(readFileSync(path.join(root, DIR, name), 'utf8'));

/** Build the typed node/edge graph from the manifests. */
export function buildGraph(root = process.cwd()) {
    const capabilities = load(root, 'capabilities.json').capabilities;
    const agents = load(root, 'agents.json').agents;
    const skills = load(root, 'skills.json').skills;
    const routes = load(root, 'routing.json').routes;
    const evidence = load(root, 'evidence.json').evidenceTypes;
    const providers = load(root, 'providers.json').providers;
    const loops = load(root, 'loops.json').loops;
    const budgets = load(root, 'budgets.json');
    const contract = load(root, 'graph-contract.json');

    const nodes = new Map();
    const add = (type, id, data, source) => {
        const key = `${type}:${id}`;
        if (nodes.has(key)) throw new Error(`duplicate node ${key} (second definition in ${source})`);
        nodes.set(key, { type, id, key, data, source });
    };
    for (const c of capabilities) add('capability', c.id, c, 'capabilities.json');
    for (const a of agents) add('agent', a.id, a, 'agents.json');
    for (const s of skills) add('skill', s.id, s, 'skills.json');
    for (const r of routes) add('route', r.id, r, 'routing.json');
    for (const e of evidence) add('evidence-type', e.id, e, 'evidence.json');
    for (const p of providers) add('provider', p.id, p, 'providers.json');
    for (const l of loops) add('loop', l.id, l, 'loops.json');

    const edges = [];
    const link = (name, from, to, source, field) => edges.push({ name, from, to, source, field });

    for (const a of agents) {
        for (const c of a.capabilities) link('supplies', `agent:${a.id}`, `capability:${c}`, 'agents.json', `${a.id}.capabilities`);
        for (const s of a.requiredSkills ?? []) link('requires', `agent:${a.id}`, `skill:${s}`, 'agents.json', `${a.id}.requiredSkills`);
        for (const s of a.conditionalSkills ?? []) link('requires', `agent:${a.id}`, `skill:${s}`, 'agents.json', `${a.id}.conditionalSkills`);
    }
    for (const s of skills) {
        if (s.owner) link('owned-by', `skill:${s.id}`, `agent:${s.owner}`, 'skills.json', `${s.id}.owner`);
    }
    for (const r of routes) {
        // Distinct edge names: the actor and the critic must be separable in the graph,
        // or no separation rule can be stated on it. See the contract v2 note above.
        for (const a of r.implementers) link('implements-route', `route:${r.id}`, `agent:${a}`, 'routing.json', `${r.id}.implementers`);
        for (const a of r.verifiers ?? []) link('verifies-route', `route:${r.id}`, `agent:${a}`, 'routing.json', `${r.id}.verifiers`);
        for (const a of r.advisors ?? []) link('advises', `route:${r.id}`, `agent:${a}`, 'routing.json', `${r.id}.advisors`);
        for (const s of r.requiredSkills ?? []) link('requires', `route:${r.id}`, `skill:${s}`, 'routing.json', `${r.id}.requiredSkills`);
        for (const e of r.evidence) link('requires', `route:${r.id}`, `evidence-type:${e}`, 'routing.json', `${r.id}.evidence`);
    }
    for (const p of providers) {
        for (const [cap, m] of Object.entries(p.capabilityMappings)) {
            if (m.mapping !== 'unsupported') link('implements', `provider:${p.id}`, `capability:${cap}`, 'providers.json', `${p.id}.capabilityMappings.${cap}`);
        }
    }
    return { nodes, edges, contract, raw: { capabilities, agents, skills, routes, evidence, providers, loops, budgets } };
}

/** @returns {string[]} invariant violations, empty when the graph is sound */
export function checkGraph(graph) {
    const { nodes, edges, contract, raw } = graph;
    const problems = [];
    const edgeSpec = new Map(contract.edgeTypes.map((e) => [e.name, e]));
    const nodeTypes = new Set(contract.nodeTypes);

    // 1 + 2 — referential integrity and edge-type legality
    for (const e of edges) {
        const spec = edgeSpec.get(e.name);
        if (!spec) {
            problems.push(`unknown edge type "${e.name}" (${e.source} → ${e.field})`);
            continue;
        }
        for (const [end, key] of [['from', e.from], ['to', e.to]]) {
            const node = nodes.get(key);
            if (!node) {
                problems.push(`dangling ${e.name} edge: ${e.from} -> ${e.to}; ${key} does not exist (${e.source} → ${e.field})`);
                continue;
            }
            const allowed = end === 'from' ? spec.from : spec.to;
            if (!allowed.includes(node.type)) {
                problems.push(`illegal ${e.name} edge ${end} a "${node.type}": ${e.from} -> ${e.to} (${e.source} → ${e.field}); allowed ${end}: ${allowed.join(', ')}`);
            }
        }
    }
    for (const n of nodes.values()) {
        if (!nodeTypes.has(n.type)) problems.push(`node ${n.key} has a type absent from graph-contract.nodeTypes`);
    }

    // 3 — declared-acyclic edge types must actually be acyclic
    for (const spec of contract.edgeTypes.filter((e) => e.acyclic)) {
        const adj = new Map();
        for (const e of edges.filter((x) => x.name === spec.name)) {
            if (!adj.has(e.from)) adj.set(e.from, []);
            adj.get(e.from).push(e.to);
        }
        const state = new Map();
        const walk = (node, trail) => {
            if (state.get(node) === 'done') return;
            if (state.get(node) === 'open') {
                problems.push(`cycle in "${spec.name}": ${[...trail, node].join(' -> ')}`);
                return;
            }
            state.set(node, 'open');
            for (const next of adj.get(node) ?? []) walk(next, [...trail, node]);
            state.set(node, 'done');
        };
        for (const from of adj.keys()) walk(from, []);
    }

    // 4 — every route reaches an active implementer, evidence, and a verifier when it needs one
    for (const r of raw.routes) {
        for (const id of r.implementers) {
            const agent = raw.agents.find((a) => a.id === id);
            if (agent && agent.status !== 'active') {
                problems.push(`route "${r.id}" routes to agent "${id}", which is ${agent.status} — a route may not depend on an agent that does not exist yet`);
            }
            if (agent?.readOnly && r.effect !== 'read-only' && r.implementers.length === 1) {
                problems.push(`route "${r.id}" has only a read-only implementer ("${id}") but declares effect "${r.effect}"`);
            }
        }
        if (r.effect === 'read-only') {
            for (const id of r.implementers) {
                const agent = raw.agents.find((candidate) => candidate.id === id);
                if (agent && !agent.readOnly) problems.push(`read-only route "${r.id}" uses writable implementer "${id}"`);
            }
        }
        for (const id of r.advisors ?? []) {
            const advisor = raw.agents.find((agent) => agent.id === id);
            if (advisor && advisor.status !== 'active') problems.push(`route "${r.id}" names inactive advisor "${id}"`);
        }
        if (['R2', 'R3', 'R4'].includes(r.risk) && (r.verifiers ?? []).length === 0) {
            problems.push(`route "${r.id}" is ${r.risk} but names no independent verifier (plan §4.2 law 3)`);
        }
        if (['R3', 'R4'].includes(r.risk) && !r.humanGate) {
            problems.push(`route "${r.id}" is ${r.risk} but declares no human gate`);
        }
    }

    // 5 — an R3/R4 route may not reach an unsupported capability without a human gate
    for (const r of raw.routes.filter((x) => ['R3', 'R4'].includes(x.risk))) {
        for (const agentId of r.implementers) {
            const agent = raw.agents.find((a) => a.id === agentId);
            for (const capId of agent?.capabilities ?? []) {
                for (const providerId of agent.providers) {
                    const mapping = raw.providers.find((p) => p.id === providerId)?.capabilityMappings?.[capId];
                    if (mapping?.mapping === 'unsupported' && !r.humanGate) {
                        problems.push(`route "${r.id}" (${r.risk}) reaches capability "${capId}" which is unsupported on provider "${providerId}", with no human-gated fallback`);
                    }
                }
            }
        }
    }

    // 6 — no active route may reach a quarantined skill
    const quarantined = new Set(raw.skills.filter((s) => s.status === 'quarantined').map((s) => s.id));
    for (const r of raw.routes) {
        for (const s of r.requiredSkills ?? []) {
            if (quarantined.has(s)) problems.push(`route "${r.id}" requires quarantined skill "${s}" (routing.json → ${r.id}.requiredSkills)`);
        }
    }
    for (const a of raw.agents) {
        for (const s of [...(a.requiredSkills ?? []), ...(a.conditionalSkills ?? [])]) {
            if (quarantined.has(s)) problems.push(`agent "${a.id}" requires quarantined skill "${s}" (agents.json)`);
        }
    }

    // 7 — exclusive ownership may not overlap between agents
    const owners = new Map();
    for (const a of raw.agents) {
        for (const glob of a.exclusiveOwnership ?? []) {
            if (owners.has(glob)) problems.push(`exclusive ownership conflict on "${glob}": both "${owners.get(glob)}" and "${a.id}" claim it`);
            else owners.set(glob, a.id);
        }
    }

    // 8 — every required evidence type has a producer, and non-machine-checkable types name a reviewer
    for (const e of raw.evidence) {
        if (!e.machineCheckable && !e.reviewerRole) {
            problems.push(`evidence type "${e.id}" is not machine-checkable and names no reviewerRole — judgment cannot be unowned (AA-GAP-28)`);
        }
        if (e.machineCheckable && e.producer.startsWith('human:')) {
            problems.push(`evidence type "${e.id}" claims machineCheckable but its producer is a human step`);
        }
    }

    // 10 — a designed-not-added agent must state the trigger that would add it
    for (const a of raw.agents.filter((x) => x.status === 'designed-not-added')) {
        if (!a.trigger) problems.push(`agent "${a.id}" is designed-not-added but states no trigger (plan §5.2 Tier 2)`);
    }

    // 11 — every loop declares a bounded budget, a stop condition and an escalation
    for (const l of raw.loops) {
        if ((l.stopConditions ?? []).length === 0) problems.push(`loop "${l.id}" declares no stop condition (plan §3.5 law 11)`);
        for (const [dim, b] of Object.entries(l.budgets)) {
            const bounded = typeof b.max === 'number' && Number.isFinite(b.max) && b.max > 0;
            const excused = b.not_applicable === true && typeof b.reason === 'string' && b.reason.length > 7;
            if (!bounded && !excused) problems.push(`loop "${l.id}" budget "${dim}" is neither a positive finite max nor an explained not_applicable`);
        }
        if (l.state !== 'shadow' && !l.rollback) problems.push(`loop "${l.id}" is in "${l.state}" with no rollback target`);
    }

    // 12 — every capability is supplied by at least one active agent and implemented by a provider
    for (const c of raw.capabilities) {
        // A humanOnly capability intentionally has no standing agent supplier: the
        // authority is per-instance and human. Requiring a supplier would push us to
        // hand an agent a standing capability it must not have.
        const supplier = raw.agents.some((a) => a.status === 'active' && a.capabilities.includes(c.id));
        if (!supplier && !c.humanOnly) problems.push(`capability "${c.id}" is supplied by no active agent — it is unreachable`);
        if (supplier && c.humanOnly) problems.push(`capability "${c.id}" is humanOnly but agent(s) claim it as a standing capability`);
        const implemented = raw.providers.some((p) => p.capabilityMappings?.[c.id] && p.capabilityMappings[c.id].mapping !== 'unsupported');
        if (!implemented) problems.push(`capability "${c.id}" is unsupported on every provider`);
    }

    // 13 — every agent capability must be declared in capabilities.json (caught by edges, restated for a clear message)
    const capIds = new Set(raw.capabilities.map((c) => c.id));
    const providerIds = new Set(raw.providers.map((provider) => provider.id));
    for (const a of raw.agents) {
        for (const c of a.capabilities) {
            if (!capIds.has(c)) problems.push(`agent "${a.id}" claims undeclared capability "${c}"`);
            for (const providerId of a.providers) {
                if (!providerIds.has(providerId)) problems.push(`agent "${a.id}" claims undeclared provider "${providerId}"`);
                else if (!raw.providers.find((provider) => provider.id === providerId)?.capabilityMappings?.[c]) {
                    problems.push(`agent "${a.id}" capability "${c}" has no mapping on provider "${providerId}"`);
                }
            }
        }
    }

    /*
     * 14 — NO DECLARED TYPE MAY HAVE ZERO INSTANCES.
     *
     * This is the one that keeps contract v2 honest. Deleting six unused node types and
     * three unused edge types was a cleanup; without this it would silently refill, which
     * is exactly how it got to 6-of-13 in the first place. Declaring a type is now a
     * commitment to create one, in the same commit.
     *
     * The failure text says "instantiate it or remove it" rather than naming a fix,
     * because both are legitimate and the choice is the reviewer's.
     */
    const nodeTypesInUse = new Set([...nodes.values()].map((n) => n.type));
    const edgeTypesInUse = new Set(edges.map((e) => e.name));
    for (const type of contract.nodeTypes) {
        if (!nodeTypesInUse.has(type)) {
            problems.push(`graph-contract declares node type "${type}" but buildGraph creates none — a contract that describes what the builder never creates reads as coverage and enforces nothing. Instantiate it or remove it.`);
        }
    }
    for (const spec of contract.edgeTypes) {
        if (!edgeTypesInUse.has(spec.name)) {
            problems.push(`graph-contract declares edge type "${spec.name}" but buildGraph creates none — instantiate it or remove it.`);
        }
    }

    /*
     * 15 — RISK BINDS TO COGNITIVE TIER.
     *
     * An R3/R4 route is a schema migration, the money path, a prompt change or a release.
     * `budgets.json.modelTiers` is the single authored source for how much reasoning an
     * agent gets (see generate-adapters.mjs), and until 2026-09-03 nothing read it at all,
     * so "economy" was a note-to-self rather than a control. This is what makes the cheap
     * lane safe to widen: an agent can only be moved down a tier where the routes that
     * reach it allow it.
     *
     * Verifiers are included deliberately. A critic on a cheap model is a rubber stamp,
     * and a rubber stamp is worse than no reviewer because it produces a signature.
     */
    const tiers = raw.budgets?.modelTiers ?? {};
    for (const r of raw.routes.filter((x) => ['R3', 'R4'].includes(x.risk))) {
        for (const [role, ids] of [['implementer', r.implementers], ['verifier', r.verifiers ?? []]]) {
            for (const id of ids) {
                if (tiers[id] === 'economy') {
                    problems.push(`route "${r.id}" is ${r.risk} but its ${role} "${id}" is on the economy cognitive tier (budgets.json → modelTiers) — high-risk work may not be routed to the cheap lane`);
                }
            }
        }
    }

    /*
     * 16 — THE ACTOR MAY NOT BE ITS OWN CRITIC.
     *
     * Stated honestly: this finds NOTHING today. All nine routes already have disjoint
     * implementer and verifier sets. It is a regression guard against a future edit that
     * quietly names the implementer as its own verifier — which would read as compliant
     * (invariant 4 only counts verifiers) while removing the independence entirely.
     *
     * It also does NOT prove the separation happened at runtime. That is a property of who
     * produced the evidence receipt, not of who the manifest names, and it is enforced
     * separately in `check-evidence.mjs` via the receipt's `actor`.
     */
    for (const r of raw.routes) {
        const overlap = (r.implementers ?? []).filter((id) => (r.verifiers ?? []).includes(id));
        for (const id of overlap) {
            problems.push(`route "${r.id}" names "${id}" as both implementer and verifier — an agent cannot be an independent check on its own work`);
        }
    }

    return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    let graph;
    try {
        graph = buildGraph();
    } catch (e) {
        console.error(`check-graph FAILED to build: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    }
    if (process.argv.includes('--json')) {
        console.log(JSON.stringify({
            nodes: [...graph.nodes.values()].map(({ type, id, source }) => ({ type, id, source })),
            edges: graph.edges,
        }, null, 2));
        process.exit(0);
    }
    const problems = checkGraph(graph);
    // Role lenses (doc 34 W10): a stage the schema allows but the role cannot serve.
    problems.push(...validateRoles(loadRoles()));
    if (problems.length) {
        console.error(`check-graph — ${problems.length} semantic invariant violation(s):\n`);
        for (const p of problems) console.error(`  • ${p}`);
        process.exit(1);
    }
    console.log(`check-graph OK — ${graph.nodes.size} nodes, ${graph.edges.length} edges, 0 violations.`);
}
