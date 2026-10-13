#!/usr/bin/env node
/**
 * Doc 36 M3: run and score the agent replay set (docs/engineering/audits/agent-replay/).
 *
 *   node scripts/agent-system/replay.mjs prepare <task> <label> [--overlay <ref>]
 *   node scripts/agent-system/replay.mjs run <task> <label> [--max-usd 20] [--minutes 90]
 *   node scripts/agent-system/replay.mjs score <task> <label>
 *   node scripts/agent-system/replay.mjs validate <task>    # reference must pass, base should fail
 *   node scripts/agent-system/replay.mjs probe-server-actions <bites|transitive>   # RP-04 scorer
 *
 * `prepare` checks out the task's base, then OVERLAYS today's instruction files from <ref>
 * (default HEAD) and commits them as the replay's start. Without the overlay a replay reads
 * the instructions of its base commit, so a prompt change could never move the score.
 *
 * `run` drives `claude -p` on the Claude subscription: ANTHROPIC_API_KEY and cloud
 * credentials are removed from its environment (owner, 2026-10-11), git push and gh are
 * disabled, and today's secret-read and worktree-scope guards are added on top of the base's own hooks.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOTSTRAP } from '../hook-fail-closed.mjs';
import { cleanupWorktree, linkDependencies } from './spawn-worktree.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '../..');
// Replays live beside the other agent worktrees, under the main checkout, even when run from a worktree.
const MAIN = path.dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim());
const SET = path.join(ROOT, 'docs/engineering/audits/agent-replay/replay-set.json');

/** The files that instruct an agent. Everything else stays as the base commit had it. */
export const OVERLAY_PATHS = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.claude/rules', '.claude/agents', '.claude/skills', '.agents', 'agent-system/rules-digest.md'];

/**
 * Paid or private credentials a replay session must not inherit. The session bills the subscription,
 * so every Anthropic variable and every billing-route selector (CLAUDE_CODE_USE_VERTEX, ...) goes too.
 */
const SCRUB = /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$|AWS_|AZURE_|GOOGLE_APPLICATION_CREDENTIALS$|GH_|GITHUB_|SSH_AUTH_SOCK$)|SECRET|PASSW|TOKEN|CREDENTIAL|PRIVATE|DATABASE_URL|_KEY$|_KEY_/i;

/**
 * The environment of a replay session and of everything scoring runs (the session's own tests and scripts).
 * GIT_ALLOW_PROTOCOL=file refuses every network transport, whatever the URL's spelling, a remote's pushurl
 * or a `-c protocol.allow=always`, and the emptied helper list means Git Credential Manager is never asked.
 * This stops an agent pushing or billing by habit; it is not a sandbox against code written to escape it
 * (a script can unset the variable, and the file system is the user's).
 * @param {Record<string, string | undefined>} [env] @returns {Record<string, string | undefined>}
 */
export function sessionEnv(env = process.env) {
    const out = Object.fromEntries(Object.entries(env).filter(([k]) => !SCRUB.test(k)));
    return { ...out, GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
        GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GH_TOKEN: 'replay-disabled', GITHUB_TOKEN: 'replay-disabled' };
}

/**
 * Claude Code ranks an apiKeyHelper, an Anthropic profile and a settings `env` key above the subscription
 * login (https://code.claude.com/docs/en/iam, "Authentication precedence"), and none is an env var the
 * scrub can drop. So `run` asks `claude auth status` what it would use and refuses anything else.
 * @param {{ authMethod?: string, apiProvider?: string } | null} status
 */
export function assertSubscription(status) {
    if (status?.authMethod !== 'claude.ai' || status.apiProvider !== 'firstParty') {
        throw new Error(`replay: refusing to run, claude would bill ${status?.apiProvider ?? '?'}/${status?.authMethod ?? 'no login'}, not the subscription (claude.ai)`);
    }
}

