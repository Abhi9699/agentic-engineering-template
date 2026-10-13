/**
 * An isolated worktree for one task, with the dependencies shared rather than copied.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR, AND WHAT IT IS NOT FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It is for HYGIENE: a clean `git status`, and no half-finished edits from one task
 * visible to the next. On 2026-09-12 two sessions worked in this repository at the
 * same time and one of them had to stop and ask which set of uncommitted changes was
 * whose.
 *
 * It is NOT permission to run writers in parallel, and that distinction is the whole
 * reason this docblock exists. The same collision was not a git conflict: one session
 * was implementing "fix the false credit badge, keep the toolbar" while the owner had
 * decided "delete the toolbar entirely". Both were coherent. Isolated worktrees would
 * have produced exactly the same wasted work in a tidier directory, because **git
 * isolation isolates FILES, and the thing that conflicted was a DECISION.**
 *
 * `AGENTS.md` §4 rule 9 states the governing rule: one writer at a time. Read-only
 * advisors and auditors may run in parallel; concurrent writers may not.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE DEPENDENCIES ARE LINKED AND THE ENVIRONMENT IS NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `node_modules` here is ~1.2GB and `npm ci` takes minutes. A junction (Windows) or a
 * symlink (POSIX) costs milliseconds and zero bytes. Measured on this machine:
 * `mklink /J` succeeded with `IsAdmin: False`, and `next/package.json` resolved
 * through it — junctions, unlike symlinks, need no Windows developer mode.
 *
 * The environment file is deliberately NOT linked, and this is a correction to the
 * blueprint that proposed symlinking `.env.local` in. A link to the real secrets file
 * inside a directory in the repository is a secret-shaped object one `git add -A`
 * from being staged — and a plan whose safety depends on a guard catching that has
 * already lost the argument. A worktree needs the VALUES, not the file:
 * `npm run dev:worktree` (dev-worktree.mjs) loads the parent's `.env.local` into
 * process memory and starts `next dev --webpack`, because Turbopack refuses this
 * junction ("Symlink [project]/node_modules ... points out of the filesystem root",
 * reproduced 2026-09-28 on next@16.3.5). This script links nothing.
 *
 * Usage:
 *   node scripts/agent-system/spawn-worktree.mjs <task-id> [--branch fix/name]
 *   node scripts/agent-system/spawn-worktree.mjs --cleanup <task-id>
 *   node scripts/agent-system/spawn-worktree.mjs --self-test
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKTREE_DIR = '.worktrees';

/**
 * The port window QA runs in.
 *
 * Deliberately clear of 3000, where the founder's own dev server lives. A headless
 * run that grabs 3000 does not fail — it attaches to whatever is already there and
 * reports on the wrong tree, which is worse than failing.
 */
const PORT_MIN = 3100;
const PORT_MAX = 3900;

const git = (args, cwd = ROOT) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A task id that cannot escape `.worktrees/` or confuse a shell. */
export function isSafeTaskId(id) {
    return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,48}$/i.test(id);
}

/** Branch name for a task, unless one was given. `fix/` by default — most agent work is. */
export function branchFor(taskId, explicit) {
    return explicit ?? `fix/${taskId}`;
}

export function worktreePathFor(taskId, root = ROOT) {
    return path.join(root, WORKTREE_DIR, taskId);
}

/**
 * The first free port in the window.
 *
 * Probed rather than assumed: a stale worktree's dev server may still hold one, and
 * two agents starting within the same second must not both pick 3100.
 */
export async function findFreePort(min = PORT_MIN, max = PORT_MAX) {
    for (let port = min; port <= max; port += 1) {
        const free = await new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', () => resolve(false));
            server.once('listening', () => server.close(() => resolve(true)));
            server.listen(port, '127.0.0.1');
        });
        if (free) return port;
    }
    throw new Error(`No free port between ${min} and ${max}.`);
}

/**
 * Share the parent's `node_modules` without copying it.
 *
 * A junction on Windows because it needs no elevation and no developer mode, where a
 * symlink needs one or the other; a directory symlink everywhere else. Returns the
 * mechanism used so the caller can report it honestly rather than claim one.
 */
export function linkDependencies(worktreePath, root = ROOT) {
    const target = path.join(root, 'node_modules');
    const link = path.join(worktreePath, 'node_modules');

    if (!existsSync(target)) {
        throw new Error('The parent has no node_modules to share. Run `npm ci` first.');
    }
    if (existsSync(link)) return 'already-linked';

    if (os.platform() === 'win32') {
        execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore' });
        return 'ntfs-junction';
    }
    symlinkSync(target, link, 'dir');
    return 'symlink';
}

