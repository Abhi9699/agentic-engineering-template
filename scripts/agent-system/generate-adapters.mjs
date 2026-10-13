#!/usr/bin/env node
/**
 * Generate provider-specific agent adapters from the manifest + instruction files.
 *
 * SOURCE OF TRUTH (restructured 2026-08-27). Adapters are pure OUTPUT. Before this,
 * the body was read back out of the adapter file and rewritten verbatim, so the
 * manifest owned only frontmatter and `--check` compared each adapter against itself.
 * That silently preserved real drift for months: Codex's backend-engineer still
 * claimed the money path after it moved to billing-integrity-engineer, and every
 * Antigravity specialist shipped ~1KB of boilerplate where Claude had the full
 * contract (its billing agent carried no 402, idempotency or reserve/refund rules
 * at all) - while the gate reported "every provider adapter matches the manifest".
 *
 * Now: agent-system/instructions/<agent>/_shared.md is the NORMATIVE contract and is
 * emitted to every provider, so a rule cannot exist on one tool and not another.
 * An optional <provider>.md appends provider-specific detail. Nothing is read back
 * out of an adapter, so `--check` is a real comparison and drift is unrepresentable.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isGeneratedSubagent } from './agent-kinds.mjs';

const PROVIDER_FILES = {
    claude: { dir: '.claude/agents', suffix: '.md' },
    codex: { dir: '.codex/agents', suffix: '.toml' },
    antigravity: { dir: '.agents/agents', suffix: '.md' },
    copilot: { dir: '.github/agents', suffix: '.agent.md' },
    cursor: { dir: '.cursor/agents', suffix: '.md' },
};
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const norm = (value) => value.replace(/\r\n/g, '\n');
const KNOWN_CLAUDE_TOOLS = new Set([
    'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash', 'Skill', 'WebFetch', 'WebSearch',
    'NotebookEdit', 'Task', 'TodoWrite',
]);
/**
 * Antigravity tool identifiers. Split by provenance on purpose: Antigravity's docs
 * warn that "a misspelled tool name in the `tools` list may cause the subagent
 * process to hang", and `tools` defaults to `[]` (no tools) rather than to all tools -
 * so both a wrong name and a missing list are silent, total failures.
 * Source: https://antigravity.google/docs/subagents +
 * https://antigravity.google/blog/introducing-custom-agents (verified 2026-09-02).
 */
const ANTIGRAVITY_TOOLS_DOC_CONFIRMED = new Set([
    'view_file', 'replace_file_content', 'grep_search', 'run_command',
    'manage_task', 'invoke_subagent',
]);
/**
 * Names we rely on that the published docs only gesture at ("e.g. ..."), carried over
 * from the 2026-08-16 provider survey. They are the Windsurf-lineage names and are
 * what providers.json already claims for antigravity/public-web-research, but no
 * Google page enumerates them - so they are tracked separately rather than being
 * quietly promoted. Open question: vault/Open-Questions.md.
 */
const ANTIGRAVITY_TOOLS_UNVERIFIED = new Set([
    'find_by_name', 'search_web', 'read_url_content', 'send_message',
]);
const KNOWN_ANTIGRAVITY_TOOLS = new Set([...ANTIGRAVITY_TOOLS_DOC_CONFIRMED, ...ANTIGRAVITY_TOOLS_UNVERIFIED]);
/** Frontmatter enums, same source and date. Defaults: model `inherit`, policy `sandbox`. */
const ANTIGRAVITY_MODELS = new Set(['inherit', 'flash', 'pro']);

/**
 * How much reasoning an agent gets — ONE authored value, five provider spellings.
 *
 * WHY THIS IS DERIVED (2026-09-03)
 *
 * Before this, the cost of an agent was written in three places that nothing reconciled:
 * `budgets.json.modelTiers` (values `economy` | `inherit`, and read by NO code anywhere in
 * the repository — `economy` appeared nowhere else in the tree), `providerConfig.claude.model`
 * (`haiku` | `inherit`), and `providerConfig.antigravity.model` (`flash` | `inherit`). Only the
 * last two did anything. Three spellings of one decision is three chances to set it
 * differently, and the two that mattered were the two nobody would think to look at when
 * reading a manifest called "budgets".
 *
 * So `budgets.json.modelTiers` is now the single authored source and every provider spelling is
 * derived from it. An authored `model` in `providerConfig` is REFUSED, on the same principle the
 * generator already applies to prose ("a second source of truth for prose") — the manifest is
 * where the decision lives, and the adapter is output.
 *
 * A provider with no tier concept of its own maps both tiers to `inherit`. That is a real
 * limitation, not an oversight: on those providers an economy agent costs what everything else
 * costs, and saying so here is better than implying a saving that does not exist.
 */
