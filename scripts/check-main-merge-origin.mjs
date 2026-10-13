#!/usr/bin/env node
/**
 * `main` is release-only: assert every commit on it arrived as a merge from `develop`.
 *
 *   node scripts/check-main-merge-origin.mjs            # check HEAD
 *   node scripts/check-main-merge-origin.mjs <sha>      # check a specific commit
 *   node scripts/check-main-merge-origin.mjs --pr       # check a pull request (env below)
 *
 * WHY (2026-08-28, L-025): AGENTS.md section 8 says "nothing lands on `main` except a
 * merge from `develop` with green CI", and Vercel deploys `main` to production. Nothing
 * enforced it. Dependabot had three PRs open against `main` - including `satori`
 * 0.29 -> 0.33, which renders every carousel, and `svix` 2.0, which verifies Clerk
 * webhook signatures - purely because Dependabot defaults to the repository's DEFAULT
 * branch. Merging any of them would have deployed straight to production, bypassing
 * `develop` entirely.
 *
 * TWO CHECKS, TWO MOMENTS. `checkMergeOrigin` runs on a push to `main`, after the fact:
 * it cannot stop the push, only turn it into a red build. `checkPrOrigin` (2026-09-25)
 * runs at PR time inside the `Code Quality` job, which the `main-protection` ruleset
 * (.github/rulesets/main.json) requires - so a pull request into `main` from anything but
 * this repository's own `develop` cannot merge, for any author, human or bot. Both stay:
 * the push check is the backstop if the ruleset is ever disabled.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

/**
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkMergeOrigin(commit = 'HEAD', developRef = 'origin/develop') {
    let parents;
    try {
        parents = git('rev-list', '--parents', '-n', '1', commit).split(/\s+/).slice(1);
    } catch (error) {
        return { ok: false, reason: `cannot read commit "${commit}": ${error instanceof Error ? error.message : error}` };
    }

    if (parents.length < 2) {
        return {
            ok: false,
            reason: `${commit.slice(0, 8)} is not a merge commit. main is release-only (AGENTS.md section 8): `
                + 'work belongs on a branch off develop, and reaches main only as a merge from develop.',
        };
    }

    // The second parent is the branch that was merged IN. It must be on develop.
    const merged = parents[1];
    try {
        git('merge-base', '--is-ancestor', merged, developRef);
    } catch {
        return {
            ok: false,
            reason: `${commit.slice(0, 8)} is a merge, but its merged-in parent ${merged.slice(0, 8)} is not contained in ${developRef}. `
                + 'main takes merges from develop only - not from a feature branch, a fork, or a bot targeting main directly.',
        };
    }

    return { ok: true, reason: `merge of ${merged.slice(0, 8)}, which is contained in ${developRef}` };
}

/**
 * A pull request into `main` must come from `develop` in this same repository. The repo
 * comparison matters: a fork can name its branch `develop`.
 *
 * @param {{ baseRef?: string, headRef?: string, headRepo?: string, baseRepo?: string }} pr
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkPrOrigin({ baseRef, headRef, headRepo, baseRepo }) {
    if (!baseRef || !headRef || !headRepo || !baseRepo) {
        // Fail closed (AGENTS.md section 4 rule 6): missing context is not a pass.
        return { ok: false, reason: 'missing pull request context (BASE_REF, HEAD_REF, HEAD_REPO, BASE_REPO)' };
    }
    if (baseRef !== 'main') return { ok: true, reason: `targets ${baseRef}, not main` };
    if (headRef !== 'develop' || headRepo !== baseRepo) {
        return {
            ok: false,
            reason: `this pull request merges ${headRepo}:${headRef} into main. main takes pull requests from `
                + `${baseRepo}:develop only - retarget it at develop.`,
        };
    }
    return { ok: true, reason: `${headRepo}:develop into main` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href && process.argv[2] === '--pr') {
    const { ok, reason } = checkPrOrigin({
        baseRef: process.env.BASE_REF,
        headRef: process.env.HEAD_REF,
        headRepo: process.env.HEAD_REPO,
        baseRepo: process.env.BASE_REPO,
    });
    if (!ok) {
        console.error(`
check-main-merge-origin --pr — ${reason}
`);
        process.exit(1);
    }
    console.log(`check-main-merge-origin --pr OK — ${reason}`);
} else if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const commit = process.argv[2] ?? 'HEAD';
    const { ok, reason } = checkMergeOrigin(commit);
    if (!ok) {
        console.error(`\ncheck-main-merge-origin — main is release-only, and this commit is not a merge from develop.\n`);
        console.error(`  ${reason}\n`);
        console.error('If this was a deliberate emergency hotfix, land it on develop and merge forward,');
        console.error('then say so in the commit trail. Do not weaken this check to make it pass.\n');
        process.exit(1);
    }
    console.log(`check-main-merge-origin OK — ${reason}`);
}
