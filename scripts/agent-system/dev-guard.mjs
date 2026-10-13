#!/usr/bin/env node
/**
 * `predev` guard — runs before every `npm run dev` (npm lifecycle, so it binds
 * every tool and human, not one provider's hooks; AGENTS.md §11).
 *
 * Plain `next dev` inside `.worktrees/<id>` always fails: Turbopack panics on the
 * `node_modules` junction and the worktree has no env file. `npm run dev:worktree`
 * (webpack, parent env loaded in memory) is the working path, so stop early with
 * that pointer instead of letting the crash look like an app bug.
 * `dev:worktree` spawns `next dev` directly, so this hook never blocks it.
 */
import { pathToFileURL } from 'node:url';
import { isInsideWorktree } from './dev-worktree.mjs';

export const WORKTREE_DEV_MESSAGE =
    '[predev] plain `npm run dev` cannot run inside a worktree (Turbopack symlink panic, no env file).\n' +
    '         Use: npm run dev:worktree -- --port 3100';

/** @returns {number} the exit code for `cwd` — 1 inside a worktree, else 0. */
export function devGuardExitCode(cwd) {
    return isInsideWorktree(cwd) ? 1 : 0;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
    const code = devGuardExitCode(process.cwd());
    if (code !== 0) console.error(WORKTREE_DEV_MESSAGE);
    process.exit(code);
}