/** Session settings: push and secret reads denied, and every tool call kept inside the replay worktree `dir`. */
export function sessionSettings(dir, { root = ROOT, main = MAIN } = {}) {
    const guard = (...args) => ({ type: 'command', command: 'node', args: ['-e', BOOTSTRAP, path.join(root, 'scripts/hook-fail-closed.mjs'), ...args], timeout: 60 });
    const scope = guard('guard-replay-scope.mjs', dir, main);
    return {
        permissions: { deny: ['Bash(git push:*)', 'Bash(gh:*)', 'Read(//**/.env*)', 'Read(//**/service_account.json)'] },
        hooks: { PreToolUse: [
            { matcher: 'Bash', hooks: [guard('guard-bash-secret-read.mjs'), scope] },
            { matcher: 'PowerShell', hooks: [guard('guard-bash-secret-read.mjs', '--powershell'), scope] },
            { matcher: 'Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep|LS', hooks: [scope] },
        ] },
    };
}

// Git's bash on Windows: `bash` on PATH may be WSL's, which cannot see this checkout's tools.
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const BASH = process.platform === 'win32' && existsSync(GIT_BASH) ? GIT_BASH : 'bash';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const loadTask = (id) => {
    const task = JSON.parse(readFileSync(SET, 'utf8')).tasks.find((t) => t.id === id);
    if (!task) throw new Error(`No replay task ${id}.`);
    return task;
};
const dirFor = (id, label) => {
    if (!/^[a-z0-9-]{1,24}$/i.test(label)) throw new Error(`Unusable label "${label}".`);
    return path.join(MAIN, '.worktrees', `replay-${id.toLowerCase()}-${label}`);
};
// Kept in the worktree's git dir, so neither file shows in the diff being scored.
const stateFile = (dir) => path.join(git(dir, 'rev-parse', '--absolute-git-dir'), 'replay.json');

/** node_modules for the base's own lockfile, installed once per lock and shared by junction. */
function linkBaseDependencies(dir) {
    const lock = readFileSync(path.join(dir, 'package-lock.json'));
    const deps = path.join(MAIN, '.worktrees', '.replay-deps', createHash('sha1').update(lock).digest('hex').slice(0, 12));
    // The marker, not node_modules, says the install finished: a failed `npm ci` leaves a partial tree.
    if (!existsSync(path.join(deps, '.installed'))) {
        mkdirSync(deps, { recursive: true });
        // .npmrc carries legacy-peer-deps, without which this lockfile does not install.
        for (const f of ['package.json', 'package-lock.json', '.npmrc']) if (existsSync(path.join(dir, f))) copyFileSync(path.join(dir, f), path.join(deps, f));
        // --ignore-scripts: the root `prepare` would rewrite this repository's git config.
        execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: deps, stdio: 'inherit', shell: true });
        writeFileSync(path.join(deps, '.installed'), new Date().toISOString());
    }
    return linkDependencies(dir, deps);
}

const repoFor = (dir, main = MAIN) => path.join(main, '.worktrees', '.replay-repos', `${path.basename(dir)}.git`);

/**
 * A worktree of a private bare clone, not of this repository. WHY (RP-07 pilot, 2026-10-11): from a worktree of
 * the main checkout, scripts/lib/load-env.mjs falls back to the main checkout's local env file (some scripts with
 * `override: true`), so a replay could reach the dev database from inside its own directory. Here git's common dir
 * is the clone, whose folder holds no env file, at every base. The clone keeps no refs, so today's branches are
 * out of reach too, and a worktree still passes the write guard (git-dir differs from the common dir).
 */
