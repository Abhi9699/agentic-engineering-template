#!/usr/bin/env node
/**
 * agent:doctor — capability health (A-NOW item 6; AA-GAP-05, AA-GAP-11).
 *
 *   node scripts/agent-doctor.mjs           human report; always exits 0
 *   node scripts/agent-doctor.mjs --json    machine-readable findings
 *   node scripts/agent-doctor.mjs --strict  exit 1 on a REPO-CONTROLLED finding.
 *                                           Wired into `check:control-plane` 2026-09-03,
 *                                           so it runs in the gate and in CI. See the
 *                                           blocking/advisory split at the bottom of
 *                                           this file for what that deliberately
 *                                           excludes, and why.
 *
 * WHAT THIS IS FOR
 * `.agents/skills/` is gitignored except for a handful of re-included first-party
 * skills, so "the directory exists on my machine" says nothing about provenance.
 * Some directories are tracked, some are pinned in skills-lock.json, and some are
 * neither — present only because someone once installed them. An untrusted skill
 * is not inert: SKILL.md is instructions an agent may follow, and at least one
 * local skill prescribes Tailwind/shadcn, which AGENTS.md §4 forbids.
 *
 * WHAT THIS IS NOT
 *  - It does NOT suppress provider auto-discovery. Claude, Codex and Antigravity
 *    each scan their own skill directories; nothing here stops them. The only
 *    reliable quarantine today is running high-risk work in a sanitized worktree
 *    that does not contain the untrusted directory at all. Enforced exclusion is
 *    A2/A3 work.
 *  - It does NOT block. In A-NOW every finding is advisory (plan §15, item 6).
 *  - It counts nothing in advance: the inventory is discovered at run time, so
 *    this never fails for a stale snapshot (AA-GAP-26).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifySkills } from './agent-system/sync-skills.mjs';

const SKILLS_DIR = '.agents/skills';
const LOCK_PATH = 'skills-lock.json';
const MANIFEST_PATH = 'agent-system/skills.json';
const CLAUDE_AGENTS = '.claude/agents';

/** Instructions that contradict AGENTS.md §4. Advisory in v0; A2 owns the real lint. */
const RULE_CONFLICTS = [
    { pattern: /\btailwind\b/i, rule: '§4 — Vanilla CSS + CSS Modules only, no Tailwind' },
    { pattern: /\bshadcn\b/i, rule: '§4 — no shadcn/ui component library' },
    { pattern: /BLOCK_NONE/, rule: '§4 — Gemini safety stays BLOCK_MEDIUM_AND_ABOVE' },
    { pattern: /defineRelations/, rule: '§4 — no Drizzle relational-query API' },
];

/** Files git actually tracks under the skills dir. Local presence is not provenance. */
export function trackedSkillNames(cwd = process.cwd()) {
    try {
        const safeDirectory = path.resolve(cwd).replace(/\\/g, '/');
        const out = execFileSync('git', ['-c', `safe.directory=${safeDirectory}`, 'ls-files', `${SKILLS_DIR}/`], { cwd, encoding: 'utf8' });
        const names = new Set();
        for (const line of out.split('\n')) {
            const rel = line.trim().replace(/\\/g, '/');
            if (!rel) continue;
            const parts = rel.slice(SKILLS_DIR.length + 1).split('/');
            if (parts[0]) names.add(parts[0]);
        }
        return names;
    } catch {
        return null; // not a git checkout — reported as unknown rather than guessed
    }
}

/** Every directory actually present, discovered at run time. */
export function discoverSkillDirs(root = process.cwd()) {
    const dir = path.join(root, SKILLS_DIR);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((n) => statSync(path.join(dir, n)).isDirectory())
        .sort();
}

/**
 * Classify one directory. `tracked` may be null when git is unavailable, in which
 * case provenance is reported as unknown — never silently upgraded to trusted.
 */
export function classify(name, { tracked, locked, provenance = null }) {
    if (provenance) return provenance;
    if (tracked === null) return 'unknown-provenance';
    if (tracked.has(name)) return 'tracked-first-party';
    if (locked.has(name)) return 'lock-listed-external';
    return 'unregistered';
}

