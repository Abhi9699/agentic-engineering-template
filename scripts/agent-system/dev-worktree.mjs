/**
 * Worktree dev server runner with safe port allocation and memory-only secret loading.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Runs `next dev` inside an isolated git worktree (.worktrees/<task-id>) without:
 * 1. Leaking or copying secrets: loads parent repository's `.env.local` directly
 *    into process memory via `process.loadEnvFile()` — zero secrets copied or linked
 *    to disk (AGENTS.md §4 rule 7).
 * 2. Port collisions: probes and allocates a free port in 3100–3900, keeping
 *    port 3000 free for the primary checkout.
 * 3. Bundler: passes `--webpack` by default (see the Turbopack note below);
 *    `--turbopack` opts back in.
 *
 * Usage:
 *   npm run dev:worktree
 *   node scripts/agent-system/dev-worktree.mjs [--port 3200] [--turbopack]
 *   node scripts/agent-system/dev-worktree.mjs --self-test
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findFreePort } from './spawn-worktree.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '../..');

/**
 * Returns true only when executing inside a managed worktree (.worktrees/<task-id>).
 * Guards the primary checkout against accidental execution.
 */
export function isInsideWorktree(cwd = process.cwd()) {
    const normalized = path.resolve(cwd);
    return /[\\/]\.worktrees[\\/][^\\/]+$/.test(normalized);
}

/**
 * Resolves the primary git repository root via `git rev-parse --git-common-dir`.
 * In a worktree, git-common-dir points to `<main-root>/.git`.
 */
export function resolveParentRepo(cwd = process.cwd()) {
    try {
        const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        return path.resolve(cwd, commonDir, '..');
    } catch {
        return ROOT;
    }
}

/**
 * Loads the parent checkout's `.env.local` (the DEV env) into process.env, in memory.
 * Never writes, links or prints it.
 *
 * Deliberately NOT `.env`: in this repo `.env` holds PRODUCTION values, and
 * `process.loadEnvFile` never overrides a variable that is already set, so loading
 * `.env` first would make production values win over dev ones.
 *
 * Returns 'loaded' | 'missing'. A parse error throws: a half-loaded env fails closed.
 */
export function loadWorktreeEnv(parentRepo) {
    const envLocal = parentRepo ? path.join(parentRepo, '.env.local') : '';
    if (!envLocal || !existsSync(envLocal)) return 'missing';
    process.loadEnvFile(envLocal);
    return 'loaded';
}

/**
 * Resolves Next's JS entry so it can be run with `process.execPath` — no shell, so
 * no DEP0190 warning on Node 24 and no argument quoting on Windows.
 */
export function findNextEntry(worktreeDir) {
    const entry = path.join(worktreeDir, 'node_modules', 'next', 'dist', 'bin', 'next');
    return existsSync(entry) ? entry : null;
}

/**
 * Splits launcher flags from the ones forwarded to `next dev`.
 * `--port <n>` must be an integer in 1024–65535. `--turbopack` opts out of the
 * `--webpack` default.
 */
export function parseArgs(args) {
    let port = null;
    let bundler = '--webpack';
    const forward = [];
    for (let i = 0; i < args.length; i += 1) {
        const a = args[i];
        if (a === '--port') {
            const n = Number(args[i + 1]);
            if (!Number.isInteger(n) || n < 1024 || n > 65535) {
                throw new Error(`--port needs an integer in 1024-65535, got "${args[i + 1] ?? ''}"`);
            }
            port = n;
            i += 1;
        } else if (a === '--turbopack') {
            bundler = '--turbopack';
        } else if (a !== '--self-test') {
            forward.push(a);
        }
    }
    return { port, bundler, forward };
}

/**
 * Main launcher logic.
 */
export async function runDevWorktree(args = process.argv.slice(2), cwd = process.cwd()) {
    if (!isInsideWorktree(cwd)) {
        console.error('dev:worktree FAILED — not inside a .worktrees/* directory.');
        console.error('In the main repository, use `npm run dev` on port 3000.');
        return 1;
    }

    let parsed;
    try {
        parsed = parseArgs(args);
    } catch (err) {
        console.error(`dev:worktree FAILED — ${err.message}`);
        return 1;
    }

    const nextEntry = findNextEntry(cwd);
    if (!nextEntry) {
        console.error('dev:worktree FAILED — node_modules/next not found. Was the worktree made by `npm run agent:worktree`?');
        return 1;
    }

    const env = loadWorktreeEnv(resolveParentRepo(cwd));
    const port = parsed.port ?? (await findFreePort());
    const nextArgs = [nextEntry, 'dev', parsed.bundler, '--port', String(port), ...parsed.forward];

    console.log(`[dev:worktree] next dev ${parsed.bundler} on http://localhost:${port}`);
    console.log(`  env: ${env === 'loaded' ? "parent .env.local (in memory)" : 'none — parent .env.local not found'}`);

    return new Promise((resolve) => {
        const child = spawn(process.execPath, nextArgs, { cwd, env: process.env, stdio: 'inherit' });
        const forward = (sig) => child.kill(sig);
        process.once('SIGINT', forward);
        process.once('SIGTERM', forward);
        child.on('exit', (code) => resolve(code ?? 0));
        child.on('error', (err) => {
            console.error(`[dev:worktree] Failed to spawn Next.js: ${err.message}`);
            resolve(1);
        });
    });
}

/* ── CLI & Self-Test ──────────────────────────────────────────────────────── */

async function selfTest() {
    const cases = [];
    const ok = (name, pass) => cases.push({ name, pass });

    ok('detects inside worktree path', isInsideWorktree('/repo/.worktrees/fix-1'));
    ok('detects inside worktree Windows path', isInsideWorktree('C:\\repo\\.worktrees\\task-xyz'));
    ok('rejects primary repository root', !isInsideWorktree('C:\\repos\\my-product'));
    ok('rejects nested non-worktree folder', !isInsideWorktree('C:\\repos\\my-product\\scripts\\agent-system'));
    ok('rejects path ending with .worktrees', !isInsideWorktree('C:\\repos\\my-product\\.worktrees'));

    const parent = resolveParentRepo(process.cwd());
    ok('resolves parent repository as string', typeof parent === 'string' && parent.length > 0);

    const port = await findFreePort(3800, 3900);
    ok('allocates port in valid range', typeof port === 'number' && port >= 3800 && port <= 3900);

    ok('defaults to webpack', parseArgs([]).bundler === '--webpack');
    ok('--turbopack opts out of webpack', parseArgs(['--turbopack']).bundler === '--turbopack');
    ok('--port is consumed, not forwarded', parseArgs(['--port', '3200', '-H', 'x']).forward.join() === '-H,x');
    let threw = false;
    try { parseArgs(['--port', 'abc']); } catch { threw = true; }
    ok('rejects a non-numeric --port', threw);

    for (const c of cases) console.log(`  ${c.pass ? 'ok  ' : 'FAIL'}  ${c.name}`);
    const failed = cases.filter((c) => !c.pass).length;
    if (failed > 0) {
        console.error(`\ndev-worktree --self-test FAILED — ${failed} case(s).`);
        process.exit(1);
    }
    console.log(`\ndev-worktree --self-test OK — ${cases.length} cases.`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
    if (process.argv.includes('--self-test')) {
        await selfTest();
    } else {
        const exitCode = await runDevWorktree();
        process.exit(exitCode);
    }
}
