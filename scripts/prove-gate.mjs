#!/usr/bin/env node
/**
 * Re-prove that a closed lesson's gate still bites.
 *
 *   node scripts/prove-gate.mjs             every lesson carrying a `proof:` spec
 *   node scripts/prove-gate.mjs L-053       one lesson
 *   node scripts/prove-gate.mjs --list      what is provable, and what is not yet
 *   node scripts/prove-gate.mjs --self-test prove the parser and the verdict logic, offline
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY (2026-09-03)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `vault/_Lessons.md` says a lesson stays OPEN until it has a gate AND the gate has been
 * proven to bite. The proving is done by hand: break the fix, watch the test go red, put
 * it back. That ritual is the most valuable thing in the ledger and the least durable —
 * it happens once, at authoring time, and nothing re-checks it. A gate can rot silently:
 * the assertion gets loosened during an unrelated refactor, a mock starts returning the
 * expected value for the wrong reason, a file is renamed and the test now covers nothing.
 * Every one of those leaves the suite green.
 *
 * This is mutation testing, scoped to the exact invariant each lesson closed. It does not
 * generate tests and it does not read diffs — it re-runs the ritual.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A TARGETED MUTATION AND NOT "REVERT THE FIXING COMMIT"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reverting the real defect was the first design, and it is too coarse in the common case.
 * A fix and its planted test usually land in the SAME commit, so reverting the commit's
 * source deletes the module the test imports. The test then fails — for the wrong reason.
 * A proof that cannot distinguish "the guard is gone" from "the file is gone" proves
 * nothing, and would report a rotted gate as healthy.
 *
 * So the spec names the smallest edit that removes the invariant, which is exactly what
 * the hand ritual does. It is required to match EXACTLY ONCE: an ambiguous mutation is
 * refused rather than applied to an arbitrary occurrence.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SPEC FORMAT, in the lesson body
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   - **proof:** `<file>` :: `<find>` -> `<replace>` :: `<test path>`
 *
 * `<replace>` may be empty (two backticks) to delete the matched text.
 *
 * SAFETY. Refuses to run on a dirty working tree, so a restore is never ambiguous, and
 * restores from the in-memory original in a `finally` rather than from git — an
 * interrupted run must not be able to leave a mutated file behind.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LEDGER = 'vault/_Lessons.md';

/**
 * Parse `proof:` specs out of the ledger.
 *
 * Kept a pure string function so the format is testable without a ledger on disk — the
 * parser is the part most likely to drift as the ledger's prose style changes.
 */
