#!/usr/bin/env node
/**
 * Per-spawn context budget for the specialists.
 *
 *   node scripts/agent-system/check-context-budget.mjs           # report + enforce
 *   node scripts/agent-system/check-context-budget.mjs --report  # print, never fail
 *
 * WHY (2026-08-27): a subagent starts cold, so everything it needs is injected on EVERY
 * spawn - the generated adapter body plus the full text of each preloaded skill. That
 * cost is invisible: nobody notices a contract growing 400 characters at a time, and the
 * 2026-08-27 restructure deliberately grew the Codex and Antigravity bodies 3-4x by giving
 * them the contract they had been missing. Paying that was correct. Paying it *without
 * measuring it* is how the next 3x arrives unnoticed.
 *
 * The ceiling is NOT a quality trade. It is a forcing function for the right shape:
 * normative rules stay in the body; bulk reference material belongs in a script or a doc
 * the agent opens on demand. Bulk drivers sit outside the adapter and are injected only on demand.
 *
 * Raising a ceiling in agent-system/budgets.json is a deliberate, reviewable diff. That is
 * the industry-standard performance-budget pattern, applied to context instead of bytes.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isGeneratedSubagent } from './agent-kinds.mjs';

/**
 * Each provider reads its adapter and its skills from its OWN directories. Measuring
 * Claude's for everyone (as this did until 2026-09-02) understates every other provider
 * and hides the one number that matters: the WORST spawn any tool will pay.
 */
const PROVIDER_PATHS = {
    claude: { adapter: (id) => `.claude/agents/${id}.md`, skills: '.claude/skills' },
    codex: { adapter: (id) => `.codex/agents/${id}.toml`, skills: '.agents/skills' },
    antigravity: { adapter: (id) => `.agents/agents/${id}.md`, skills: '.agents/skills' },
    copilot: { adapter: (id) => `.github/agents/${id}.agent.md`, skills: '.agents/skills' },
    cursor: { adapter: (id) => `.cursor/agents/${id}.md`, skills: '.agents/skills' },
};
/**
 * Project instructions a Claude subagent inherits on every spawn: CLAUDE.md and the AGENTS.md
 * it imports (https://code.claude.com/docs/en/sub-agents, "What loads at startup", checked
 * 2026-10-03). It was the largest per-spawn cost and this check never counted it (doc 34 E5).
 * `omitClaudeMd: true` drops it. Other providers do not document their subagent loading
 * clearly enough to count, so their figures stay adapter + skills and the report says so.
 */
const CLAUDE_PROJECT_FILES = ['CLAUDE.md', 'AGENTS.md'];

/** Chars a Claude spawn of this agent inherits from project instructions; 0 with omitClaudeMd. */
export function projectInstructionChars(root, agent) {
    if (agent.providerConfig?.claude?.omitClaudeMd === true) return 0;
    return CLAUDE_PROJECT_FILES.reduce((sum, file) => {
        const p = path.join(root, file);
        return sum + (existsSync(p) ? readFileSync(p, 'utf8').length : 0);
    }, 0);
}

/** Default search order, used only when a caller does not name a provider's dir. */
const SKILL_DIRS = ['.claude/skills', '.agents/skills'];
/** Rough, deliberately stable: ~4 chars/token. Exactness is not the point; drift is. */
const CHARS_PER_TOKEN = 4;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** The text a preloaded skill actually injects: its SKILL.md, not the whole directory. */
function skillManifestSize(root, skillId, dirs = SKILL_DIRS) {
    for (const dir of dirs) {
        const file = path.join(root, dir, skillId, 'SKILL.md');
        if (existsSync(file)) return { bytes: readFileSync(file, 'utf8').length, found: true };
    }
    return { bytes: 0, found: false };
}

export function measure(root = process.cwd()) {
    const agents = readJson(path.join(root, 'agent-system/agents.json')).agents;
    // An external skill is materialized locally from skills-lock.json (`npx skills
    // install`) and its files are gitignored, so on a fresh clone — CI included — it is
    // legitimately absent. The repo already treats that as an INFO-level capability gap
    // (AA-GAP-05), not a failure, and agent-system-phases.test.ts pins that policy. A
    // check that is stricter than the contract it enforces just fails the build for a
    // condition everyone has already agreed to accept.
    const external = new Set(readJson(path.join(root, 'agent-system/skills.json')).skills
        .filter((skill) => skill.provenance === 'lock-listed-external')
        .map((skill) => skill.id));
    // provider-native skills are shipped BY the provider, so there is no file here to
    // measure. Their cost is real but unknowable from this repository; counting them as 0
    // is a floor, and the report says so rather than implying the number is complete.
    const providerNative = new Set(readJson(path.join(root, 'agent-system/skills.json')).skills
        .filter((skill) => skill.provenance === 'provider-native')
        .map((skill) => skill.id));
    const rows = [];
    for (const agent of agents) {
        if (!isGeneratedSubagent(agent)) continue;
        const perProvider = {};
        for (const provider of agent.providers) {
            const paths = PROVIDER_PATHS[provider];
            if (!paths) continue;
            const adapter = path.join(root, paths.adapter(agent.id));
            const bodyChars = existsSync(adapter) ? readFileSync(adapter, 'utf8').length : 0;
            let skillChars = 0;
            const missing = [];
            const notMaterialized = [];
            for (const skillId of agent.requiredSkills ?? []) {
                if (providerNative.has(skillId)) continue;
                const { bytes, found } = skillManifestSize(root, skillId, [paths.skills]);
                skillChars += bytes;
                if (found) continue;
                // A committed skill with no SKILL.md is a broken preload we own and can fix.
                // An un-materialized external one is expected on any clean checkout.
                (external.has(skillId) ? notMaterialized : missing).push(skillId);
            }
            const projectChars = provider === 'claude' ? projectInstructionChars(root, agent) : 0;
            perProvider[provider] = { bodyChars, skillChars, projectChars, total: bodyChars + skillChars + projectChars, missing, notMaterialized };
        }
        // The ceiling is enforced against the WORST provider, because that is the real
        // per-spawn cost somebody pays. A budget met only on the cheapest tool is not met.
        const worst = Object.entries(perProvider).sort((a, b) => b[1].total - a[1].total)[0];
        rows.push({
            id: agent.id,
            provider: worst?.[0] ?? 'claude',
            perProvider,
            ...(worst?.[1] ?? { bodyChars: 0, skillChars: 0, projectChars: 0, total: 0, missing: [], notMaterialized: [] }),
        });
    }
    return rows.sort((a, b) => b.total - a.total);
}

