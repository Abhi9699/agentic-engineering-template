#!/usr/bin/env node
/**
 * Zero-drift agent-config mirrors (spec §3 Layer 1).
 *
 * The portable rules digest is authored ONCE in `agent-system/rules-digest.md`
 * between `AGENT-RULES-DIGEST` markers. It summarises AGENTS.md §4 and lived
 * inside AGENTS.md until 2026-09-16; it moved out so agents that load AGENTS.md
 * natively stop paying for every rule twice. AGENTS.md stays the authority.
 * This script copies it into every tool mirror's `GENERATED:agent-rules`
 * region. Hand-authored preamble outside the markers is preserved untouched.
 *
 *   npm run gen:configs            regenerate the mirrors
 *   npm run gen:configs -- --check drift gate: exit 1 if any mirror is stale
 *
 * CI runs --check, so a rule edited in the digest but not propagated cannot
 * merge.
 *
 * ANTIGRAVITY PATHS (A-NOW item 2 — AA-GAP-04). Antigravity's CURRENT workspace
 * locations are `.agents/rules`, `.agents/skills` and `.agents/agents` (plural).
 * The singular `.agent/rules` is a legacy fallback that still resolves today —
 * which is exactly the danger: generating only the legacy path worked, so
 * nothing surfaced the fact that we were writing to a deprecated location. Both
 * are generated during migration; the legacy mirror is marked `legacy: true` and
 * is removed only when the fallback is formally retired.
 *
 * Note the path trap: `.agent/` (singular) = rules only; `.agents/` (plural) =
 * rules AND the Codex/Antigravity skills dir. The skills subtree is not a target
 * here — only `.agents/rules/`.
 * Source: https://antigravity.google/docs/rules-workflows (checked 2026-07-31).
 *
 * DOMAIN RULES (doc 34 W1, 2026-10-03). The row-level hard rules live in one
 * source per area, `agent-system/rules/<id>.md`, so AGENTS.md stays small and a
 * rule loads only when an agent touches its files. Each source is emitted twice:
 * `.claude/rules/<id>.md` with a `paths:` list (Claude loads it when Read, Write
 * or Edit touches a matching file; https://code.claude.com/docs/en/memory,
 * checked 2026-10-03), and `.agents/rules/<antigravity>` with `trigger: glob`.
 * A source marked `legacy: true` is also written to the singular `.agent/rules/`.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { replaceRegion } from './lib/markers.mjs';

const DIGEST_START = '<!-- AGENT-RULES-DIGEST START';
const DIGEST_END = '<!-- AGENT-RULES-DIGEST END -->';

/** The single file the digest is read from. */
export const DIGEST_SOURCE = 'agent-system/rules-digest.md';

/** @type {Array<{ tool: string, path: string, legacy?: boolean }>} */
export const TARGETS = [
    { tool: 'antigravity', path: '.agents/rules/agent-conventions.md' },
    { tool: 'antigravity', path: '.agent/rules/agent-conventions.md', legacy: true },
    { tool: 'copilot', path: '.github/copilot-instructions.md' },
    { tool: 'cursor', path: '.cursorrules' },
    { tool: 'gemini', path: 'GEMINI.md' },
    { tool: 'llms', path: 'llms.txt' },
];

/** Directory holding one rule source per domain. */
export const RULE_SOURCES_DIR = 'agent-system/rules';

/**
 * Pure: split a rule source into its frontmatter fields and body. Only the three
 * fields this generator uses are read: a `paths:` list, `antigravity:` and `legacy:`.
 */
export function parseRuleSource(text, id = 'rule') {
    const t = text.replace(/\r\n/g, '\n');
    const m = /^---\n([\s\S]*?)\n---\n/.exec(t);
    if (!m) throw new Error(`${RULE_SOURCES_DIR}/${id}.md has no frontmatter`);
    const paths = [...m[1].matchAll(/^\s+-\s+"([^"]+)"\s*$/gm)].map((x) => x[1]);
    const antigravity = /^antigravity:\s*(\S+)\s*$/m.exec(m[1])?.[1];
    const legacy = /^legacy:\s*true\s*$/m.test(m[1]);
    if (!paths.length) throw new Error(`${RULE_SOURCES_DIR}/${id}.md declares no paths`);
    if (!antigravity) throw new Error(`${RULE_SOURCES_DIR}/${id}.md declares no antigravity file name`);
    return { paths, antigravity, legacy, body: t.slice(m[0].length).replace(/^\n+/, '') };
}

const generatedNote = (id) =>
    `<!-- GENERATED from ${RULE_SOURCES_DIR}/${id}.md by \`npm run gen:configs\`. Edit the source, not this file. -->\n\n`;