export const COGNITIVE_TIERS = new Set(['economy', 'standard']);
const TIER_PROVIDER_MODEL = {
    claude: { economy: 'haiku', standard: 'inherit' },
    antigravity: { economy: 'flash', standard: 'inherit' },
    codex: { economy: 'inherit', standard: 'inherit' },
    copilot: { economy: 'inherit', standard: 'inherit' },
    cursor: { economy: 'inherit', standard: 'inherit' },
};

/** The provider's own spelling of a cognitive tier. `inherit` when it has no tier concept. */
export function resolveProviderModel(tier, provider) {
    return TIER_PROVIDER_MODEL[provider]?.[tier] ?? 'inherit';
}

/**
 * Attach the derived model to each provider config, in memory only.
 *
 * The renderers already read `cfg.model`; hydrating it here means they keep working unchanged
 * while the value's ONLY authored home is `budgets.json`. Nothing is written back to
 * `agents.json` — `validateForGeneration` refuses an authored `model` there, so the two can
 * never disagree.
 */
export function hydrateModels(agents, tiers) {
    return agents.map((agent) => ({
        ...agent,
        providerConfig: Object.fromEntries(
            Object.entries(agent.providerConfig ?? {}).map(([provider, cfg]) => [
                provider,
                { ...cfg, model: resolveProviderModel(tiers[agent.id], provider) },
            ]),
        ),
    }));
}
const ANTIGRAVITY_COMMAND_POLICIES = new Set(['off', 'auto', 'eager', 'sandbox']);
/** The only Antigravity tool that writes to the workspace. */
const ANTIGRAVITY_WRITE_TOOL = 'replace_file_content';
const KNOWN_COPILOT_TOOLS = new Set(['read', 'search', 'web', 'agent', 'execute', 'todo', 'edit']);

const INSTRUCTIONS_DIR = 'agent-system/instructions';
/** Where each provider actually reads skill files from, for the generated footer. */
const PROVIDER_SKILL_DIR = {
    claude: '.claude/skills', codex: '.agents/skills', antigravity: '.agents/skills',
    copilot: '.agents/skills', cursor: '.agents/skills',
};

/** Read the normative body plus any provider-specific appendix for one agent. */
function loadInstructions(root, agentId) {
    const dir = path.join(root, INSTRUCTIONS_DIR, agentId);
    const read = (name) => {
        const file = path.join(dir, name);
        return existsSync(file) ? norm(readFileSync(file, 'utf8')).trim() : null;
    };
    const byProvider = {};
    for (const provider of Object.keys(PROVIDER_FILES)) {
        const text = read(`${provider}.md`);
        if (text) byProvider[provider] = text;
    }
    return { shared: read('_shared.md'), byProvider };
}

export function loadControlPlane(root = process.cwd()) {
    const agents = readJson(path.join(root, 'agent-system/agents.json')).agents;
    return {
        agents,
        // Deliberately the RAW agents, un-hydrated: `validateForGeneration` has to be able to
        // see an authored `model` in order to refuse it, and hydration would hide one by
        // overwriting it with the derived value.
        tiers: readJson(path.join(root, 'agent-system/budgets.json')).modelTiers ?? {},
        skills: readJson(path.join(root, 'agent-system/skills.json')).skills,
        instructions: Object.fromEntries(agents.map((a) => [a.id, loadInstructions(root, a.id)])),
    };
}

/** A skill with no `availableOn` resolves everywhere; one with it resolves only there. */
export function isSkillAvailableOn(skill, provider) {
    return !skill?.availableOn || skill.availableOn.includes(provider);
}