export function privateWorktree(dir, commit, main = MAIN) {
    const repo = repoFor(dir, main);
    rmSync(repo, { recursive: true, force: true });
    git(main, 'clone', '--quiet', '--bare', '--local', '--no-tags', main, repo);
    git(repo, 'remote', 'remove', 'origin');
    git(repo, 'update-ref', '--no-deref', 'HEAD', commit);
    for (const ref of git(repo, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean)) git(repo, 'update-ref', '-d', ref);
    try { git(repo, 'config', 'core.hooksPath', git(main, 'config', '--get', 'core.hooksPath')); } catch { /* no hooksPath: git's default */ }
    git(repo, 'worktree', 'add', '--detach', dir, commit);
}

function addWorktree(dir, commit) {
    if (existsSync(dir)) throw new Error(`${dir} exists; remove it with cleanup first.`);
    privateWorktree(dir, commit);
    try { linkBaseDependencies(dir); } catch (e) { removeCheckout(dir); throw e; }
}

/** Remove a replay checkout (dependency link first) and its private clone. */
function removeCheckout(dir) {
    const out = cleanupWorktree(path.basename(dir), { root: MAIN });
    rmSync(repoFor(dir), { recursive: true, force: true });
    return out;
}

/** Commit the index without hooks, leaving HEAD detached on it: replay bookkeeping, not a change of record. */
function plumbingCommit(dir, message) {
    git(dir, 'add', '-A');
    const tree = git(dir, 'write-tree');
    const commit = git(dir, 'commit-tree', tree, '-p', 'HEAD', '-m', message);
    git(dir, 'update-ref', '--no-deref', 'HEAD', commit);
    return commit;
}

/** Replace each OVERLAY_PATHS entry in `dir` with `overlay`'s copy (or remove it) and commit that as the start. */
export function overlayInstructions(dir, overlay, message) {
    for (const p of OVERLAY_PATHS) {
        git(dir, 'rm', '-r', '-q', '--ignore-unmatch', '--', p);
        if (spawnSync('git', ['cat-file', '-e', `${overlay}:${p}`], { cwd: dir }).status === 0) git(dir, 'checkout', overlay, '--', p);
    }
    return plumbingCommit(dir, message);
}

export function prepare(id, label, overlayRef = 'HEAD') {
    const task = loadTask(id);
    const dir = dirFor(id, label);
    const overlay = git(ROOT, 'rev-parse', overlayRef);
    addWorktree(dir, task.base);
    const start = overlayInstructions(dir, overlay, `replay ${id}: instructions from ${overlay}`);
    writeFileSync(stateFile(dir), JSON.stringify({ id, label, base: task.base, overlay, start }, null, 2));
    return { dir, start };
}

/**
 * The overlaid AGENTS.md sends an agent to `npm run agent:worktree`, which fetches develop (refused here)
 * and would branch from today's develop, not the replay's base. This checkout is already that worktree.
 */
export const REPLAY_NOTE = 'This checkout is already an isolated git worktree at the start commit for this task; it is your task worktree. '
    + 'Edit here. Do not run `npm run agent:worktree`, fetch or push: the network git transports are disabled.';

/** The `claude` arguments of a replay session: the prompt verbatim, plus REPLAY_NOTE as system context. */
export function sessionArgs(prompt, settings, maxUsd) {
    return ['-p', prompt, '--append-system-prompt', REPLAY_NOTE, '--output-format', 'json', '--permission-mode', 'bypassPermissions',
        '--settings', settings, '--max-budget-usd', String(maxUsd)];
}