const yamlList = (key, items) => `${key}:\n${items.map((p) => `  - "${p}"\n`).join('')}`;

/** Pure: every provider file one rule source produces, as `{ path, content }`. */
export function renderRuleOutputs(id, sourceText) {
    const r = parseRuleSource(sourceText, id);
    const claude = `---\n${yamlList('paths', r.paths)}---\n${generatedNote(id)}${r.body}`;
    // Antigravity documents `globs` as one comma-separated string (https://antigravity.google/docs/rules,
    // checked 2026-10-03); Claude takes a YAML list.
    const antigravity = `---\ntrigger: glob\nglobs: "${r.paths.join(', ')}"\n---\n${generatedNote(id)}${r.body}`;
    const out = [
        { path: `.claude/rules/${id}.md`, content: claude },
        { path: `.agents/rules/${r.antigravity}`, content: antigravity },
    ];
    if (r.legacy) out.push({ path: `.agent/rules/${r.antigravity}`, content: antigravity });
    return out;
}

/** Every generated rule file, read from the sources on disk. */
export function allRuleOutputs(root = '.') {
    const dir = `${root}/${RULE_SOURCES_DIR}`;
    return readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .flatMap((f) => renderRuleOutputs(f.slice(0, -3), readFileSync(`${dir}/${f}`, 'utf8')));
}

/** Pure: inject the digest into a target file's generated region. */
export function renderTarget(currentText, digest) {
    return replaceRegion(currentText, 'agent-rules', digest);
}

/** Read the canonical digest body out of the digest source text. */
export function readDigest(sourceText) {
    const s = sourceText.indexOf(DIGEST_START);
    const e = sourceText.indexOf(DIGEST_END);
    if (s === -1 || e === -1 || e < s) {
        throw new Error(`${DIGEST_SOURCE} is missing the AGENT-RULES-DIGEST region`);
    }
    const bodyStart = sourceText.indexOf('-->', s) + 3;
    const body = sourceText.slice(bodyStart, e).trim();
    if (!body) throw new Error(`AGENT-RULES-DIGEST region in ${DIGEST_SOURCE} is empty`);
    return body;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const check = process.argv.includes('--check');
    const digest = readDigest(readFileSync(DIGEST_SOURCE, 'utf8'));
    let drift = 0;
    for (const { path } of TARGETS) {
        let cur;
        try {
            cur = readFileSync(path, 'utf8');
        } catch {
            console.error(`missing mirror: ${path} (create it with the GENERATED:agent-rules markers, then re-run)`);
            drift++;
            continue;
        }
        const next = renderTarget(cur, digest);
        // Compare line-ending-insensitive: on a mixed Windows/Linux team with
        // core.autocrlf, an exact-string compare reports false drift purely from
        // CRLF↔LF. Content drift is what matters; write `next` verbatim when it
        // differs (git normalizes on commit).
        const changed = next.replace(/\r\n/g, '\n') !== cur.replace(/\r\n/g, '\n');
        if (changed) {
            drift++;
            if (check) {
                console.error(`drift: ${path} is out of sync with ${DIGEST_SOURCE}`);
            } else {
                writeFileSync(path, next);
                console.log(`updated ${path}`);
            }
        }
    }
    const outputs = allRuleOutputs();
    for (const { path, content } of outputs) {
        const cur = existsSync(path) ? readFileSync(path, 'utf8') : null;
        if (cur !== null && cur.replace(/\r\n/g, '\n') === content) continue;
        drift++;
        if (check) {
            console.error(`drift: ${path} is out of sync with ${RULE_SOURCES_DIR}/`);
        } else {
            mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
            writeFileSync(path, content);
            console.log(`updated ${path}`);
        }
    }
    // `.claude/rules/` holds only generated files, so a file there with no source is
    // a rule renamed or deleted at the source that would otherwise keep loading.
    const expected = new Set(outputs.map((o) => o.path));
    if (existsSync('.claude/rules')) {
        for (const f of readdirSync('.claude/rules').filter((n) => n.endsWith('.md'))) {
            if (!expected.has(`.claude/rules/${f}`)) {
                drift++;
                console.error(`orphan: .claude/rules/${f} has no source in ${RULE_SOURCES_DIR}/ (delete it)`);
            }
        }
    }
    if (check && drift) {
        console.error(`\nRun \`npm run gen:configs\` and commit the result.`);
        process.exit(1);
    }
    console.log(check ? `gen:configs --check OK — mirrors in sync with ${DIGEST_SOURCE}` : `gen:configs done (${drift} file(s) updated)`);
}
