#!/usr/bin/env node
/**
 * check:line-caps — Component and module size ceiling ratchet.
 * Enforces AGENTS.md §4 rule 1: "Components target <= 400 lines; decompose into
 * subcomponents/hooks when handling multiple concerns."
 *
 * Runs in local gate (`npm run gate`), gate:full, and CI.
 *
 * Usage:
 *   node scripts/check-line-caps.mjs              Scan tracked files; exit 1 on blocking violations
 *   node scripts/check-line-caps.mjs --self-test  Prove planted violations fail and ratchet bites
 *   node scripts/check-line-caps.mjs --update     Shrink baseline when debt is paid down (refuses to grow)
 *   node scripts/check-line-caps.mjs --list       List all tracked files exceeding the ceiling
 *
 * Ceiling: 400 physical lines per file.
 * Scope: non-test .ts/.tsx files under app/, components/, lib/ that git tracks or
 *        would add (untracked, not ignored), so a new file is caught before its commit.
 * Ratchet: Baseline (scripts/line-caps.baseline.json) may only SHRINK, never GROW.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const LINE_CAP = 400;
export const SCAN_DIRS = ['app', 'components', 'lib'];
export const BASELINE_FILE = 'scripts/line-caps.baseline.json';

/** Normalise path to forward slashes. */
export function toPosix(p) {
    return p.replaceAll('\\', '/');
}

/** Check if a file is a test, mock, fixture or declaration file. */
export function isTestOrDefinitionFile(filePath) {
    const posix = toPosix(filePath);
    return (
        posix.includes('/__tests__/') ||
        posix.includes('/__mocks__/') ||
        posix.endsWith('.test.ts') ||
        posix.endsWith('.test.tsx') ||
        posix.endsWith('.spec.ts') ||
        posix.endsWith('.spec.tsx') ||
        posix.endsWith('.d.ts')
    );
}

/**
 * Count physical lines the way an editor and `wc -l` do, across CRLF and LF.
 * A final newline ends the last line rather than starting a new one, so a
 * 400-line file with a trailing newline counts as 400, not 401.
 */
export function countLines(content) {
    if (!content) return 0;
    return content.replace(/\r?\n$/, '').split(/\r?\n/).length;
}

/**
 * Scan target directories for candidate files.
 * Uses `git ls-files` when in a git repository; falls back to directory walk.
 */
export function scanFiles({ root = process.cwd(), dirs = SCAN_DIRS } = {}) {
    let files = [];
    try {
        const stdout = execFileSync(
            'git',
            ['ls-files', '--cached', '--others', '--exclude-standard', ...dirs],
            { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        );
        // A tracked file deleted in the work tree but not staged is still listed by
        // `--cached`. It is gone, so it counts as removed, not as an ENOENT crash.
        files = stdout
            .trim()
            .split(/\r?\n/)
            .filter(Boolean)
            .map(toPosix)
            .filter((f) => existsSync(path.join(root, f)));
    } catch {
        // Fallback for non-git environments or unit tests
        function walk(dir, out = []) {
            let entries;
            try {
                entries = readdirSync(dir, { withFileTypes: true });
            } catch {
                return out;
            }
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.git') continue;
                    walk(full, out);
                } else if (/\.tsx?$/.test(entry.name)) {
                    out.push(toPosix(path.relative(root, full)));
                }
            }
            return out;
        }
        for (const dir of dirs) {
            walk(path.join(root, dir), files);
        }
    }

    return files
        .filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !isTestOrDefinitionFile(f))
        .sort();
}