/** Skills each Claude subagent declares it needs, from `skills:` frontmatter. */
export function requiredSkillsByAgent(root = process.cwd()) {
    const dir = path.join(root, CLAUDE_AGENTS);
    const out = {};
    if (!existsSync(dir)) return out;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
        const text = readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n');
        const fm = text.match(/^---\n([\s\S]*?)\n---/);
        if (!fm) continue;
        // `skills:` appears in two YAML shapes and both are used in this repo:
        //   skills: [a, b]        (inline flow sequence)
        //   skills:\n  - a\n  - b (block sequence)
        // Work line-by-line. Slicing from the end of the `skills:` match instead
        // leaves a leading "" element (the newline), which terminates the block scan
        // immediately and silently reports NO required skills — worse than reporting
        // wrong ones, because every downstream check then passes vacuously.
        const lines = fm[1].split('\n');
        const idx = lines.findIndex((l) => /^skills:/.test(l));
        if (idx < 0) continue;
        let names = [];
        const inline = lines[idx].replace(/^skills:[ \t]*/, '').trim();
        if (inline) {
            names = inline.replace(/^\[|\]$/g, '').split(',');
        } else {
            for (let i = idx + 1; i < lines.length; i++) {
                const item = lines[i].match(/^[ \t]+-[ \t]*(.+)$/);
                if (!item) break; // first non-item line ends the block
                names.push(item[1]);
            }
        }
        names = names.map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        if (names.length) out[path.basename(file, '.md')] = names;
    }
    return out;
}

export function buildReport(root = process.cwd()) {
    const tracked = trackedSkillNames(root);
    let verification = null;
    let manifest = { skills: [] };
    let manifestError = null;
    try {
        verification = verifySkills(root);
        manifest = verification.manifest;
    } catch (e) {
        manifestError = e instanceof Error ? e.message : String(e);
    }
    const manifestById = new Map(manifest.skills.map((skill) => [skill.id, skill]));
    let lock = { skills: {} };
    let lockError = null;
    try {
        lock = JSON.parse(readFileSync(path.join(root, LOCK_PATH), 'utf8'));
    } catch (e) {
        lockError = e instanceof Error ? e.message : String(e);
    }
    const locked = new Set(Object.keys(lock.skills ?? {}));

    const dirs = discoverSkillDirs(root);
    const skills = dirs.map((name) => {
        const kind = classify(name, { tracked, locked, provenance: manifestById.get(name)?.provenance });
        const skillMd = path.join(root, SKILLS_DIR, name, 'SKILL.md');
        const hasManifest = existsSync(skillMd);
        const conflicts = [];
        if (hasManifest) {
            const body = readFileSync(skillMd, 'utf8');
            for (const { pattern, rule } of RULE_CONFLICTS) if (pattern.test(body)) conflicts.push(rule);
        }
        return { name, kind, hasManifest, conflicts };
    });

    // Active manifest entries with no directory: this checkout lacks the capability.
    // provider-native skills are excluded because absence here is their PERMANENT and
    // correct state - the provider ships them, this repository has no bytes to install -
    // so counting them as a materialization gap would be a finding nobody can ever close.
    const providerNative = manifest.skills
        .filter((skill) => skill.status === 'active' && skill.provenance === 'provider-native')
        .map((skill) => ({ id: skill.id, availableOn: skill.availableOn ?? ['every provider'] }));
    const providerNativeIds = new Set(providerNative.map((skill) => skill.id));
    const missingMaterialization = manifest.skills
        .filter((skill) => skill.status === 'active' && !dirs.includes(skill.id) && !providerNativeIds.has(skill.id))
        .map((skill) => skill.id);

    // The blocking control-plane verifier owns integrity truth. The doctor reports
    // its result instead of preserving the pre-A2 assumption that no verifier exists.
    const integrityFindings = verification?.findings ?? [];
    const blockingIntegrityFindings = integrityFindings.filter((finding) => finding.severity !== 'info');
    const hashEntries = manifest.skills.filter((skill) => skill.integrity?.hash);
    const hashVerifiable = manifestError === null && blockingIntegrityFindings.length === 0;
    const hashStatus = {
        entriesWithHash: hashEntries.length,
        verifiable: hashVerifiable,
        reason: hashVerifiable
            ? `verified by scripts/agent-system/sync-skills.mjs using ${manifest.skills[0]?.integrity?.algorithm ?? 'the manifest-declared algorithm'}`
            : `integrity verification failed: ${manifestError ?? blockingIntegrityFindings.map((finding) => `${finding.skill}: ${finding.detail}`).join('; ')}`,
    };

    const required = requiredSkillsByAgent(root);
    const unresolvedRequirements = [];
    for (const [agent, names] of Object.entries(required)) {
        for (const n of names) {
            const found = skills.find((s) => s.name === n);
            if (!found) unresolvedRequirements.push({ agent, skill: n, problem: 'not present in .agents/skills' });
            else if (found.kind === 'unregistered') unresolvedRequirements.push({ agent, skill: n, problem: 'present but unregistered (no provenance)' });
        }
    }

    const unregistered = skills.filter((s) => s.kind === 'unregistered');
    const conflicting = skills.filter((s) => s.conflicts.length > 0);

    return {
        generatedAt: new Date().toISOString(),
        reportOnly: true,
        inventory: { total: dirs.length, byKind: countBy(skills.map((s) => s.kind)) },
        skills,
        lockError,
        manifestError,
        missingMaterialization,
        providerNative,
        hashStatus,
        unresolvedRequirements,
        proposedQuarantine: unregistered.map((s) => ({
            skill: s.name,
            reason: s.conflicts.length ? `unregistered; also conflicts with ${s.conflicts.join('; ')}` : 'unregistered — no tracked manifest and no lock entry',
            remediation: `Either register it in ${MANIFEST_PATH} with provenance and a verifiable integrity pin, then regenerate ${LOCK_PATH}, ` +
                `or remove the directory. Until then, run high-risk work in a sanitized worktree that does not contain it. ` +
                `Nothing is deleted by this tool.`,
        })),
        providerSecretConfinement: providerConfinement(root),
        conflicting: conflicting.map((s) => ({ skill: s.name, conflicts: s.conflicts })),
    };
}