export function run(id, label, { maxUsd = 20, minutes = 90 } = {}) {
    const task = loadTask(id);
    const dir = dirFor(id, label);
    const state = JSON.parse(readFileSync(stateFile(dir), 'utf8'));
    const settings = path.join(git(dir, 'rev-parse', '--absolute-git-dir'), 'replay-settings.json');
    writeFileSync(settings, JSON.stringify(sessionSettings(dir)));
    const auth = spawnSync('claude', ['auth', 'status', '--json'], { cwd: dir, env: sessionEnv(), encoding: 'utf8' });
    let status = null;
    try { status = JSON.parse(auth.stdout); } catch { /* status stays null, and assertSubscription refuses */ }
    assertSubscription(status);
    const res = spawnSync('claude', sessionArgs(task.prompt, settings, maxUsd), {
        cwd: dir, env: sessionEnv(), encoding: 'utf8', timeout: minutes * 60_000, maxBuffer: 64 << 20,
    });
    let out = {};
    try { out = JSON.parse(res.stdout); } catch { out = { unparsed: (res.stdout ?? '').slice(-2000) }; }
    state.session = { exit: res.status, signal: res.signal, timedOut: res.error?.code === 'ETIMEDOUT', subtype: out.subtype, isError: out.is_error, costUsd: out.total_cost_usd, turns: out.num_turns, durationMs: out.duration_ms, sessionId: out.session_id, result: String(out.result ?? out.unparsed ?? '').slice(0, 4000) };
    state.session.cutShort = cutShort(state.session);
    writeFileSync(stateFile(dir), JSON.stringify(state, null, 2));
    return state.session;
}

/** Run each check's `run` command in `dir`, with $BASE the commit the agent started from. */
export function scoreDir(task, dir, base) {
    git(dir, 'add', '-A', '-N'); // new files show in `git diff $BASE` and `git grep`
    return task.checks.map((c) => {
        if (!c.run) return { id: c.id, pass: null, note: 'no run command; scored by reading' };
        // A check runs the session's own tests and scripts, so it gets the session's scrubbed env, never ours.
        const r = spawnSync(BASH, ['-c', c.run], { cwd: dir, encoding: 'utf8', timeout: 15 * 60_000, env: { ...sessionEnv(), BASE: base, REPLAY: SELF }, maxBuffer: 64 << 20 });
        return { id: c.id, pass: r.status === 0, proxy: Boolean(c.proxy), note: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().slice(-300) };
    });
}

/**
 * Why a session is no result, or null: it never ran, or something stopped it mid-task (the time cap, the
 * usage limit, `--max-budget-usd`, a crash). Judged from exit and result subtype, never the agent's own words.
 */
export function cutShort(session) {
    if (!session) return 'never run';
    if (session.timedOut) return 'timed out';
    if (session.signal || session.exit !== 0) return session.signal ? `killed by ${session.signal}` : `exited ${session.exit}`;
    if (session.isError || (session.subtype !== undefined && session.subtype !== 'success')) return session.subtype ?? 'error';
    return null;
}

export function score(id, label) {
    const dir = dirFor(id, label);
    const state = JSON.parse(readFileSync(stateFile(dir), 'utf8'));
    const why = cutShort(state.session);
    if (why) throw new Error(`replay: ${id} ${label} was cut short (${why}); prepare and run it again, a cut-short session is no result`);
    state.scores = scoreDir(loadTask(id), dir, state.start);
    writeFileSync(stateFile(dir), JSON.stringify(state, null, 2));
    return state;
}

export function validate(id) {
    const task = loadTask(id);
    const out = {};
    for (const [arm, commit] of [['reference', task.reference], ['base', task.base]]) {
        const dir = dirFor(id, `v-${arm}`);
        addWorktree(dir, commit);
        try { out[arm] = scoreDir(task, dir, task.base); } finally {
            // Best effort: Windows can hold a file a test just closed, and the scores must not be lost to it.
            try { removeCheckout(dir); } catch (e) { console.error(`cleanup of ${dir} failed: ${e.message}`); }
        }
    }
    return out;
}

/* ── RP-04 scorer: does the agent's own check catch an unauthenticated action? ── */

const PROBES = {
    unauth: `'use server';\nexport async function replayProbeUnauthenticated(id: string) {\n    return { id };\n}\n`,
    helpers: `'use server';\nimport { auth } from '@clerk/nextjs/server';\n\nasync function requireUserId() {\n    const { userId } = await auth();\n    if (!userId) throw new Error('Unauthorized');\n    return userId;\n}\n\nasync function requireOwner() {\n    return requireUserId();\n}\n\nexport async function replayProbeLocalHelper() {\n    return { userId: await requireUserId() };\n}\n\nexport async function replayProbeChainedHelpers() {\n    return { userId: await requireOwner() };\n}\n`,
};