/** Registered skill ids named in backticks anywhere in an agent's normative body. */
export function namedSkillsInProse(body, skillsById) {
    if (!body) return [];
    const named = new Set();
    for (const [, token] of body.matchAll(/`([a-z0-9][a-z0-9-]*)`/g)) {
        if (skillsById.has(token)) named.add(token);
    }
    return [...named];
}

/**
 * Skills this agent's prose names (preloaded or conditional) that do not exist on one
 * provider. Derived from skills.json `availableOn`, never stored, so it cannot go stale.
 */
export function skillAvailabilityGap(agent, provider, skills = []) {
    const byId = new Map(skills.map((skill) => [skill.id, skill]));
    return [...new Set([...(agent.requiredSkills ?? []), ...(agent.conditionalSkills ?? [])])]
        .filter((id) => byId.has(id) && !isSkillAvailableOn(byId.get(id), provider))
        .sort();
}

/** Fail closed before emitting an adapter a provider cannot load safely. */
export function validateForGeneration({ agents, skills, instructions = {}, tiers = {} }) {
    const problems = [];
    const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
    for (const agent of agents) {
        if (agent.runtime) {
            // main-session and built-in entries get no adapter (agent-kinds.mjs), so anything
            // that only feeds an adapter is dead config, and only their skill names need checking.
            if (agent.providerConfig || tiers[agent.id] || instructions[agent.id]?.shared) {
                problems.push(`${agent.id}: runtime "${agent.runtime}" is never generated, so providerConfig, a budgets.json tier or ${INSTRUCTIONS_DIR}/${agent.id}/ would be dead config - remove it`);
            }
            for (const skillId of [...(agent.requiredSkills ?? []), ...(agent.conditionalSkills ?? [])]) {
                if (!skillsById.has(skillId)) problems.push(`${agent.id}: names skill "${skillId}" that no manifest entry declares`);
            }
            continue;
        }
        if (agent.status === 'active' && !instructions[agent.id]?.shared) {
            problems.push(`${agent.id}: no ${INSTRUCTIONS_DIR}/${agent.id}/_shared.md - refusing to emit an adapter with no normative contract`);
        }
        /*
         * The cost of an agent has exactly one authored home. See TIER_PROVIDER_MODEL for why:
         * three unreconciled spellings existed before this, and the only one named "budgets"
         * was the one no code read.
         */
        if (agent.status === 'active' && !tiers[agent.id]) {
            problems.push(`${agent.id}: no entry in budgets.json modelTiers - every active agent must declare a cognitive tier, because "whatever the provider gives us" is a cost decision made by not making one`);
        }
        if (tiers[agent.id] && !COGNITIVE_TIERS.has(tiers[agent.id])) {
            problems.push(`${agent.id}: unknown cognitive tier "${tiers[agent.id]}" in budgets.json - expected one of ${[...COGNITIVE_TIERS].join(', ')}`);
        }
        for (const [provider, cfg] of Object.entries(agent.providerConfig ?? {})) {
            if (cfg.model) {
                problems.push(`${agent.id}: providerConfig.${provider} authors a "model" - the model is DERIVED from budgets.json modelTiers, so this is a second source of truth for the cost of an agent. Set the tier in budgets.json and delete this.`);
            }
            if ('maxTurns' in cfg && (provider !== 'claude' || !Number.isInteger(cfg.maxTurns) || cfg.maxTurns < 1)) {
                problems.push(`${agent.id}: providerConfig.${provider}.maxTurns - only Claude subagents support it, as a positive integer; it caps a run that would otherwise explore until its context is huge`);
            }
            if (provider !== 'claude' && 'omitClaudeMd' in cfg) {
                problems.push(`${agent.id}: providerConfig.${provider}.omitClaudeMd - only Claude subagents support it; no other provider drops its project instructions, so it would read as a saving that never happens`);
            }
        }
        // Prose lives in exactly one place. A manifest `instructions` field would be a
        // second source of truth, which is the defect this restructure removed.
        if (agent.instructions) {
            problems.push(`${agent.id}: manifest carries an "instructions" field - move it to ${INSTRUCTIONS_DIR}/${agent.id}/_shared.md so prose has one home`);
        }
        for (const provider of Object.keys(instructions[agent.id]?.byProvider ?? {})) {
            if (!agent.providers.includes(provider)) {
                problems.push(`${agent.id}: has ${INSTRUCTIONS_DIR}/${agent.id}/${provider}.md but does not claim provider "${provider}"`);
            }
        }
        const claude = agent.providerConfig?.claude;
        if (!claude) {
            problems.push(`${agent.id}: no providerConfig.claude - cannot generate the canonical adapter body`);
            continue;
        }
        for (const provider of agent.providers) {
            if (!PROVIDER_FILES[provider]) problems.push(`${agent.id}: unsupported provider "${provider}"`);
            if (!agent.providerConfig?.[provider]) problems.push(`${agent.id}: claims provider "${provider}" but has no providerConfig.${provider}`);
        }
        for (const tool of [...(claude.tools ?? []), ...(claude.disallowedTools ?? [])]) {
            if (!KNOWN_CLAUDE_TOOLS.has(tool)) problems.push(`${agent.id}: unknown tool identifier "${tool}" for Claude`);
        }
        // Antigravity gets no fallback to Claude's tool names. Until 2026-09-02 the
        // renderer fell back to `providerConfig.claude.tools`, so seven adapters shipped
        // `[Read, Edit, Write, Grep, Glob, Bash, ...]` - names Antigravity cannot map -
        // while this loop read `providerConfig.antigravity.tools`, was undefined for all
        // seven, and never ran. The gate reported green on the exact failure it exists
        // to catch. These checks are now keyed off the provider CLAIM, not off the
        // presence of the field being validated.
        const antigravity = agent.providerConfig?.antigravity;
        if (agent.providers.includes('antigravity') && antigravity) {
            if (!antigravity.tools?.length) {
                problems.push(`${agent.id}: providerConfig.antigravity.tools is missing or empty - Antigravity defaults \`tools\` to [] (no tools at all) and there is no fallback, so the subagent would load with nothing`);
            }
            for (const tool of antigravity.tools ?? []) {
                if (!KNOWN_ANTIGRAVITY_TOOLS.has(tool)) problems.push(`${agent.id}: unknown Antigravity tool identifier "${tool}" - an unmapped name can hang a subagent`);
            }
            if (agent.readOnly && antigravity.tools?.includes(ANTIGRAVITY_WRITE_TOOL)) {
                problems.push(`${agent.id}: read-only agent is granted "${ANTIGRAVITY_WRITE_TOOL}" - the tools allowlist is Antigravity's only write denial, so this would make the read-only role prose-only`);
            }
            if (antigravity.model && !ANTIGRAVITY_MODELS.has(antigravity.model)) {
                problems.push(`${agent.id}: unknown Antigravity model tier "${antigravity.model}" - expected one of ${[...ANTIGRAVITY_MODELS].join(', ')}`);
            }
            if (!ANTIGRAVITY_MODELS.has(resolveProviderModel(tiers[agent.id], 'antigravity'))) {
                problems.push(`${agent.id}: cognitive tier "${tiers[agent.id]}" derives Antigravity model "${resolveProviderModel(tiers[agent.id], 'antigravity')}", which is not one of ${[...ANTIGRAVITY_MODELS].join(', ')}`);
            }
            if (antigravity.commandExecutionPolicy && !ANTIGRAVITY_COMMAND_POLICIES.has(antigravity.commandExecutionPolicy)) {
                problems.push(`${agent.id}: unknown Antigravity commandExecutionPolicy "${antigravity.commandExecutionPolicy}" - expected one of ${[...ANTIGRAVITY_COMMAND_POLICIES].join(', ')}`);
            }
            if (antigravity.commandExecutionPolicy && !antigravity.tools?.includes('run_command')) {
                problems.push(`${agent.id}: declares commandExecutionPolicy but holds no "run_command" tool - the policy would govern nothing`);
            }
        }
        for (const tool of agent.providerConfig?.copilot?.tools ?? []) {
            if (!KNOWN_COPILOT_TOOLS.has(tool)) problems.push(`${agent.id}: unknown Copilot tool alias "${tool}"`);
        }
        for (const skillId of agent.requiredSkills ?? []) {
            const skill = skillsById.get(skillId);
            if (!skill) problems.push(`${agent.id}: requires skill "${skillId}" that no manifest entry declares`);
            else if (skill.status === 'quarantined') problems.push(`${agent.id}: requires quarantined skill "${skillId}" - refusing to emit a preload`);
            else {
                // A PRELOAD cannot be conditional on availability - if the provider does
                // not ship the skill, the adapter promises something that never loads.
                for (const provider of agent.providers) {
                    if (!isSkillAvailableOn(skill, provider)) {
                        problems.push(`${agent.id}: preloads "${skillId}" on provider "${provider}", where it does not exist (skills.json availableOn: ${skill.availableOn.join(', ')}). Move it to conditionalSkills or drop the provider claim`);
                    }
                }
            }
        }
        // The body is emitted VERBATIM to every provider, so a skill named in the prose is
        // named on every provider - including ones that do not have it. Declaring each in
        // requiredSkills/conditionalSkills is what makes that delta derivable, and what
        // lets the footer tell an agent not to go looking. (Limit, stated honestly: this
        // can only see skills the manifest knows about. A name no manifest entry declares
        // is invisible here - `npm run agent:doctor` reports unregistered skill dirs.)
        const declared = new Set([...(agent.requiredSkills ?? []), ...(agent.conditionalSkills ?? [])]);
        for (const skillId of namedSkillsInProse(instructions[agent.id]?.shared, skillsById)) {
            if (!declared.has(skillId)) {
                problems.push(`${agent.id}: names registered skill "${skillId}" in its prose but declares it in neither requiredSkills nor conditionalSkills - per-provider availability cannot be derived for it`);
            }
        }
        for (const skillId of agent.conditionalSkills ?? []) {
            const skill = skillsById.get(skillId);
            if (!skill) problems.push(`${agent.id}: names skill "${skillId}" in conditionalSkills that no manifest entry declares`);
            else if (skill.status === 'quarantined') problems.push(`${agent.id}: names quarantined skill "${skillId}" in conditionalSkills`);
        }
    }
    return problems;
}

