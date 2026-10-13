#!/usr/bin/env node
/**
 * Refuse a push that would land a non-merge commit on `main`.
 *
 *   node scripts/guard-main-push.mjs <local-ref> <remote-ref>   pre-push hook form
 *   node scripts/guard-main-push.mjs --hook                     Claude PreToolUse form
 *                                                               (reads the command off stdin)
 *   node scripts/guard-main-push.mjs --self-test                prove it bites
 *
 * WHY (2026-09-03, L-025)
 *
 * `main` is release-only and is what Vercel deploys to production. The real control is
 * a server-side one — branch protection, or its forward-looking replacement, repository
 * rulesets — and this repository cannot have either: it is private on a Free plan, and
 * both endpoints return `403 "Upgrade to GitHub Pro or make this repository public."`
 * Verified against the live API on 2026-09-03.
 *
 * `scripts/check-main-merge-origin.mjs` already turns a violation into a red build, but
 * only AFTER the push, and Vercel may be deploying by then. This is the missing half:
 * it refuses the push itself.
 *
 * TWO NETS, BECAUSE THE FIRST ONE IS ROUTINELY BYPASSED. As a git hook this is skipped
 * by `--no-verify`, which is this repository's normal way to push (the pre-push
 * typecheck is slow enough that bypassing it became habit — see `.githooks/pre-push`).
 * A control defeated by the maintainer's own muscle memory is not a control. So the same
 * function is also wired as a Claude Code `PreToolUse` hook on `Bash(git push *)`, which
 * intercepts the TOOL CALL before git ever runs and therefore survives `--no-verify`.
 *
 * Honest limit: net two is Claude-only. Codex, Antigravity and a human at a terminal get
 * net one, and neither is server-side. **L-025 stays OPEN.** This narrows the window; it
 * does not close it.
 *
 * Fails CLOSED on anything it cannot determine, like every other guard here.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { checkMergeOrigin } from './check-main-merge-origin.mjs';

const DENY_MESSAGE =
    'Refused: `main` is release-only (AGENTS.md §8) and is what Vercel deploys to production. '
    + 'Nothing lands on it except a merge from `develop` with green CI. '
    + 'Branch to `develop`, open a PR there, and let the release merge carry it to `main`.';

/** Does this push target `main`, whatever form the ref takes? */
export function targetsMain(remoteRef) {
    if (!remoteRef) return false;
    return /^(refs\/heads\/)?main$/.test(remoteRef.trim());
}

/**
 * Parse the branch a `git push` command would write to.
 *
 * Deliberately conservative: it recognises the explicit forms (`git push origin main`,
 * `git push origin HEAD:main`, `git push --force origin main`) and returns `null` for
 * anything it cannot read. `null` means "unknown", and the caller treats unknown on the
 * current branch `main` as a hit — a guard that guesses "probably fine" is not a guard.
 */
export function pushTargetFromCommand(command) {
    if (!/\bgit\s+push\b/.test(command)) return { isPush: false, branch: null };
    // Drop flags, `git`, and `push` itself; what remains is [remote, refspec...].
    const args = command
        .replace(/^.*\bgit\s+push\b/, '')
        .split(/\s+/)
        .filter((a) => a && !a.startsWith('-'));
    // `git push origin HEAD:main` / `git push origin main`
    const refspec = args[1];
    if (!refspec) return { isPush: true, branch: null };
    const dest = refspec.includes(':') ? refspec.split(':').pop() : refspec;
    return { isPush: true, branch: dest.replace(/^refs\/heads\//, '') };
}

const currentBranch = () => {
    try {
        return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
        return null;
    }
};

/** @returns {{ allowed: boolean, reason: string }} */
export function evaluate(branch, mergeCheck = checkMergeOrigin) {
    if (!targetsMain(branch)) return { allowed: true, reason: `targets ${branch ?? 'a non-main ref'}` };
    const result = mergeCheck('HEAD', 'origin/develop');
    if (result.ok) return { allowed: true, reason: `HEAD is a ${result.reason}` };
    return { allowed: false, reason: result.reason };
}

function selfTest() {
    const ok = () => ({ ok: true, reason: 'merge of abc1234, which is contained in origin/develop' });
    const bad = () => ({ ok: false, reason: 'not a merge commit' });
    const cases = [
        ['a feature branch is never blocked', evaluate('feature/x', bad).allowed === true],
        ['`main` with a non-merge HEAD is refused', evaluate('main', bad).allowed === false],
        ['`main` with a develop merge is allowed', evaluate('main', ok).allowed === true],
        ['`refs/heads/main` is recognised too', evaluate('refs/heads/main', bad).allowed === false],
        ['`Main` is not treated as main (git refs are case-sensitive)', evaluate('Main', bad).allowed === true],
        ['parses `git push origin main`', pushTargetFromCommand('git push origin main').branch === 'main'],
        ['parses `git push origin HEAD:main`', pushTargetFromCommand('git push origin HEAD:main').branch === 'main'],
        ['parses through flags', pushTargetFromCommand('git push --force-with-lease origin main').branch === 'main'],
        ['ignores a non-push command', pushTargetFromCommand('git status').isPush === false],
        ['bare `git push` reports an unknown branch, not a safe one', pushTargetFromCommand('git push').branch === null],
    ];
    let failed = 0;
    for (const [name, pass] of cases) {
        console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}`);
        if (!pass) failed++;
    }
    if (failed) {
        console.error(`\nguard-main-push --self-test — ${failed} case(s) failed. A gate that cannot fail is not a gate.`);
        process.exit(1);
    }
    console.log(`\nguard-main-push --self-test OK — ${cases.length} cases.`);
}

/**
 * Claude Code PreToolUse body: the tool input arrives as JSON. Run through
 * scripts/hook-fail-closed.mjs, so a crash here blocks the push instead of allowing it.
 * @param {string} raw
 * @returns {string} a deny decision, or '' to allow
 */
export function hookMain(raw) {
    let command = '';
    try {
        command = JSON.parse(raw)?.tool_input?.command ?? '';
    } catch {
        command = raw;
    }
    const { isPush, branch } = pushTargetFromCommand(command);
    // An unparsed `git push` on `main` is treated as targeting main. Unknown is not safe.
    const effective = branch ?? (isPush ? currentBranch() : null);
    if (!isPush || evaluate(effective).allowed) return '';
    return JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `${DENY_MESSAGE} (Shared guard: scripts/guard-main-push.mjs — survives --no-verify because it runs before git does.)`,
        },
    });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    if (process.argv.includes('--self-test')) {
        selfTest();
    } else if (process.argv.includes('--hook')) {
        let raw = '';
        process.stdin.setEncoding('utf8');
        for await (const chunk of process.stdin) raw += chunk;
        process.stdout.write(hookMain(raw));
        process.exit(0);
    } else {
        // pre-push hook: git passes "<local ref> <local sha> <remote ref> <remote sha>"
        // on stdin, one line per ref being pushed.
        let raw = '';
        process.stdin.setEncoding('utf8');
        for await (const chunk of process.stdin) raw += chunk;
        const refs = raw.split('\n').map((l) => l.trim().split(/\s+/)[2]).filter(Boolean);
        const targets = refs.filter(targetsMain);
        if (!targets.length) process.exit(0);
        const verdict = evaluate('main');
        if (!verdict.allowed) {
            console.error(`\n${DENY_MESSAGE}\n\n  ${verdict.reason}\n`);
            console.error('  (CI re-checks this after the fact via scripts/check-main-merge-origin.mjs,');
            console.error('   but by then Vercel may already be deploying. L-025.)\n');
            process.exit(1);
        }
        process.exit(0);
    }
}
