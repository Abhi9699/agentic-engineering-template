#!/usr/bin/env node
/**
 * The reviewer eval: does the reviewer catch what it exists to catch, and stay quiet
 * when there is nothing to catch?
 *
 *   node scripts/agent-system/reviewer-eval.mjs --prompt            # the cases, for one reviewer run
 *   node scripts/agent-system/reviewer-eval.mjs --score <report.md>  # score that run
 *   node scripts/agent-system/reviewer-eval.mjs --score <report.md> --record
 *
 * A model run cannot happen in CI, so this splits the work: `--prompt` prints every case
 * for ONE reviewer invocation (cheap: one call, not seven), the reviewer answers each
 * under a `## <id>` heading, and `--score` grades the answers deterministically. A defect
 * case passes only with BLOCK plus a mention of the file and the cause; the control passes
 * only with PASS, because a reviewer that blocks everything scores perfectly on defects.
 *
 * `--record` stamps lastRun with the hash of the reviewer instructions it was run against.
 * scripts/__tests__/reviewer-eval.test.ts fails while that hash is stale, so editing the
 * reviewer's instructions without re-running this eval is a red build, not a convention.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FIXTURES = 'agent-system/fixtures/reviewer-eval.json';
export const INSTRUCTIONS = 'agent-system/instructions/reviewer/_shared.md';

/** Line endings normalised, so a Windows checkout and CI hash the same text. */
export function instructionsHash(root = ROOT) {
    const text = readFileSync(path.join(root, INSTRUCTIONS), 'utf8').replace(/\r\n/g, '\n');
    return createHash('sha256').update(text).digest('hex');
}

export function loadEval(root = ROOT) {
    return JSON.parse(readFileSync(path.join(root, FIXTURES), 'utf8'));
}

export function promptFor(evalSpec) {
    const out = [
        'Reviewer eval. Review each diff below on its own, as you would a real change. They are',
        'excerpts: assume the surrounding code is as this repository has it. For each case write',
        'a heading `## <id>`, then your verdict line (PASS or BLOCK), then your findings.',
        'Do not record a review receipt for this run.',
    ];
    for (const c of evalSpec.cases) out.push('', `## ${c.id}`, '```diff', c.diff.trimEnd(), '```');
    return out.join('\n');
}

/** The text under `## <id>`, up to the next `## `. */
function answerFor(report, id) {
    const at = report.search(new RegExp(`^##\\s+${id.replace(/[-]/g, '\\-')}\\s*$`, 'm'));
    if (at < 0) return null;
    const rest = report.slice(at).split('\n').slice(1).join('\n');
    const next = rest.search(/^##\s/m);
    return next < 0 ? rest : rest.slice(0, next);
}

/**
 * @param {{ cases: { id: string, control?: boolean, mustMention: string[] }[] }} evalSpec
 * @param {string} report
 */
export function scoreReport(evalSpec, report) {
    const results = evalSpec.cases.map((c) => {
        const answer = answerFor(report, c.id);
        if (answer === null) return { id: c.id, pass: false, why: 'no answer' };
        const verdict = /\bBLOCK\b/.test(answer) ? 'BLOCK' : /\bPASS\b/.test(answer) ? 'PASS' : null;
        if (c.control) return { id: c.id, pass: verdict === 'PASS', why: verdict === 'PASS' ? 'ok' : `false alarm (${verdict ?? 'no verdict'})` };
        if (verdict !== 'BLOCK') return { id: c.id, pass: false, why: `missed (${verdict ?? 'no verdict'})` };
        const missing = c.mustMention.filter((re) => !new RegExp(re, 'i').test(answer));
        return { id: c.id, pass: missing.length === 0, why: missing.length ? `BLOCK but did not name: ${missing.join(', ')}` : 'ok' };
    });
    return { results, passed: results.filter((r) => r.pass).length, total: results.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const argv = process.argv.slice(2);
    const spec = loadEval();
    if (argv[0] === '--prompt') {
        console.log(promptFor(spec));
    } else if (argv[0] === '--score' && argv[1]) {
        const { results, passed, total } = scoreReport(spec, readFileSync(argv[1], 'utf8'));
        for (const r of results) console.log(`  ${r.pass ? 'ok  ' : 'FAIL'}  ${r.id}  ${r.why}`);
        console.log(`\nreviewer eval: ${passed}/${total}`);
        if (passed !== total) process.exit(1);
        if (argv.includes('--record')) {
            spec.lastRun = { instructionsSha256: instructionsHash(), date: new Date().toISOString().slice(0, 10), score: `${passed}/${total}` };
            writeFileSync(path.join(ROOT, FIXTURES), `${JSON.stringify(spec, null, 2)}\n`);
            console.log(`recorded lastRun against instructions ${spec.lastRun.instructionsSha256.slice(0, 12)}`);
        }
    } else {
        console.error('usage: reviewer-eval.mjs --prompt | --score <report.md> [--record]');
        process.exit(2);
    }
}
