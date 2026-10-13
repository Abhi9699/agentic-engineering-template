#!/usr/bin/env node
/**
 * Generate the discovery mirrors under .agents/skills/<id>/SKILL.md.
 *
 *   node scripts/agent-system/generate-skill-mirrors.mjs           # write
 *   node scripts/agent-system/generate-skill-mirrors.mjs --check   # fail on drift
 *
 * WHY THESE EXIST. There are two skill roots: Claude reads `.claude/skills/`, Codex and
 * Antigravity read `.agents/skills/`. A first-party skill is canonical in exactly one of
 * them — beside its data, scripts and driver — and needs a pointer in the other, or the
 * providers that read the other root cannot discover it at all. Direction is derived from
 * `mirrorOf`, so it works both ways between `.claude` and `.agents`.
 *
 * WHY THEY ARE GENERATED (2026-09-02). Hand-written mirrors previously drifted
 * over time when reference sections were duplicated without automated verification.
 *
 * The fix is not a better copy. A mirror carries NO reference content at all: name,
 * description, and where the real guide is. Duplicated reference material that nothing
 * checks will drift, and a partial list that looks whole is worse than a pointer. The
 * canonical file is the single source, exactly as `_shared.md` is for adapter prose.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The two skill roots. Claude reads its own; Codex and Antigravity read `.agents/skills`.
 * A first-party skill is canonical in ONE of them and needs a discovery mirror in the
 * OTHER, or its preload silently no-ops on half the providers — which is exactly what had
 * happened to content-growth-intelligence on Claude until the per-provider context budget
 * measured it on 2026-09-02.
 */
const SKILL_ROOTS = ['.claude/skills', '.agents/skills'];
const MANIFEST = 'agent-system/skills.json';
/**
 * Repo policy ABOUT a skill — binding rules that are ours, not the skill author's, and
 * that therefore have no home in a vendored canonical file. One file per skill, emitted
 * into the mirror. This is the only content a mirror may carry beyond the pointer, and
 * like `_shared.md` it has exactly one home, so it cannot drift into two versions.
 */
const POLICY_DIR = 'agent-system/instructions/_skills';
const norm = (text) => text.replace(/\r\n/g, '\n');

/** Minimal YAML frontmatter reader — these files are generated, so the shape is known. */
export function readFrontmatter(text) {
    const match = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, '\n'));
    if (!match) return null;
    const fields = {};
    const lines = match[1].split('\n');
    for (let i = 0; i < lines.length; i++) {
        const kv = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(lines[i]);
        // Only top-level scalars matter here; nested blocks (metadata:) are skipped.
        if (!kv || kv[2] === '') continue;
        if (/^[>|][+-]?$/.test(kv[2])) {
            // Block scalar (`description: >`): its indented lines ARE the value. Reading
            // the indicator alone once mirrored a description of just ">" (typesafe-ai).
            const body = [];
            while (i + 1 < lines.length && /^(\s+\S|\s*$)/.test(lines[i + 1])) body.push(lines[++i].trim());
            fields[kv[1]] = body.filter(Boolean).join(' ');
        } else {
            fields[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1').trim();
        }
    }
    return fields;
}

/**
 * The mirror body. Identity comes from the canonical file so the two can never disagree
 * about what the skill IS; everything else is a fixed pointer.
 */
export function mirrorRootFor(skill) {
    const canonicalRoot = SKILL_ROOTS.find((root) => skill.mirrorOf.startsWith(`${root}/`));
    return canonicalRoot ? SKILL_ROOTS.find((root) => root !== canonicalRoot) : null;
}

/** A plain scalar unless YAML would misread it (": ", " #", a leading indicator) — then quoted. */
export function yamlScalar(value) {
    return /: | #|^[>|'"&*!%@`{[\]#?:,-]/.test(value) ? JSON.stringify(value) : value;
}