/** Read and parse the committed baseline file. */
export function loadBaseline(baselinePath) {
    if (!existsSync(baselinePath)) {
        return {};
    }
    const raw = readFileSync(baselinePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.baseline ?? {};
}

/**
 * Evaluate scanned files against the baseline and ceiling.
 *
 * @param {Array<{ file: string, lines: number }>} scanned
 * @param {Record<string, number>} baseline
 * @param {number} cap
 * @returns {{
 *   violations: Array<{ file: string, lines: number, allowed: number, reason: 'new-file' | 'grew' }>,
 *   paidDown: Array<{ file: string, oldCap: number, newLines: number, completelyResolved: boolean }>,
 *   totalOverCap: number
 * }}
 */
export function evaluateLineCaps(scanned, baseline = {}, cap = LINE_CAP) {
    const violations = [];
    const paidDown = [];
    let totalOverCap = 0;

    const fileMap = new Map(scanned.map((s) => [s.file, s.lines]));

    // Check each scanned file
    for (const { file, lines } of scanned) {
        if (lines > cap) {
            totalOverCap += 1;
            const allowed = baseline[file];
            if (allowed === undefined) {
                violations.push({
                    file,
                    lines,
                    allowed: cap,
                    reason: 'new-file',
                });
            } else if (lines > allowed) {
                violations.push({
                    file,
                    lines,
                    allowed,
                    reason: 'grew',
                });
            } else if (lines < allowed) {
                paidDown.push({
                    file,
                    oldCap: allowed,
                    newLines: lines,
                    completelyResolved: false,
                });
            }
        } else if (baseline[file] !== undefined) {
            // File was in baseline, but now <= cap!
            paidDown.push({
                file,
                oldCap: baseline[file],
                newLines: lines,
                completelyResolved: true,
            });
        }
    }

    // Check for baselined files that were deleted or moved
    for (const [file, oldCap] of Object.entries(baseline)) {
        if (!fileMap.has(file)) {
            paidDown.push({
                file,
                oldCap,
                newLines: 0,
                completelyResolved: true,
            });
        }
    }

    return { violations, paidDown, totalOverCap };
}

/**
 * Update baseline by shrinking existing entries or removing paid-down ones.
 * Throws or returns an error if any file grew or if any new file exceeded the cap.
 */
export function updateBaseline(scanned, baseline = {}, cap = LINE_CAP) {
    const { violations, paidDown } = evaluateLineCaps(scanned, baseline, cap);

    if (violations.length > 0) {
        const error = new Error(
            `Baseline update refused — ${violations.length} file(s) would grow or be admitted.\n` +
            violations
                .map((v) =>
                    v.reason === 'new-file'
                        ? `  ${v.file}: ${v.lines} lines (new file exceeds cap ${cap})`
                        : `  ${v.file}: ${v.lines} lines (grew from baseline ${v.allowed})`,
                )
                .join('\n') +
            '\nThe baseline may only SHRINK, never GROW.',
        );
        error.violations = violations;
        throw error;
    }

    const nextBaseline = { ...baseline };
    for (const p of paidDown) {
        if (p.completelyResolved) {
            delete nextBaseline[p.file];
        } else {
            nextBaseline[p.file] = p.newLines;
        }
    }

    // Return sorted keys
    return Object.fromEntries(
        Object.keys(nextBaseline)
            .sort()
            .map((k) => [k, nextBaseline[k]]),
    );
}

/** Self-test asserting all ratchet invariants bite. */
export function runSelfTest() {
    const baseline = {
        'components/old-big.tsx': 450,
        'lib/services/shrinking.ts': 420,
        'app/api/vanished.ts': 410,
    };

    // Case 1: A new file > 400 lines fails
    const case1 = evaluateLineCaps(
        [
            { file: 'components/new-huge.tsx', lines: 405 },
            { file: 'components/old-big.tsx', lines: 450 },
        ],
        baseline,
        400,
    );
    if (!case1.violations.some((v) => v.file === 'components/new-huge.tsx' && v.reason === 'new-file')) {
        throw new Error('Self-test FAILED: new file over cap did not trigger a violation');
    }

    // Case 2: A baselined file growing fails
    const case2 = evaluateLineCaps(
        [
            { file: 'components/old-big.tsx', lines: 455 },
        ],
        baseline,
        400,
    );
    if (!case2.violations.some((v) => v.file === 'components/old-big.tsx' && v.reason === 'grew')) {
        throw new Error('Self-test FAILED: growing baselined file did not trigger a violation');
    }

    // Case 3: A baselined file shrinking passes and records paidDown
    const case3 = evaluateLineCaps(
        [
            { file: 'components/old-big.tsx', lines: 440 },
        ],
        baseline,
        400,
    );
    if (case3.violations.length !== 0 || !case3.paidDown.some((p) => p.file === 'components/old-big.tsx' && p.newLines === 440)) {
        throw new Error('Self-test FAILED: shrinking baselined file was not recorded in paidDown');
    }

    // Case 4: A baselined file dropping <= 400 is marked completelyResolved
    const case4 = evaluateLineCaps(
        [
            { file: 'lib/services/shrinking.ts', lines: 395 },
        ],
        baseline,
        400,
    );
    if (!case4.paidDown.some((p) => p.file === 'lib/services/shrinking.ts' && p.completelyResolved)) {
        throw new Error('Self-test FAILED: file dropping <= cap was not marked completelyResolved');
    }

    // Case 5: updateBaseline refuses growth
    let caught = false;
    try {
        updateBaseline(
            [{ file: 'components/old-big.tsx', lines: 460 }],
            baseline,
            400,
        );
    } catch {
        caught = true;
    }
    if (!caught) {
        throw new Error('Self-test FAILED: updateBaseline allowed baseline growth');
    }

    // Case 6: updateBaseline shrinks and removes entries
    const nextBase = updateBaseline(
        [
            { file: 'components/old-big.tsx', lines: 430 },
            { file: 'lib/services/shrinking.ts', lines: 380 },
        ],
        baseline,
        400,
    );
    if (nextBase['components/old-big.tsx'] !== 430) {
        throw new Error(`Self-test FAILED: expected 430, got ${nextBase['components/old-big.tsx']}`);
    }
    if ('lib/services/shrinking.ts' in nextBase) {
        throw new Error('Self-test FAILED: fully resolved entry was not purged from baseline');
    }
    if ('app/api/vanished.ts' in nextBase) {
        throw new Error('Self-test FAILED: deleted file was not purged from baseline');
    }

    console.log('check:line-caps --self-test OK — 6 invariants proven.');
}

/** CLI Entry Point */
function main() {
    const args = process.argv.slice(2);
    const root = process.cwd();
    const baselinePath = path.join(root, BASELINE_FILE);

    if (args.includes('--self-test')) {
        runSelfTest();
        if (args.length === 1) process.exit(0);
    }

    const files = scanFiles({ root });
    const scanned = files.map((f) => ({
        file: f,
        lines: countLines(readFileSync(path.join(root, f), 'utf8')),
    }));

    if (args.includes('--list')) {
        const over = scanned.filter((s) => s.lines > LINE_CAP).sort((a, b) => b.lines - a.lines);
        console.log(`\nFiles exceeding ${LINE_CAP} lines (${over.length} total):\n`);
        for (const item of over) {
            console.log(`  ${String(item.lines).padStart(5, ' ')} lines  ${item.file}`);
        }
        process.exit(0);
    }

    const baseline = loadBaseline(baselinePath);

    if (args.includes('--update')) {
        try {
            const nextBaseline = updateBaseline(scanned, baseline, LINE_CAP);
            const content = {
                $schema: 'line-caps-baseline-v1',
                $comment: 'Tracked files currently exceeding the 400-line ceiling (AGENTS.md §4 rule 1). May only SHRINK — new files or growth block. Decompose files to lower debt. Re-freeze after paying down: node scripts/check-line-caps.mjs --update',
                baseline: nextBaseline,
            };
            writeFileSync(baselinePath, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
            console.log(`check:line-caps — baseline updated (${Object.keys(nextBaseline).length} entries retained).`);
            process.exit(0);
        } catch (err) {
            console.error(err.message);
            process.exit(1);
        }
    }

    const { violations, paidDown, totalOverCap } = evaluateLineCaps(scanned, baseline, LINE_CAP);

    if (violations.length > 0) {
        console.error(`\ncheck:line-caps — ${violations.length} oversized file violation(s) [BLOCK]:\n`);
        for (const v of violations) {
            if (v.reason === 'new-file') {
                console.error(
                    `  ${v.file}:${v.lines}  ${v.lines} lines (ceiling: ${LINE_CAP}) — new oversized file (AGENTS.md §4 rule 1)`,
                );
            } else {
                console.error(
                    `  ${v.file}:${v.lines}  ${v.lines} lines (baseline allows ${v.allowed}) — baselined file grew (+${v.lines - v.allowed} lines)`,
                );
            }
        }
        console.error(
            '\nComponents and modules must target <= 400 lines (AGENTS.md §4 rule 1).' +
            '\nDecompose large files into focused subcomponents, helpers, or custom hooks.',
        );
        process.exit(1);
    }

    if (paidDown.length > 0) {
        const completely = paidDown.filter((p) => p.completelyResolved).length;
        const partially = paidDown.filter((p) => !p.completelyResolved).length;
        console.log(
            `\n[ratchet] ${paidDown.length} baseline entry/entries shrunk (${completely} fully resolved <= ${LINE_CAP}, ${partially} reduced) — shrink baseline with: node scripts/check-line-caps.mjs --update`,
        );
    }

    const baseCount = Object.keys(baseline).length;
    console.log(
        `check:line-caps OK — ${scanned.length} tracked files checked, 0 violations (${totalOverCap} files across ${baseCount} frozen baseline entries).`,
    );
    process.exit(0);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    main();
}