export function spawnWorktree(taskId, { branch, root = ROOT } = {}) {
    if (!isSafeTaskId(taskId)) {
        throw new Error(
            `Unusable task id "${taskId}". Letters, digits and hyphens only, up to 49 characters — ` +
            'it becomes a directory name and a branch name.',
        );
    }

    const worktreePath = worktreePathFor(taskId, root);
    if (existsSync(worktreePath)) {
        throw new Error(`${WORKTREE_DIR}/${taskId} already exists. Clean it up or pick another id.`);
    }

    const branchName = branchFor(taskId, branch);
    mkdirSync(path.join(root, WORKTREE_DIR), { recursive: true });

    /*
     * Branched from origin/develop, never from whatever HEAD happens to be.
     *
     * `main` is release-only (§8) and the local branch may be mid-task. A worktree
     * that inherits someone else's in-flight work is the contamination this exists to
     * prevent, reintroduced at creation time.
     */
    git(['fetch', 'origin', 'develop', '--quiet'], root);
    git(['worktree', 'add', '-b', branchName, worktreePath, 'origin/develop'], root);

    const linkage = linkDependencies(worktreePath, root);
    return { taskId, branch: branchName, path: worktreePath, linkage };
}

/**
 * Remove the LINK, never what it points at.
 *
 * This is the one genuinely dangerous operation in the file, and the first version of
 * it was wrong: `rmSync(link, { recursive: false })` throws `ERR_FS_EISDIR`, because a
 * Windows junction reports as a directory. It failed loudly, which was luck — the
 * obvious "fix" is to add `recursive: true`, and a recursive delete that followed the
 * junction would walk into the parent's real `node_modules` and delete the repository's
 * dependencies.
 *
 * So the type is established with `lstat` — which describes the link itself rather than
 * its target — and each kind is removed by the call that cannot follow it:
 * `unlink` for a POSIX symlink, `rmdir` for an NTFS junction. `rmdir` on a junction
 * removes the entry and leaves the target alone; that is Windows' documented behaviour
 * and the reason junctions are safe to hand out.
 *
 * Do not "simplify" this to a recursive delete.
 */
function unlinkDependencies(worktreePath) {
    const link = path.join(worktreePath, 'node_modules');
    if (!existsSync(link)) return;

    const stat = lstatSync(link);
    if (stat.isSymbolicLink()) unlinkSync(link);
    else rmdirSync(link);
}

/**
 * Remove a worktree, reporting what actually happened.
 *
 * EVERY branch returns a `note`. When one did not, the return type was a union where
 * only some members had the field, so a caller reading `result.note` did not type-check
 * — and the CLI had silently dropped the note for exactly that reason, printing
 * "nothing at ..." about a directory holding a full checkout.
 *
 * @returns {{ taskId: string, removed: boolean, note: string }}
 */
export function cleanupWorktree(taskId, { root = ROOT } = {}) {
    if (!isSafeTaskId(taskId)) throw new Error(`Unusable task id "${taskId}".`);

    const worktreePath = worktreePathFor(taskId, root);
    if (!existsSync(worktreePath)) return { taskId, removed: false, note: 'nothing at that path' };

    /* The link goes first, and it is unlinked rather than deleted. See `unlinkDependencies`. */
    unlinkDependencies(worktreePath);

    /*
     * Ask git whether it still knows this path before telling it to forget it.
     *
     * Observed 2026-09-13: a successful cleanup leaves an EMPTY directory behind on
     * Windows, so the `existsSync` guard above passes on a second run while git has
     * already dropped the registration — and `git worktree remove` then exits non-zero
     * with "is not a working tree", turning a completed teardown into a stack trace.
     * A cleanup that cannot be run twice is one a script will not retry, which matters
     * because this is what an agent calls in a finally block.
     */
    /*
     * If git cannot answer, treat the path as unregistered rather than throwing. A
     * teardown that dies because a LIST command failed is a teardown that leaves the
     * mess it was called to clear — and the leftover path below carries its own junction
     * guard, so falling through is safe rather than merely convenient.
     */
    let registered = false;
    try {
        registered = git(['worktree', 'list', '--porcelain'], root)
            .split(/\r?\n/)
            .some((line) => line.startsWith('worktree ')
                && path.resolve(line.slice('worktree '.length).trim()) === path.resolve(worktreePath));
    } catch {
        registered = false;
    }

    if (registered) {
        git(['worktree', 'remove', worktreePath, '--force'], root);

        /*
         * CHECK, do not assume. Observed 2026-09-13: `git worktree remove --force`
         * dropped the registration and returned zero while leaving the ENTIRE checkout
         * on disk — forty entries including `app/`, `components/` and `docs/`. The script
         * reported "removed" and moved on, so the tree it claimed to have deleted sat
         * there until someone happened to list the directory.
         */
        if (!existsSync(worktreePath)) return { taskId, removed: true, note: 'git removed it cleanly' };
        return { taskId, ...removeLeftovers(worktreePath) };
    }

    /*
     * Registration already gone: clear whatever git left, and report it honestly.
     *
     * The note is APPENDED, not overwritten. Spreading `removeLeftovers()` and then
     * setting `note:` after it silently discarded the more specific message — including
     * the refusal to delete past a link, which is the one message that must never be
     * lost.
     */
    const outcome = removeLeftovers(worktreePath);
    const reason = 'registration was already gone';
    return { taskId, ...outcome, note: outcome.note ? `${reason}; ${outcome.note}` : reason };
}