/**
 * Structural facts restated from the manifest so they can never contradict it.
 * Derived, never stored: editing agents.json changes these on the next generate.
 */
function derivedFooter(agent, provider, skills) {
    const parts = [];
    if (agent.exclusiveOwnership?.length) {
        parts.push(`**You exclusively own:** ${agent.exclusiveOwnership.join(', ')}. Do not edit outside that scope without saying so.`);
    }
    if (agent.requiredSkills?.length) {
        const dir = PROVIDER_SKILL_DIR[provider];
        parts.push(`**Required skills:** ${agent.requiredSkills.map((skill) => `${dir}/${skill}/SKILL.md`).join(', ')}. Open and follow them; being told about a skill is not the same as using it.`);
    }
    // The body is emitted verbatim everywhere, so it names skills this provider may not
    // have. Stating the delta beats letting the agent hunt for a skill that cannot exist.
    const unavailable = skillAvailabilityGap(agent, provider, skills);
    if (unavailable.length) {
        parts.push(`**Not available on this provider (${provider}):** ${unavailable.map((s) => `\`${s}\``).join(', ')}. The contract above is identical on every tool, so it names them; they do not resolve here. Do not go looking - use the nearest listed alternative and say which you used.`);
    }
    if (agent.readOnly) {
        parts.push('**This is a read-only role.** Report findings; do not edit files or perform state-changing actions. Your shell is guarded, but staying inside the boundary is your responsibility, not the guard\'s.');
    }
    parts.push('The repository root `AGENTS.md` is binding: hard rules (section 4), the task contract (section 6), and the delivery loop - bounded retries, evidence or an honest "blocked", never a claim without proof.');
    parts.push(`_Generated from agent-system/agents.json + ${INSTRUCTIONS_DIR}/${agent.id}/. Edit those, not this file._`);
    return parts.join('\n\n');
}

/**
 * shared (normative, identical on every provider) + optional provider appendix
 * + derived structural facts. The adapter file is never an input.
 */
export function composeBody(agent, provider, instructions, skills) {
    const entry = instructions?.[agent.id] ?? {};
    return [entry.shared, entry.byProvider?.[provider], derivedFooter(agent, provider, skills)]
        .filter(Boolean).join('\n\n');
}

/** Claude adapter: generated frontmatter plus the composed body. */
export function renderClaude(agent, instructions, skills) {
    const cfg = agent.providerConfig.claude;
    const lines = ['---', `name: ${agent.id}`, `description: ${cfg.description}`];
    if (cfg.tools?.length) lines.push(`tools: ${cfg.tools.join(', ')}`);
    if (cfg.disallowedTools?.length) lines.push(`disallowedTools: ${cfg.disallowedTools.join(', ')}`);
    if (agent.requiredSkills?.length) {
        lines.push('skills:');
        for (const skill of agent.requiredSkills) lines.push(`  - ${skill}`);
    }
    if (cfg.memory) lines.push(`memory: ${cfg.memory}`);
    // The role takes its whole input from the delegation prompt, so the 14 KB AGENTS.md
    // import is pure per-spawn cost (doc 34 W4, E4). https://code.claude.com/docs/en/sub-agents
    if (cfg.omitClaudeMd === true) lines.push('omitClaudeMd: true');
    // A review answers a packet the caller already built, so a long run is exploration, and
    // each turn re-sends the whole context: 42 Opus reviews averaged ~3M tokens (2026-10-08).
    if (cfg.maxTurns) lines.push(`maxTurns: ${cfg.maxTurns}`);
    // A read-only role that holds Bash is only read-only by convention: `sed -i`,
    // `echo > file` and `git checkout` all mutate without touching Write/Edit.
    // Subagent frontmatter hooks make the documented boundary actually bite.
    if (agent.readOnly && cfg.tools?.includes('Bash')) {
        lines.push(
            'hooks:',
            '  PreToolUse:',
            '    - matcher: "Bash"',
            '      hooks:',
            '        - type: command',
            '          command: "node scripts/guard-readonly-agent.mjs"',
        );
    }
    lines.push(`model: ${cfg.model ?? 'inherit'}`, '---');
    return `${lines.join('\n')}\n\n${composeBody(agent, 'claude', instructions, skills)}\n`;
}

/** Codex adapter: generated header keys plus the composed developer instructions. */
export function renderCodex(agent, instructions, skills) {
    const cfg = agent.providerConfig.codex;
    const escape = (value) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const lines = [`name = "${agent.id}"`, `description = "${escape(cfg.description)}"`];
    if (cfg.sandboxMode) lines.push(`sandbox_mode = "${cfg.sandboxMode}"`);
    // TOML basic multi-line strings still interpret escapes, so a literal backslash
    // or a stray `"""` in the prose would corrupt the file.
    const body = composeBody(agent, 'codex', instructions, skills)
        .replace(/\\/g, '\\\\')
        .replace(/"""/g, '\\"\\"\\"');
    lines.push(`developer_instructions = """${body}"""`);
    return `${lines.join('\n')}\n`;
}