export function renderMirror(skill, canonicalFrontmatter, policy = null) {
    const canonicalFile = `${skill.mirrorOf}/SKILL.md`;
    const mirrorRoot = mirrorRootFor(skill);
    const readers = mirrorRoot === '.claude/skills' ? 'Claude' : 'Codex and Antigravity';
    const policyBlock = policy ? `
## Project policy for this skill (binding — do not skip)

${policy}
` : '';
    return `---
name: ${skill.id}
description: ${yamlScalar(canonicalFrontmatter.description)}
---

# ${skill.id} (discovery mirror)

**The skill is \`${canonicalFile}\`. Open and read that file — this one is a pointer, not a summary.**

\`\`\`bash
cat ${canonicalFile}
\`\`\`

This mirror exists only so the skill is discoverable in \`${mirrorRoot}/\`, the root
${readers} read${readers === 'Claude' ? 's' : ''}. It deliberately carries no commands, no options and no reference
table: a partial copy reads as complete, stops you opening the real guide, and drifts
silently. Nothing in the canonical file assumes a particular tool — read it there.
${policyBlock}
_Generated from ${MANIFEST} + ${canonicalFile} by scripts/agent-system/generate-skill-mirrors.mjs. Edit the canonical file, not this one._
`;
}

export function buildMirrors(root = process.cwd()) {
    const skills = JSON.parse(readFileSync(path.join(root, MANIFEST), 'utf8')).skills;
    const results = [];
    for (const skill of skills) {
        if (!skill.mirrorOf || skill.status === 'quarantined') continue;
        const canonicalFile = path.join(root, skill.mirrorOf, 'SKILL.md');
        if (!existsSync(canonicalFile)) {
            results.push({ id: skill.id, problem: `mirrorOf points at ${skill.mirrorOf}, which has no SKILL.md` });
            continue;
        }
        const frontmatter = readFrontmatter(readFileSync(canonicalFile, 'utf8'));
        if (!frontmatter?.description) {
            results.push({ id: skill.id, problem: `${skill.mirrorOf}/SKILL.md has no frontmatter description to mirror` });
            continue;
        }
        const mirrorRoot = mirrorRootFor(skill);
        if (!mirrorRoot) {
            results.push({ id: skill.id, problem: `mirrorOf "${skill.mirrorOf}" is under neither ${SKILL_ROOTS.join(' nor ')}` });
            continue;
        }
        const policyFile = path.join(root, POLICY_DIR, `${skill.id}.md`);
        const policy = existsSync(policyFile) ? norm(readFileSync(policyFile, 'utf8')).trim() : null;
        results.push({
            id: skill.id,
            file: path.join(mirrorRoot, skill.id, 'SKILL.md'),
            content: renderMirror(skill, frontmatter, policy),
        });
    }
    return results;
}

export function checkMirrors(root = process.cwd()) {
    const problems = [];
    const stale = [];
    for (const mirror of buildMirrors(root)) {
        if (mirror.problem) {
            problems.push(`${mirror.id}: ${mirror.problem}`);
            continue;
        }
        const absolute = path.join(root, mirror.file);
        const onDisk = existsSync(absolute) ? readFileSync(absolute, 'utf8').replace(/\r\n/g, '\n') : null;
        if (onDisk !== mirror.content) stale.push(mirror.file);
    }
    return { problems, stale };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const check = process.argv.includes('--check');
    const { problems, stale } = checkMirrors();
    if (problems.length) {
        console.error('generate-skill-mirrors — problems:\n');
        for (const p of problems) console.error(`  - ${p}`);
        process.exit(1);
    }
    if (check) {
        if (stale.length) {
            console.error('generate-skill-mirrors --check — these mirrors do not match their canonical skill:\n');
            for (const f of stale) console.error(`  - ${f}`);
            console.error('\nRun `npm run skills:mirrors` and re-pin with `npm run skills:sync -- --write`.');
            process.exit(1);
        }
        console.log('generate-skill-mirrors --check OK — every discovery mirror matches its canonical skill.');
        process.exit(0);
    }
    let written = 0;
    for (const mirror of buildMirrors()) {
        const absolute = path.join(process.cwd(), mirror.file);
        const onDisk = existsSync(absolute) ? readFileSync(absolute, 'utf8').replace(/\r\n/g, '\n') : null;
        if (onDisk === mirror.content) continue;
        mkdirSync(path.dirname(absolute), { recursive: true });
        writeFileSync(absolute, mirror.content);
        written += 1;
    }
    console.log(`generate-skill-mirrors OK — ${written} mirror(s) updated.`);
    process.exit(0);
}
