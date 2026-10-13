/**
 * One state directory for every checkout of this repository: `<git-common-dir>/agent-state/`.
 *
 * Agents work in `.worktrees/<id>` (doc 34 W7), and each worktree is deleted after its
 * branch merges. Anything written under a worktree's own `logs/` is deleted with it. That
 * is how the hook audit log went silent after 2026-10-03. The git common directory is
 * shared by the main checkout and every linked worktree, sits outside the working tree
 * (so it can never be committed), and does not depend on which coding tool is running.
 *
 * Fails soft: outside a git repository, the caller's `<root>/logs` is used instead.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** @param {string} [cwd] */
export function sharedStateDir(cwd = process.cwd()) {
    const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', timeout: 3000 });
    const common = r.status === 0 ? r.stdout.trim() : '';
    const dir = common ? path.join(common, 'agent-state') : path.join(cwd, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Appends one JSON line. Never throws: telemetry must not break the work it observes.
 * Skipped under Vitest, so fixture runs never pollute the real record.
 * @param {string} file e.g. 'agent-hooks.jsonl'
 * @param {Record<string, unknown>} record
 * @param {string} [cwd]
 */
export function appendShared(file, record, cwd) {
    // Test runs exercise the hooks and the gate with fixtures; their records are not real work.
    if (process.env.VITEST) return;
    try {
        fs.appendFileSync(path.join(sharedStateDir(cwd), file),
            JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
    } catch { /* non-blocking */ }
}

/**
 * Reads a JSON-lines file from the shared directory, skipping lines that do not parse.
 * @param {string} file
 * @param {string} [cwd]
 * @returns {Record<string, any>[]}
 */
export function readShared(file, cwd) {
    try {
        return fs.readFileSync(path.join(sharedStateDir(cwd), file), 'utf8').split('\n')
            .flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } });
    } catch { return []; }
}