/**
 * Antigravity specialist: fully generated, using Antigravity's own tool names.
 *
 * No fallback to Claude's `tools`. Antigravity resolves names against its own
 * registry, so borrowing Claude's identifiers does not degrade gracefully - it
 * either hangs the subagent (documented known issue) or yields an agent with no
 * usable tools. `validateForGeneration` fails closed before we reach here.
 */
export function renderAntigravity(agent, instructions, skills) {
    const cfg = agent.providerConfig.antigravity;
    const lines = ['---', `name: ${agent.id}`, `description: ${cfg.description}`];
    if (cfg.tools?.length) lines.push(`tools: [${cfg.tools.join(', ')}]`);
    if (agent.requiredSkills?.length) lines.push(`skills: [${agent.requiredSkills.map((skill) => `skills/${skill}`).join(', ')}]`);
    // Both are pinned rather than defaulted: `model` carries the cost decision the
    // Claude adapter makes with its own tier name, and `commandExecutionPolicy` keeps
    // a future change to Antigravity's `sandbox` default from loosening us silently.
    if (cfg.model) lines.push(`model: ${cfg.model}`);
    if (cfg.commandExecutionPolicy) lines.push(`commandExecutionPolicy: ${cfg.commandExecutionPolicy}`);
    lines.push('---', '', `# ${agent.id}`, '', composeBody(agent, 'antigravity', instructions, skills), '');
    return lines.join('\n');
}