/**
 * Delete what `git worktree remove` left, refusing to recurse past a dependency link.
 *
 * This is the one place in the file that deletes recursively, so the junction guard is
 * re-checked HERE rather than inferred from `unlinkDependencies` having run earlier. The
 * cost of that assumption being wrong is the parent's `node_modules`, and "it was removed
 * a few lines ago" is exactly the kind of reasoning that stops being true after a
 * refactor. An empty directory is still removed with `rmdir`, which cannot recurse at all.
 */
export function removeLeftovers(worktreePath) {
    try {
        rmdirSync(worktreePath);
        return { removed: true };
    } catch {
        /* Not empty — fall through to the guarded recursive delete. */
    }

    const link = path.join(worktreePath, 'node_modules');
    if (existsSync(link)) {
        return {
            removed: false,
            note: `refused to delete recursively: ${link} still exists and a recursive `
                + 'delete would follow it into the parent. Remove the link first.',
        };
    }

    rmSync(worktreePath, { recursive: true, force: true });
    return { removed: true, note: 'git left the checkout on disk; removed it' };
}

/* ── CLI ────────────────────────────────────────────────────────────────── */

function selfTest() {
    const cases = [];
    const ok = (name, pass) => cases.push({ name, pass });

    ok('accepts a plain task id', isSafeTaskId('fix-voice-loop'));
    ok('rejects path traversal', !isSafeTaskId('../../etc'));
    ok('rejects a path separator', !isSafeTaskId('a/b'));
    ok('rejects shell punctuation', !isSafeTaskId('a;rm -rf'));
    ok('rejects the empty id', !isSafeTaskId(''));
    ok('rejects a non-string', !isSafeTaskId(undefined));

    ok('defaults to a fix/ branch', branchFor('abc') === 'fix/abc');
    ok('honours an explicit branch', branchFor('abc', 'feat/xyz') === 'feat/xyz');
    ok('places the worktree under .worktrees', worktreePathFor('abc').includes(WORKTREE_DIR));

    for (const c of cases) console.log(`  ${c.pass ? 'ok  ' : 'FAIL'}  ${c.name}`);
    const failed = cases.filter((c) => !c.pass).length;
    if (failed > 0) {
        console.error(`\nspawn-worktree --self-test FAILED — ${failed} case(s).`);
        process.exit(1);
    }
    console.log(`\nspawn-worktree --self-test OK — ${cases.length} cases.`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
const argv = process.argv.slice(2);

if (!isMain) {
    /* Imported for its exports. */
} else if (argv.includes('--self-test')) {
    selfTest();
} else if (argv[0] === '--cleanup') {
    const result = cleanupWorktree(argv[1]);
    /*
     * Print the note. It used to be dropped, so a run that had REFUSED to delete a
     * directory still holding a full checkout printed "nothing at …" — the opposite of
     * what happened. A teardown that reports the opposite of the truth is worse than one
     * that throws, because nobody goes to look.
     */
    const headline = result.removed
        ? `spawn-worktree — removed ${WORKTREE_DIR}/${result.taskId}`
        : `spawn-worktree — ${WORKTREE_DIR}/${result.taskId} NOT removed`;
    console.log(result.note ? `${headline} (${result.note})` : headline);
    if (!result.removed && result.note) process.exitCode = 1;
} else {
    const taskId = argv.find((a) => !a.startsWith('--'));
    if (!taskId) {
        console.error('Usage: node scripts/agent-system/spawn-worktree.mjs <task-id> [--branch fix/name]');
        process.exit(1);
    }
    const branchAt = argv.indexOf('--branch');
    const result = spawnWorktree(taskId, { branch: branchAt === -1 ? undefined : argv[branchAt + 1] });
    const port = await findFreePort();

    console.log(`spawn-worktree — ${result.path}`);
    console.log(`  branch:       ${result.branch} (from origin/develop)`);
    console.log(`  node_modules: ${result.linkage} to the parent — 0 bytes, no npm ci`);
    console.log(`  free port:    ${port}`);
    console.log('');
    console.log('  ONE WRITER AT A TIME (AGENTS.md §4 rule 9). This isolates files, not decisions —');
    console.log('  two agents building different answers to the same question still waste one of them.');
    console.log('');
    // Existence only; the file is never read here. Scripts load it through scripts/lib/load-env.mjs.
    const hasDevEnv = existsSync(path.join(ROOT, '.env.local'));
    console.log(hasDevEnv
        ? '  env:          main checkout .env.local found; repo scripts load it in memory (scripts/lib/load-env.mjs)'
        : '  env:          NONE. Create .env.local in the main checkout (docs/ops/15-setup-runbook.md); scripts that need it will fail closed');
    console.log('');
    console.log('  Secrets are NOT linked in. Start the dev server with memory-only parent env:');
    console.log(`    cd ${result.path} && npm run dev:worktree`);
    console.log('  Gates, tests and tools work from the worktree as-is.');
    console.log('');
    console.log(`  When done:  node scripts/agent-system/spawn-worktree.mjs --cleanup ${result.taskId}`);
}
