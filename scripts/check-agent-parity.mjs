#!/usr/bin/env node
/**
 * STRUCTURAL roster/description parity gate (spec §11 — cross-tool agents).
 *
 * SCOPE — read this before quoting it (A-NOW item 5, AA-GAP-01/AA-GAP-02).
 * This checks matching Claude/Codex agent names and one-line descriptions plus
 * one provider-manifest fact: every active provider claim has an adapter file.
 *
 * It is NOT capability parity, and must never be described as such:
 *   - It does not compare Claude's `tools:`/`skills:`/`model:` frontmatter with
 *     anything on the Codex side, because Codex's TOML has no equivalent fields.
 *     A Claude agent can silently lose a required skill preload and this gate
 *     stays green.
 *   - It checks Antigravity, Copilot and Cursor adapter existence only; it does
 *     not prove those providers loaded or obeyed the files.
 *   - It does not verify that a named skill exists, is pinned, or ever loads.
 *
 * Semantic capability parity is owned by the provider-neutral manifests,
 * generated adapters, and control-plane checks. Even together those prove
 * configuration, not provider loading or runtime instruction adherence.
 *
 * Since 2026-08-27 both sides are GENERATED from agent-system/agents.json plus
 * agent-system/instructions/<agent>/, and the normative `_shared.md` body is emitted
 * verbatim to every provider - so prose parity is now a property of generation, and
 * `npm run check:control-plane` (generate-adapters --check) is what enforces it.
 * This file remains the cheap structural backstop on the two things that would still
 * drift silently if the manifest itself were edited carelessly (which is exactly what
 * happened when a Claude-side skill fix didn't reach the Codex twin):
 *
 *   1. Roster parity — every agent exists in BOTH dirs (same set of names).
 *   2. Description parity — the one-line `description` says the same thing in both,
 *      so an agent's SCOPE can't change on one platform without the other.
 *
 * Prose-body divergence is not checked HERE - it is made impossible upstream by the
 * generator, not detected downstream by this file. Run standalone or via `npm run gate`.
 *
 *   node scripts/check-agent-parity.mjs            # report + exit 1 on drift
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isGeneratedSubagent } from './agent-system/agent-kinds.mjs';

const CLAUDE_DIR = '.claude/agents';
const CODEX_DIR = '.codex/agents';
const PROVIDER_PATH = {
  claude: (id) => `.claude/agents/${id}.md`,
  codex: (id) => `.codex/agents/${id}.toml`,
  antigravity: (id) => `.agents/agents/${id}.md`,
  copilot: (id) => `.github/agents/${id}.agent.md`,
  cursor: (id) => `.cursor/agents/${id}.md`,
};

/**
 * Normalize a description for comparison: collapse whitespace, lowercase, strip
 * trailing punctuation, and fold the platform-specific delegation trigger
 * ("Use PROACTIVELY for" on Claude vs "Use for" on Codex) so only the actual
 * SCOPE is compared, not the per-tool convention word.
 */
function norm(s) {
  return s
    .replace(/\r/g, '')
    .replace(/\bproactively\b/gi, '') // Claude auto-delegation trigger; absent on Codex
    .replace(/["'“”]/g, '') // quoting style differs between the two files
    .replace(/[-—/]/g, ' ') // fold hyphens/em-dashes/slashes to spaces
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '')
    .toLowerCase();
}

/** Extract `description:` from a Claude .md YAML frontmatter block (CRLF-tolerant). */
function claudeDescription(text) {
  const t = text.replace(/\r\n/g, '\n');
  const fm = t.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const m = fm[1].match(/^description:\s*(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

/** Extract `description = "..."` from a Codex .toml. */
function codexDescription(text) {
  const m = text.match(/^description\s*=\s*"((?:[^"\\]|\\.)*)"/m);
  return m ? m[1].replace(/\\"/g, '"') : null;
}

const claudeNames = readdirSync(CLAUDE_DIR)
  .filter((f) => f.endsWith('.md'))
  .map((f) => path.basename(f, '.md'));
const codexNames = readdirSync(CODEX_DIR)
  .filter((f) => f.endsWith('.toml'))
  .map((f) => path.basename(f, '.toml'));

const problems = [];

// 1. Roster parity
const onlyClaude = claudeNames.filter((n) => !codexNames.includes(n));
const onlyCodex = codexNames.filter((n) => !claudeNames.includes(n));
for (const n of onlyClaude) problems.push(`missing Codex twin: ${CODEX_DIR}/${n}.toml (exists in ${CLAUDE_DIR})`);
for (const n of onlyCodex) problems.push(`missing Claude twin: ${CLAUDE_DIR}/${n}.md (exists in ${CODEX_DIR})`);

// 2. Description parity for agents present in both
for (const name of claudeNames.filter((n) => codexNames.includes(n))) {
  const cd = claudeDescription(readFileSync(path.join(CLAUDE_DIR, `${name}.md`), 'utf8'));
  const xd = codexDescription(readFileSync(path.join(CODEX_DIR, `${name}.toml`), 'utf8'));
  if (!cd) problems.push(`${name}: cannot parse description in ${CLAUDE_DIR}/${name}.md`);
  else if (!xd) problems.push(`${name}: cannot parse description in ${CODEX_DIR}/${name}.toml`);
  else if (norm(cd) !== norm(xd)) {
    problems.push(
      `${name}: description drift\n    claude: ${cd}\n    codex:  ${xd}`
    );
  }
}

// Every active manifest provider claim must have a materialized adapter.
const manifestAgents = JSON.parse(readFileSync('agent-system/agents.json', 'utf8')).agents;
for (const agent of manifestAgents.filter(isGeneratedSubagent)) {
  for (const provider of agent.providers) {
    const pathFor = PROVIDER_PATH[provider];
    if (!pathFor) problems.push(`${agent.id}: unknown provider claim ${provider}`);
    else if (!existsSync(pathFor(agent.id))) problems.push(`${agent.id}: claims ${provider} support but ${pathFor(agent.id)} is missing`);
  }
}

if (problems.length) {
  console.error('check-agent-parity — Claude/Codex subagent drift:\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error(
    `\nKeep the roster and one-line descriptions in lockstep across ${CLAUDE_DIR} and ${CODEX_DIR}.` +
      `\n(Prose bodies may differ by format; only the agent set + scope descriptions are gated.)`
  );
  process.exit(1);
}

console.log(
    `check-agent-parity OK — ${claudeNames.length} agents: names + one-line descriptions match across Claude + Codex.` +
    `
  Every active manifest provider claim has an adapter file. Structural only: tools, skills, model tiers, provider loading and runtime adherence are not proven.`
);
