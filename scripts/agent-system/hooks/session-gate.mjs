#!/usr/bin/env node
/**
 * Doc 34 W3: the outcome gate the Stop hook runs before letting an agent finish.
 *
 *   node scripts/agent-system/hooks/session-gate.mjs <path>...   (cwd = repo root)
 *
 * Takes the paths THIS session wrote (the write guard's ledger), not `git status`: in a
 * shared checkout the diff also holds another agent's uncommitted files. First the mechanical
 * checks (doc 36 S3), because they are cheap and 24 % of `gate:quick` failures were theirs:
 * - line caps on the written `app|components|lib` `.ts(x)` files, in process, against the
 *   committed baseline (`check-line-caps.mjs`);
 * - `check:tokens` when a CSS Module or `app/globals.css` was written;
 * - `check:css-modules` (missing and new dead classes) when a CSS Module or an `app|components`
 *   `.tsx` was written.
 * Both token and CSS checks scan the whole tree: they are ratchets, so only new debt fails.
 * Then the doc generators whose inputs were written (doc 36 S4, `scripts/lib/docs-steps.mjs`):
 * each is checked, and on drift regenerated and checked again, so its output joins the same
 * commit. A regeneration is reported in `regenerated`, and the Stop hook blocks once so the
 * agent commits it. Decision-bearing checks (vault, doc drift, dead refs) are never auto-fixed.
 * Then the tests related to those paths (the same selection `test:task` uses) and, when a
 * TypeScript file is among them, `tsc --noEmit`. Prints one JSON line on stdout:
 *
 *   { ok, ran: string[], failures: [{ step, tail }], deferred: string[], regenerated: string[] }
 *
 * A step that times out is DEFERRED, not failed and not silent: the Stop hook prints it, and
 * the pre-push `gate:quick` still runs it. Doc 34 §9 measured `tsc` at 70 s cold and 32 s
 * warm, so 120 s covers both with room.
 *
 * Node is spawned directly (no shell, no npx) so a timeout kills the real process instead
 * of a `cmd.exe` wrapper that would leave vitest or tsc running.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { docsStep, dueGenerators, isPairStep } from '../../lib/docs-steps.mjs';
import { BASELINE_FILE, countLines, evaluateLineCaps, isTestOrDefinitionFile, loadBaseline, toPosix } from '../../check-line-caps.mjs';
import { selectTests } from '../../related-tests.mjs';

export const STEP_TIMEOUT_MS = 120_000;
/** All steps together stay under core.mjs STOP_GATE_TIMEOUT_MS (270 s). */
export const TOTAL_BUDGET_MS = 240_000;
/** More related test files than this is a whole-suite change; gate:quick runs it, not Stop. */
export const MAX_STOP_TESTS = 40;
const TS_FILE = /\.(ts|tsx|mts|cts)$/;
const VITEST = 'node_modules/vitest/vitest.mjs';
const TSC = 'node_modules/typescript/bin/tsc';

const CAPPED = /^(app|components|lib)\/.+\.tsx?$/;
const MODULE_CSS = /\.module\.css$/;
const STYLED_TSX = /^(app|components)\/.+\.tsx$/;

/**
 * Line-cap violations among the written files: a new file over the cap, or a baselined file
 * that grew past its allowance. The same rule `check:line-caps` applies to the whole tree.
 * @param {string[]} paths
 * @param {(p: string) => string} read
 * @param {Record<string, number>} baseline
 */
export function lineCapViolations(paths, read, baseline) {
    const scanned = paths.map(toPosix)
        .filter((p) => CAPPED.test(p) && !isTestOrDefinitionFile(p))
        .map((file) => ({ file, lines: countLines(read(file)) }));
    return evaluateLineCaps(scanned, baseline).violations;
}

const tail = (s, n = 30) => String(s ?? '').trim().split('\n').slice(-n).join('\n');

/**
 * @param {string[]} paths repo-relative paths written this session
 * @param {{ spawn?: typeof spawnSync, select?: typeof selectTests, exists?: (p: string) => boolean, read?: (p: string) => string, now?: () => number, baseline?: () => Record<string, number>, generators?: (paths: string[]) => string[] }} [deps]
 */