/** GitHub Copilot custom-agent adapter. */
export function renderCopilot(agent, instructions, skills) {
    const cfg = agent.providerConfig.copilot;
    const lines = ['---', `name: ${agent.id}`, `description: ${cfg.description}`];
    if (cfg.tools) lines.push(`tools: [${cfg.tools.join(', ')}]`);
    if (typeof cfg.userInvocable === 'boolean') lines.push(`user-invocable: ${cfg.userInvocable}`);
    if (typeof cfg.disableModelInvocation === 'boolean') lines.push(`disable-model-invocation: ${cfg.disableModelInvocation}`);
    lines.push('---');
    return `${lines.join('\n')}\n\n${composeBody(agent, 'copilot', instructions, skills)}\n`;
}

/** Cursor project subagent adapter. */
export function renderCursor(agent, instructions, skills) {
    const cfg = agent.providerConfig.cursor;
    const lines = [
        '---',
        `name: ${agent.id}`,
        `description: ${cfg.description}`,
        `model: ${cfg.model ?? 'inherit'}`,
        `readonly: ${cfg.readOnly ?? agent.readOnly === true}`,
        '---',
    ];
    return `${lines.join('\n')}\n\n${composeBody(agent, 'cursor', instructions, skills)}\n`;
}

export function generateAll(root = process.cwd(), { write = false } = {}) {
    const controlPlane = loadControlPlane(root);
    const problems = validateForGeneration(controlPlane);
    if (problems.length) return { problems, changed: [] };
    const changed = [];
    const emit = (relativePath, next) => {
        const absolutePath = path.join(root, relativePath);
        const current = existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : null;
        if (current !== null && norm(current) === norm(next)) return;
        changed.push(relativePath);
        if (write) {
            mkdirSync(path.dirname(absolutePath), { recursive: true });
            writeFileSync(absolutePath, next);
        }
    };

    /*
     * Hydrate AFTER validation, never before: validation's job includes refusing an authored
     * `model`, and hydrating first would overwrite one with the derived value and hide it.
     */
    const hydrated = hydrateModels(controlPlane.agents, controlPlane.tiers);

    for (const agent of hydrated) {
        if (!isGeneratedSubagent(agent)) continue;
        for (const provider of agent.providers) {
            const { dir, suffix } = PROVIDER_FILES[provider];
            const relativePath = path.join(dir, `${agent.id}${suffix}`);
            const { instructions, skills } = controlPlane;
            const next = provider === 'claude' ? renderClaude(agent, instructions, skills)
                : provider === 'codex' ? renderCodex(agent, instructions, skills)
                    : provider === 'antigravity' ? renderAntigravity(agent, instructions, skills)
                        : provider === 'copilot' ? renderCopilot(agent, instructions, skills)
                            : renderCursor(agent, instructions, skills);
            emit(relativePath, next);
        }
    }

    for (const [provider, { dir, suffix }] of Object.entries(PROVIDER_FILES)) {
        const absoluteDir = path.join(root, dir);
        if (!existsSync(absoluteDir)) continue;
        const active = new Set(controlPlane.agents
            .filter((agent) => isGeneratedSubagent(agent) && agent.providers.includes(provider))
            .map((agent) => agent.id));
        for (const file of readdirSync(absoluteDir).filter((name) => name.endsWith(suffix))) {
            const id = file.slice(0, -suffix.length);
            if (!active.has(id)) problems.push(`${dir}/${file} has no active ${provider} agent in the manifest - delete it or restore the provider claim`);
        }
    }
    return { problems, changed };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const check = process.argv.includes('--check');
    const { problems, changed } = generateAll(process.cwd(), { write: !check });
    if (problems.length) {
        console.error('generate-adapters - refusing to generate:\n');
        for (const problem of problems) console.error(`  - ${problem}`);
        process.exit(1);
    }
    if (check && changed.length) {
        console.error(`generate-adapters --check - ${changed.length} provider file(s) drifted from agent-system/agents.json:\n`);
        for (const file of changed) console.error(`  - ${file}`);
        console.error('\nRun `npm run agent:generate` and commit the result.');
        process.exit(1);
    }
    console.log(check
        ? 'generate-adapters --check OK - every provider adapter matches the manifest.'
        : `generate-adapters OK - ${changed.length} file(s) updated.`);
}