export function checkBudget(root = process.cwd()) {
    const budgets = readJson(path.join(root, 'agent-system/budgets.json')).contextBudget;
    const rows = measure(root);
    const problems = [];
    if (!budgets?.perAgentChars) {
        problems.push('agent-system/budgets.json has no contextBudget.perAgentChars - the ceiling is unset, so nothing is enforced');
        return { rows, problems };
    }
    for (const row of rows) {
        const ceiling = budgets.perAgentChars[row.id];
        if (ceiling === undefined) {
            problems.push(`${row.id}: no context budget declared - add one to agent-system/budgets.json (currently ${row.total} chars)`);
        } else if (row.total > ceiling) {
            problems.push(`${row.id}: ${row.total} chars on ${row.provider} exceeds its ${ceiling}-char budget by ${row.total - ceiling}. Move reference material out of the body/SKILL.md, or raise the ceiling deliberately.`);
        }
        for (const [provider, v] of Object.entries(row.perProvider)) {
            for (const skillId of v.missing) {
                problems.push(`${row.id}: preloads committed skill "${skillId}" on ${provider}, but ${PROVIDER_PATHS[provider].skills}/${skillId}/SKILL.md does not exist - the preload is a silent no-op there`);
            }
        }
    }
    // An unspent budget is also information: a ceiling nobody approaches is not a control.
    for (const id of Object.keys(budgets.perAgentChars)) {
        if (!rows.some((r) => r.id === id)) problems.push(`budget declared for "${id}", which is not an active agent`);
    }
    return { rows, problems };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const reportOnly = process.argv.includes('--report');
    const { rows, problems } = checkBudget();
    console.log('per-spawn context cost (adapter body + preloaded SKILL.md + inherited CLAUDE.md/AGENTS.md on Claude), measured per provider\n');
    console.log(`  ${'agent'.padEnd(28)} ${'worst on'.padEnd(12)} ${'body'.padStart(8)} ${'skills'.padStart(8)} ${'project'.padStart(8)} ${'total'.padStart(8)}  ~tokens`);
    for (const r of rows) {
        console.log(`  ${r.id.padEnd(28)} ${r.provider.padEnd(12)} ${String(r.bodyChars).padStart(8)} ${String(r.skillChars).padStart(8)} ${String(r.projectChars).padStart(8)} ${String(r.total).padStart(8)}  ~${Math.round(r.total / CHARS_PER_TOKEN)}`);
        const others = Object.entries(r.perProvider).filter(([p]) => p !== r.provider)
            .sort((a, b) => b[1].total - a[1].total)
            .map(([p, v]) => `${p} ${v.total}`);
        if (others.length) console.log(`  ${''.padEnd(28)} ${'also:'.padEnd(12)} ${others.join(' \u00b7 ')}`);
    }
    const worst = rows[0];
    console.log(`\n  worst single spawn: ${worst.id} on ${worst.provider} at ~${Math.round(worst.total / CHARS_PER_TOKEN)} tokens before any work begins.`);
    console.log('  project instructions are counted on Claude only (documented there); other providers\' figures are a floor.');

    // Reported, never fatal: on a clean checkout these are absent by design, so the
    // measured figures above are a LOWER bound there than on a machine that has run
    // `npx skills install`. Say so rather than let the number look exact.
    const gaps = rows.flatMap((r) => Object.entries(r.perProvider)
        .flatMap(([p, v]) => v.notMaterialized.map((s) => `${r.id}/${p} -> ${s}`)));
    if (gaps.length) {
        console.log(`\n  not materialized here (external, gitignored - preload is a no-op on this checkout): ${gaps.join(', ')}`);
    }

    if (problems.length) {
        console.error('\ncontext budget - problems:\n');
        for (const p of problems) console.error(`  - ${p}`);
        if (!reportOnly) process.exit(1);
    } else {
        console.log('\ncheck-context-budget OK - every active agent is inside its declared ceiling.');
    }
    process.exit(0);
}