/**
 * Which providers actually deny reading a secret on disk (A-NOW item 1). The git
 * hooks are write/commit protection only, so this is per-provider or nothing.
 */
function providerConfinement(root) {
    const claudeSettings = path.join(root, '.claude/settings.json');
    let claude = { provider: 'claude', status: 'unsupported', detail: 'no settings.json found' };
    if (existsSync(claudeSettings)) {
        try {
            const deny = JSON.parse(readFileSync(claudeSettings, 'utf8'))?.permissions?.deny ?? [];
            const reads = deny.filter((r) => /^Read\(.*(\.env|service_account)/.test(r));
            claude = reads.length
                ? { provider: 'claude', status: 'confined', detail: `${reads.length} secret Read() deny rules` }
                : { provider: 'claude', status: 'unsupported', detail: 'settings.json has no secret Read() deny rules' };
        } catch {
            claude = { provider: 'claude', status: 'unknown', detail: 'settings.json is unparseable' };
        }
    }
    return [
        claude,
        { provider: 'codex', status: 'unsupported', detail: 'no repository-level read-denial control; use a secret-free worktree' },
        { provider: 'antigravity', status: 'unsupported', detail: 'no repository-level read-denial control; use a secret-free worktree' },
        { provider: 'copilot', status: 'unsupported', detail: 'no repository-level read-denial control; use a secret-free worktree' },
        { provider: 'cursor', status: 'unsupported', detail: 'no repository-level read-denial control; use a secret-free worktree' },
    ];
}

function countBy(values) {
    const out = {};
    for (const v of values) out[v] = (out[v] ?? 0) + 1;
    return out;
}

function render(report) {
    const L = [];
    L.push('agent:doctor v0 — REPORT ONLY (nothing here blocks; A-NOW item 6)');
    L.push('');
    L.push(`Skill inventory (${SKILLS_DIR}) — ${report.inventory.total} directories discovered:`);
    for (const [kind, n] of Object.entries(report.inventory.byKind)) L.push(`  ${String(n).padStart(3)}  ${kind}`);
    L.push('');

    for (const s of report.skills) {
        const flag = s.kind === 'unregistered' ? '!' : ' ';
        const extra = [!s.hasManifest ? 'no SKILL.md' : null, s.conflicts.length ? `CONFLICTS: ${s.conflicts.join('; ')}` : null]
            .filter(Boolean).join(' · ');
        L.push(` ${flag} ${s.name.padEnd(34)} ${s.kind}${extra ? `  [${extra}]` : ''}`);
    }
    L.push('');

    if (report.lockError) L.push(`LOCK UNREADABLE: ${report.lockError}\n`);

    L.push(`Pin verification: ${report.hashStatus.entriesWithHash} manifest entries carry a hash; verifiable = ${report.hashStatus.verifiable}`);
    L.push(`  ${report.hashStatus.reason}`);
    L.push('');

    if (report.missingMaterialization.length) {
        L.push('Lock-listed but NOT materialized (a clean clone lacks these capabilities):');
        for (const n of report.missingMaterialization) L.push(`  - ${n}`);
        L.push('');
    }

    if (report.providerNative?.length) {
        L.push('Provider-native (shipped by the provider; nothing here can materialize, pin or verify them):');
        for (const skill of report.providerNative) L.push(`  - ${skill.id.padEnd(24)} available on: ${skill.availableOn.join(', ')}`);
        L.push('');
    }

    if (report.unresolvedRequirements.length) {
        L.push('Agents requiring a skill that is missing or unregistered:');
        for (const u of report.unresolvedRequirements) L.push(`  - ${u.agent} → ${u.skill}: ${u.problem}`);
        L.push('');
    }

    if (report.proposedQuarantine.length) {
        L.push('PROPOSED QUARANTINE (advisory — no route may require these; nothing is deleted):');
        for (const q of report.proposedQuarantine) {
            L.push(`  - ${q.skill}: ${q.reason}`);
            L.push(`      remediation: ${q.remediation}`);
        }
        L.push('');
        L.push('  NOTE: this tool does NOT suppress provider auto-discovery. Provider skill loaders');
        L.push('  can still scan their own directories. The only reliable quarantine');
        L.push('  today is a sanitized worktree without these directories. Enforcement is A2/A3.');
        L.push('');
    }

    L.push('Secret READ confinement by provider (git hooks are write/commit protection only):');
    for (const p of report.providerSecretConfinement) L.push(`  ${p.provider.padEnd(12)} ${p.status.padEnd(12)} ${p.detail}`);
    L.push('');

    const findings = report.proposedQuarantine.length + report.unresolvedRequirements.length + report.missingMaterialization.length + (report.hashStatus.verifiable ? 0 : 1);
    L.push(findings === 0 ? 'No findings.' : `${findings} finding(s) — advisory in A-NOW.`);
    return L.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const report = buildReport();
    if (process.argv.includes('--json')) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log(render(report));
    }
    /*
     * WHAT `--strict` BLOCKS ON, AND WHY IT IS NOT EVERYTHING (2026-09-03).
     *
     * `--strict` is wired into `check:control-plane`, so it runs in the gate and in
     * CI. That constrains what it may count: a blocking check must be decidable from
     * TRACKED files alone, or it reports one answer on a developer's machine and a
     * different one in CI, and the difference is whichever third-party skills that
     * person happens to have installed.
     *
     *   BLOCKING — decidable from TRACKED files alone:
     *     hashStatus.verifiable   the integrity pins in agent-system/skills.json and
     *                             skills-lock.json cannot be verified. Both files are
     *                             committed, so this answers identically everywhere.
     *
     *   ADVISORY — resolved against `.agents/skills` ON DISK, printed never blocking:
     *     proposedQuarantine      unregistered skill directories. Every current
     *                             instance is a gitignored third-party install
     *                             (`banner-design`, `slides` — both claudekit).
     *     missingMaterialization  a registered skill absent from disk. Skills are
     *                             gitignored, so in CI this is universally true.
     *     unresolvedRequirements  an agent requires a skill that is missing OR
     *                             unregistered.
     *
     * `unresolvedRequirements` WAS classified as blocking when this split was written on
     * 2026-09-03, and CI rejected it within the hour. It reads like a repository fact —
     * "an agent requires a skill the manifest cannot resolve" — but `requiredSkillsByAgent`
     * resolves against `.agents/skills` on disk, and a clean clone has none of them. CI
     * failed with `ui-engineer → web-design-guidelines: not present in .agents/skills`
     * while the same command exited 0 locally. That is precisely the defect this comment
     * was warning about, committed in the same change that named it.
     *
     * The advisory set is not "less important" — quarantine is L-023, still OPEN, and the
     * only reliable control remains a sanitized worktree. It is that a gate firing on
     * state outside the repository reports one answer locally and another in CI, and
     * teaches people to bypass the gate.
     *
     * The genuinely repo-decidable version of the requirements check is whether every
     * required skill is REGISTERED IN `agent-system/skills.json` — a tracked file —
     * rather than present on disk. That is worth building; it is not this function.
     */
    const blocking = report.hashStatus.verifiable ? 0 : 1;
    const advisory =
        report.proposedQuarantine.length
        + report.missingMaterialization.length
        + report.unresolvedRequirements.length;

    if (process.argv.includes('--strict') && blocking > 0) {
        console.error(`
agent:doctor --strict — ${blocking} repo-controlled finding(s) [BLOCK].`);
        if (advisory) console.error(`  (${advisory} further advisory finding(s) depend on local installs and do not block.)`);
        process.exit(1);
    }
    process.exit(0);
}