/** The commands that could be the agent's check: npm scripts it added or changed, check:rules, and its new tests. */
function candidateChecks(dir, base) {
    const scripts = (src) => { try { return JSON.parse(src).scripts ?? {}; } catch { return {}; } };
    const now = scripts(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const before = scripts(git(dir, 'show', `${base}:package.json`));
    const npm = Object.keys(now).filter((k) => now[k] !== before[k] && !/^(gate(:|$)|(test|dev|build|start|lint)$)/.test(k));
    const tests = git(dir, 'diff', '--name-only', '--diff-filter=A', base).split('\n').filter((f) => /\.test\.(m?[jt]sx?)$/.test(f));
    return [...new Set([...npm, 'check:rules'])].map((s) => ['npm', ['run', '-s', s]])
        .concat(tests.map((f) => ['npx', ['vitest', 'run', '--pool=threads', f]]));
}

export function probeServerActions(expect, dir = process.cwd(), base = process.env.BASE) {
    const probeDir = path.join(dir, 'app', 'replay-probe');
    // Intent-to-add, so a check that walks `git ls-files` (the RP-04 reference does) sees the probe.
    const plant = (kind) => {
        git(dir, 'rm', '-r', '-q', '--cached', '--ignore-unmatch', 'app/replay-probe');
        rmSync(probeDir, { recursive: true, force: true });
        if (!kind) return;
        mkdirSync(probeDir, { recursive: true });
        writeFileSync(path.join(probeDir, 'actions.ts'), PROBES[kind]);
        git(dir, 'add', '-N', 'app/replay-probe/actions.ts');
    };
    const exit = ([cmd, args]) => spawnSync(cmd, args, { cwd: dir, env: sessionEnv(), stdio: 'ignore', shell: true, timeout: 10 * 60_000 }).status;
    const rows = [];
    try {
        for (const c of candidateChecks(dir, base)) {
            plant(null); const clean = exit(c);
            if (clean !== 0) { rows.push({ cmd: c.flat().join(' '), clean }); continue; }
            plant('unauth'); const unauth = exit(c);
            plant('helpers'); const helpers = exit(c);
            rows.push({ cmd: c.flat().join(' '), clean, unauth, helpers });
        }
    } finally { plant(null); }
    const bites = rows.filter((r) => r.clean === 0 && r.unauth !== 0);
    const pass = expect === 'transitive' ? bites.some((r) => r.helpers === 0) : bites.length > 0;
    console.log(JSON.stringify(rows));
    return pass;
}

const [cmd, ...argv] = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(name); return i < 0 ? dflt : argv[i + 1]; };
if (path.resolve(process.argv[1] ?? '') === SELF) {
    if (cmd === 'prepare') console.log(prepare(argv[0], argv[1], flag('--overlay', 'HEAD')));
    else if (cmd === 'run') console.log(run(argv[0], argv[1], { maxUsd: Number(flag('--max-usd', 20)), minutes: Number(flag('--minutes', 90)) }));
    else if (cmd === 'score') console.log(JSON.stringify(score(argv[0], argv[1]).scores, null, 2));
    else if (cmd === 'validate') console.log(JSON.stringify(validate(argv[0]), null, 2));
    else if (cmd === 'probe-server-actions') process.exit(probeServerActions(argv[0]) ? 0 : 1);
    else if (cmd === 'cleanup') console.log(removeCheckout(dirFor(argv[0], argv[1])));
    else { console.error('usage: replay.mjs prepare|run|score|validate|cleanup <task> <label> | probe-server-actions <bites|transitive>'); process.exit(2); }
}