export function runSessionGate(paths, deps = {}) {
    const {
        spawn = spawnSync, select = selectTests, exists = existsSync, read = (p) => readFileSync(p, 'utf8'), now = Date.now,
        baseline = () => loadBaseline(BASELINE_FILE), generators = dueGenerators,
    } = deps;
    /** @type {{ ok: boolean, ran: string[], failures: { step: string, tail: string }[], deferred: string[], regenerated: string[] }} */
    const result = { ok: true, ran: [], failures: [], deferred: [], regenerated: [] };
    const present = [...new Set(paths)].filter((p) => exists(p));
    if (!present.length) return result;

    const deadline = now() + TOTAL_BUDGET_MS;
    /** Spawn within the time budget; null (and a `deferred` entry) when it could not finish. */
    const exec = (name, args) => {
        const timeout = Math.min(STEP_TIMEOUT_MS, deadline - now());
        if (timeout < 5000) {
            result.deferred.push(`${name} deferred to gate:quick (Stop time budget used)`);
            return null;
        }
        const res = spawn(process.execPath, args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
        if (res.error?.code === 'ETIMEDOUT' || res.signal) {
            result.deferred.push(`${name} deferred to gate:quick (timed out after ${Math.round(timeout / 1000)} s)`);
            return null;
        }
        result.ran.push(name);
        return res;
    };
    const fail = (name, res) => {
        result.ok = false;
        result.failures.push({ step: name, tail: tail(`${res.stdout ?? ''}\n${res.stderr ?? ''}`) });
    };
    const step = (name, args) => {
        const res = exec(name, args);
        if (res && res.status !== 0) fail(name, res);
    };

    /**
     * Check generators; on drift run `writeOrder`, then re-check what drifted. A generator that
     * still fails (an unclassified path, say) is a failure, not a regeneration.
     * @param {string[]} ids
     * @param {string[]} writeOrder
     * @returns {boolean} whether anything was written
     */
    const regenerate = (ids, writeOrder) => {
        const check = (s) => exec(`docs:check › ${s.id}`, [s.script, ...s.check]);
        const drifted = ids.map(docsStep).filter((s) => {
            const res = check(s);
            return res !== null && res.status !== 0;
        });
        if (!drifted.length) return false;
        for (const id of writeOrder) {
            const s = docsStep(id);
            const res = exec(`docs:write › ${id}`, [s.script, ...(s.write ?? [])]);
            if (!res) return false;
            if (res.status !== 0) {
                fail(`docs:write › ${id}`, res);
                return false;
            }
        }
        for (const s of drifted) {
            const res = check(s);
            if (res && res.status !== 0) fail(`docs:check › ${s.id}`, res);
            else if (res) result.regenerated.push(`${s.id} (${s.outputs})`);
        }
        return true;
    };

    const posix = present.map(toPosix);
    const cappedWritten = posix.some((p) => CAPPED.test(p));
    const capped = cappedWritten ? lineCapViolations(posix, read, baseline()) : [];
    if (cappedWritten) result.ran.push('line caps');
    if (capped.length) {
        result.ok = false;
        result.failures.push({
            step: 'line caps',
            tail: capped.map((v) => `${v.file}: ${v.lines} lines, ${v.reason === 'new-file' ? 'cap' : 'baseline allows'} ${v.allowed}`).join('\n')
                + '\nSplit the file (AGENTS.md §4 rule 1); never raise the baseline.',
        });
    }
    if (posix.some((p) => MODULE_CSS.test(p) || p === 'app/globals.css')) step('check:tokens', ['scripts/check-tokens.mjs']);
    if (posix.some((p) => MODULE_CSS.test(p) || STYLED_TSX.test(p))) {
        step('check:css-modules', ['scripts/check-css-modules.mjs']);
        step('check:css-modules --unused', ['scripts/check-css-modules.mjs', '--unused']);
    }

    // The mirrors go first and the index/governance pair last, as in `npm run docs:write`.
    const due = generators(posix);
    let wrote = false;
    for (const id of due.filter((d) => !isPairStep(d))) wrote = regenerate([id], [id]) || wrote;
    if (wrote || due.some(isPairStep)) {
        regenerate(['doc-index', 'doc-governance'], ['doc-index', 'doc-governance', 'doc-index', 'doc-governance']);
    }

    const { tests } = select(present, { wholeSuiteAllowed: false });
    if (tests.length > MAX_STOP_TESTS) {
        result.deferred.push(`tests deferred to gate:quick (${tests.length} related test files)`);
    } else if (tests.length) {
        // A test that calls process.chdir() cannot run in worker threads (related-tests.mjs).
        const chdir = tests.filter((t) => read(t).includes('process.chdir('));
        const threads = tests.filter((t) => !chdir.includes(t));
        if (threads.length) step(`vitest (${threads.length} file(s))`, [VITEST, 'run', '--pool=threads', ...threads]);
        if (chdir.length) step(`vitest (${chdir.length} chdir file(s))`, [VITEST, 'run', ...chdir]);
    }
    if (present.some((p) => TS_FILE.test(p))) step('tsc --noEmit', [TSC, '--noEmit']);
    return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    console.log(JSON.stringify(runSessionGate(process.argv.slice(2))));
}