export function parseProofs(markdown) {
    const proofs = [];
    let current = null;
    for (const line of markdown.split('\n')) {
        const heading = line.match(/^##\s+(L-\d+)\s+—\s+(.*)$/);
        if (heading) current = { id: heading[1], title: heading[2].trim() };
        if (!current) continue;
        const spec = line.match(/^-\s+\*\*proof:\*\*\s+`([^`]+)`\s*::\s*`([^`]*)`\s*->\s*`([^`]*)`\s*::\s*`([^`]+)`\s*$/);
        if (spec) {
            proofs.push({
                id: current.id, title: current.title,
                file: spec[1], find: spec[2], replace: spec[3], test: spec[4],
            });
        }
    }
    return proofs;
}

/** Lessons that declare a gate but no way to re-prove it. Reported, never failed on. */
export function unprovableLessons(markdown) {
    const out = [];
    let current = null;
    let sawGate = false;
    let sawProof = false;
    const flush = () => {
        if (current && sawGate && !sawProof) out.push(current);
    };
    for (const line of markdown.split('\n')) {
        const heading = line.match(/^##\s+(L-\d+)\s+—\s+(.*)$/);
        if (heading) {
            flush();
            current = heading[1];
            sawGate = false;
            sawProof = false;
        }
        if (/^-\s+\*\*gate:\*\*/.test(line)) sawGate = true;
        if (/^-\s+\*\*proof:\*\*/.test(line)) sawProof = true;
    }
    flush();
    return out;
}

/** @returns {string|null} why this spec cannot be applied, or null when it can */
export function mutationProblem(source, find) {
    if (!find) return 'empty find string — a mutation that matches everything proves nothing';
    const occurrences = source.split(find).length - 1;
    if (occurrences === 0) return `find string is not present — the gate’s subject moved or was renamed, so this proof is stale`;
    if (occurrences > 1) return `find string matches ${occurrences} times — refusing to mutate an arbitrary one; make the spec unique`;
    return null;
}

/**
 * A test command that must FAIL once the invariant is removed.
 *
 * Runs vitest's entry module with the current node binary rather than shelling out to
 * `npx`. `shell: true` was the first version and Node deprecates it with args (DEP0190):
 * the arguments are concatenated, not escaped, and one of them is a path read out of a
 * markdown file. No shell means no quoting question.
 */
function runTest(testPath) {
    const vitest = path.join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs');
    const result = spawnSync(process.execPath, [vitest, 'run', testPath, '--reporter=dot'], {
        encoding: 'utf8', timeout: 300_000,
    });
    return result.status;
}

function proveOne(proof) {
    const original = readFileSync(proof.file, 'utf8');
    const problem = mutationProblem(original, proof.find);
    if (problem) return { ...proof, verdict: 'UNPROVABLE', detail: problem };

    try {
        writeFileSync(proof.file, original.replace(proof.find, proof.replace));
        const status = runTest(proof.test);
        return status === 0
            // The whole point. Green here means the invariant was removed and the test
            // that supposedly guards it did not notice.
            ? { ...proof, verdict: 'ROTTED', detail: `${proof.test} still passes with the invariant removed` }
            : { ...proof, verdict: 'BITES', detail: `${proof.test} failed as it must` };
    } finally {
        // From memory, not from git: an interrupted run must not leave a mutated file.
        writeFileSync(proof.file, original);
    }
}

function selfTest() {
    const ledger = [
        '## L-001 — a lesson with a proof',
        '- **gate:** `npm run check:thing`',
        '- **proof:** `lib/a.ts` :: `if (!ok) return;` -> `` :: `lib/__tests__/a.test.ts`',
        '',
        '## L-002 — a lesson with a gate and no proof',
        '- **gate:** `npm run check:other`',
        '',
        '## L-003 — a lesson with neither',
        '- **defect:** something',
    ].join('\n');

    const proofs = parseProofs(ledger);
    const unprovable = unprovableLessons(ledger);
    const src = 'const x = 1;\nif (!ok) return;\nconst y = 2;\n';

    const cases = [
        ['parses one proof spec', proofs.length === 1],
        ['binds it to its lesson', proofs[0].id === 'L-001'],
        ['reads the file, find, replace and test', proofs[0].file === 'lib/a.ts' && proofs[0].find === 'if (!ok) return;' && proofs[0].replace === '' && proofs[0].test === 'lib/__tests__/a.test.ts'],
        ['reports a gate that has no proof', unprovable.length === 1 && unprovable[0] === 'L-002'],
        ['does NOT report a lesson with no gate at all', !unprovable.includes('L-003')],
        ['a unique find string is applicable', mutationProblem(src, 'if (!ok) return;') === null],
        ['an absent find string is a STALE proof, not a passing one', /stale/.test(mutationProblem(src, 'if (!nope) return;') ?? '')],
        ['an ambiguous find string is refused', /matches 3 times/.test(mutationProblem('a\na\na\n', 'a') ?? '')],
        ['an empty find string is refused', /empty find/.test(mutationProblem(src, '') ?? '')],
        // Meta: the parser must not accept a malformed spec as an empty success.
        ['a malformed spec yields no proof rather than a broken one', parseProofs('## L-004 — x\n- **proof:** nonsense\n').length === 0],
        ['a proof outside any lesson heading is ignored', parseProofs('- **proof:** `a` :: `b` -> `c` :: `d`\n').length === 0],
    ];

    let failed = 0;
    for (const [name, pass] of cases) {
        console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}`);
        if (!pass) failed++;
    }
    if (failed) {
        console.error(`\nprove-gate --self-test — ${failed} case(s) failed.`);
        process.exit(1);
    }
    console.log(`\nprove-gate --self-test OK — ${cases.length} cases.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    if (process.argv.includes('--self-test')) {
        selfTest();
        process.exit(0);
    }

    const markdown = readFileSync(LEDGER, 'utf8');
    const proofs = parseProofs(markdown);

    if (process.argv.includes('--list')) {
        console.log(`\n${proofs.length} lesson(s) can be re-proven:\n`);
        for (const p of proofs) console.log(`  ${p.id}  ${p.file} → ${p.test}`);
        const gaps = unprovableLessons(markdown);
        console.log(`\n${gaps.length} lesson(s) declare a gate with no \`proof:\` spec — they were proven once, by hand, and cannot be re-checked:\n`);
        console.log(`  ${gaps.join(', ') || '(none)'}`);
        console.log('\nThis is a backlog, not a failure. A proof spec is added when a lesson is written.\n');
        process.exit(0);
    }

    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
    if (dirty) {
        console.error('prove-gate refuses to run on a dirty working tree — it mutates source files in place,\nand a restore has to be unambiguous. Commit or stash first.');
        process.exit(2);
    }

    const wanted = process.argv.slice(2).find((a) => /^L-\d+$/.test(a));
    const selected = wanted ? proofs.filter((p) => p.id === wanted) : proofs;
    if (!selected.length) {
        console.error(`prove-gate: no proof spec for ${wanted ?? 'any lesson'} — see --list`);
        process.exit(1);
    }

    console.log(`\nprove-gate — re-running the "watch it fail" ritual for ${selected.length} lesson(s)\n`);
    const results = selected.map((p) => {
        const r = proveOne(p);
        console.log(`  ${r.verdict.padEnd(10)} ${r.id}  ${r.detail}`);
        return r;
    });

    const broken = results.filter((r) => r.verdict !== 'BITES');
    if (broken.length) {
        console.error(`\n${broken.length} gate(s) did not bite. A ROTTED gate is worse than none: it is buying confidence`);
        console.error('it has stopped earning. An UNPROVABLE one means the spec no longer matches the code.\n');
        process.exit(1);
    }
    console.log(`\nprove-gate OK — ${results.length} gate(s) still bite.\n`);
}
