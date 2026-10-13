import { execFileSync } from 'node:child_process';

/**
 * Staged git-index entries. `status` is the first letter of the git
 * name-status code (A/M/D/R/C…); for renames/copies `path` is the NEW path.
 * Returns [] outside a git repo or with nothing staged — callers treat that
 * as "nothing to guard".
 * @returns {Array<{ status: string, path: string }>}
 */
export function stagedEntries() {
    let out = '';
    try {
        out = execFileSync('git', ['diff', '--cached', '--name-status'], { encoding: 'utf8' });
    } catch {
        return [];
    }
    return parseNameStatus(out);
}

/**
 * Committed-diff entries for CI (no staging area on a runner). Diffs
 * `base...HEAD` (merge-base — the PR/branch changes), so the same guards that
 * run in pre-commit can run as the CI backstop against a `--no-verify` bypass.
 * Returns [] on any failure (missing ref, all-zero base) — callers treat that
 * as "nothing to guard"; the pre-commit hook remains the primary line.
 * @param {string} base ref to diff HEAD against (branch name or sha)
 * @returns {Array<{ status: string, path: string }>}
 */
export function changedEntries(base) {
    if (!base || /^0+$/.test(base)) return [];
    let out = '';
    try {
        out = execFileSync('git', ['diff', '--name-status', `${base}...HEAD`], { encoding: 'utf8' });
    } catch {
        return [];
    }
    return parseNameStatus(out);
}

/** @param {string} out git --name-status output */
function parseNameStatus(out) {
    return out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const parts = line.split('\t');
            return { status: parts[0][0], path: parts[parts.length - 1] };
        });
}
