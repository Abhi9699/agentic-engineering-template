/**
 * Provider-neutral core of the task-discipline hooks (preflight → write guard → stop guard).
 *
 * Every provider wrapper (antigravity-*.mjs, claude-*.mjs) is a thin translation layer:
 * it parses its provider's payload, calls one function here, and prints its provider's
 * output shape. The policy lives only in this file, so a fix lands on every tool at once.
 * Which wrapper runs on which provider event is declared in agent-system/hooks.json.
 *
 * State: os.tmpdir()/agy-preflight-<sessionId>.json — the same file research-capture.mjs
 * flips `researchCaptured` in. The sessionId is Antigravity's conversationId or Claude's
 * session_id; neither provider can see the other's files, so they never collide.
 *
 * Policy (doc 34 W3, 2026-10-03): gate on outcomes, not on the prompt.
 *  - The prompt hook is advisory. Keyword routing cannot tell a question from a change.
 *  - Each write is ledgered; risk is classified from the paths this session wrote (not
 *    `git status`, which in a shared checkout holds another agent's files) and only rises.
 *  - Research is owed only before a vendor-integration or dependency-version write.
 *  - Stop runs the related tests and `tsc` for the written paths, then the evidence check.
 *    A session that wrote nothing since the gate last settled ends for free.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSecretPath } from '../../guard-secrets.mjs';
import { openLessonsForRoute } from '../../lib/lesson-classes.mjs';
import { appendShared } from '../../lib/shared-state.mjs';
import { classify, loadRouting } from '../resolve-task.mjs';

const RISK_ORDER = ['R0', 'R1', 'R2', 'R3', 'R4'];
export const MAX_CONSECUTIVE_STOP_BLOCKS = 2;
/** Two 120 s steps (session-gate.mjs) plus selection; the hooks.json Stop timeout sits above it. */
export const STOP_GATE_TIMEOUT_MS = 270_000;

export function safeId(id) {
    return typeof id === 'string' ? id.replace(/[^\w-]/g, '') : '';
}

export function statePath(sessionId) {
    return path.join(os.tmpdir(), `agy-preflight-${safeId(sessionId)}.json`);
}

export function readState(sessionId) {
    if (!safeId(sessionId)) return null;
    try { return JSON.parse(fs.readFileSync(statePath(sessionId), 'utf8')); }
    catch { return null; }
}

function saveState(sessionId, state) {
    if (!safeId(sessionId)) return;
    try { fs.writeFileSync(statePath(sessionId), JSON.stringify({ ...state, writtenAt: Date.now() })); }
    catch { /* state is advisory; a failed write degrades to "no preflight" */ }
}

/** Hook audit trail in the shared state dir, so a worktree's records outlive the worktree. */
export function audit(root, hook, record) {
    appendShared('agent-hooks.jsonl', { hook, ...record }, root);
}

/**
 * Open §B items (not ✅ Done) whose bold title shares a distinctive word with the task.
 * §B is "agent build-time tasks — verify before relying", not an owner stop list, so a
 * hit is a note to verify, never a block.
 */
export function verifyNotes(taskDesc, openQuestionsText) {
    const sectionB = openQuestionsText.split(/^##\s*B\.[^\n]*$/m)[1]?.split(/^##\s/m)[0] ?? '';
    const words = new Set((taskDesc.toLowerCase().match(/\b[a-z]{6,}\b/g) ?? []));
    const notes = [];
    for (const line of sectionB.split('\n')) {
        const title = line.match(/^-\s+\*\*(.+?)\*\*/)?.[1];
        if (!title || line.includes('✅')) continue;
        const titleWords = title.toLowerCase().match(/\b[a-z]{6,}\b/g) ?? [];
        if (titleWords.some((w) => words.has(w))) notes.push(title);
    }
    return notes;
}

/**
 * OPEN lessons a task touches: those whose class bears on the task's route (doc 36 P2,
 * `scripts/lib/lesson-classes.mjs`), plus any whose `trigger:` text the task names.
 * @param {string} taskDesc
 * @param {string} lessonsText
 * @param {string} [route]
 */
export function openLessonHits(taskDesc, lessonsText, route = '') {
    const lower = taskDesc.toLowerCase();
    const hits = route ? openLessonsForRoute(route, lessonsText) : [];
    for (const block of lessonsText.split(/^## /m)) {
        if (!block.includes('status: OPEN') && !block.includes('status:** OPEN')) continue;
        const id = block.match(/^(L-\d+)/)?.[1];
        const trigger = block.match(/trigger[^:]*:\s*["']?([^\n"']+)["']?/i)?.[1]?.toLowerCase();
        if (id && trigger && lower.includes(trigger) && !hits.includes(id)) hits.push(id);
    }
    return hits;
}

function readText(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/**
 * Classify a prompt with the same resolver `npm run agent:task` uses. ADVISORY ONLY
 * (doc 34 W3): at prompt time no file has changed, and keyword routing put 22 of 22
 * prompts in one session, read-only questions included, on an R3 lane. Gates arm from
 * the paths a session writes (evaluateWrite), never from this.
 */
export function preflight(taskDesc, root = process.cwd()) {
    const { route, confidence } = classify(taskDesc, [], loadRouting(root));
    return {
        route: route?.id ?? 'unresolved',
        confidence,
        risk: route?.risk ?? 'R1',
        requiredSkills: route?.requiredSkills ?? [],
        verifyNotes: verifyNotes(taskDesc, readText(path.join(root, 'docs', 'OPEN_QUESTIONS.md'))),
        openLessonHits: openLessonHits(taskDesc, readText(path.join(root, 'vault', '_Lessons.md')), route?.id ?? ''),
    };
}

/** Record the prompt's advisory route. It never touches the gating fields. */
export function recordPreflight(sessionId, taskDesc, result) {
    const next = { ...emptyState(), ...readState(sessionId), advice: { taskDesc, route: result.route, risk: result.risk } };
    saveState(sessionId, next);
    return next;
}

function emptyState() {
    return { risk: 'R0', route: 'none', written: [], pending: [], researchOwed: false, researchCaptured: false, startedAt: Date.now() };
}

/**
 * Research is owed only where the code meets a vendor or a dependency version, where a
 * stale assumption about the outside world is this repo's worst historical bug source
 * (AGENTS.md §11). Everything else is checked by its outcome at Stop.
 */
export const VENDOR_PATH_RE = new RegExp([
    /^package(-lock)?\.json$/,
    /^proxy\.ts$/, // Auth middleware
    /^app\/api\/(billing|webhooks)\//, // Billing and auth webhooks
    /^lib\/services\/billing\.service\.ts$/, // Billing client
    /^lib\/(repositories|config)\/ai\.(repository|config)\.ts$/, // AI client
    /^lib\/publishing\//, // Publishing service
    /^(app|lib|components)\/.*(billing|auth|webhook)[^/]*$/i,
].map((r) => r.source).join('|'), 'i');
/** A dependency version in package.json text: `"name": "^1.2.3"`. Script lines never match. */
const DEPENDENCY_SPEC_RE = /"[@\w./-]+"\s*:\s*"[\^~>=<]*\d/;

/** Is research owed before this write? package.json only when a version is in the edit. */
export function needsResearch(rel, content) {
    if (!VENDOR_PATH_RE.test(rel)) return false;
    if (/^package\.json$/.test(rel) && typeof content === 'string') return DEPENDENCY_SPEC_RE.test(content);
    return true;
}

export function gitTop(cwd) {
    try {
        const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 3000 });
        return r.status === 0 ? r.stdout.trim() : '';
    } catch { return ''; }
}

/** Repo-relative POSIX path, or null for a file outside the repo (scratchpad, memory, another worktree). */
export function normalise(targetFile, base) {
    const p = String(targetFile ?? '').replace(/\\/g, '/');
    const b = String(base ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (b && p.toLowerCase().startsWith(b.toLowerCase() + '/')) return p.slice(b.length + 1);
    if (/^[a-z]:\//i.test(p) || p.startsWith('/')) return null;
    return p.replace(/^\.\//, '') || null;
}

/**
 * Is this path inside a repository's MAIN checkout rather than a linked worktree?
 * `git rev-parse --git-dir` equals `--git-common-dir` only in the main checkout (doc 34 W7).
 * A file that does not exist yet is judged by its nearest existing ancestor. Anything git
 * cannot answer (no repo, no git, timeout) is "not main": this guard fails open.
 */
export function inMainCheckout(absPath) {
    try {
        let dir = path.resolve(absPath);
        while (!fs.existsSync(dir)) {
            const up = path.dirname(dir);
            if (up === dir) return false;
            dir = up;
        }
        if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
        const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd: dir, encoding: 'utf8', timeout: 3000 });
        if (r.status !== 0) return false;
        const [gitDir, commonDir] = r.stdout.trim().split(/\r?\n/).map((p) => {
            const abs = path.resolve(p);
            return process.platform === 'win32' ? abs.toLowerCase() : abs;
        });
        return Boolean(gitDir) && gitDir === commonDir;
    } catch { return false; }
}

const MAIN_CHECKOUT_REASON = (file) =>
    `${file} is in the main checkout. Agents write only inside a worktree (doc 34 W7):\n` +
    '  1. npm run agent:worktree <task-id>   (branches from origin/develop into .worktrees/<task-id>)\n' +
    '  2. make every edit under .worktrees/<task-id>/\n' +
    '  3. npm run agent:worktree -- --cleanup <task-id>   when the branch is merged\n' +
    'The owner\'s own editor is not hooked, so their edits here are unaffected.';

const LEDGER_MAX = 500;
const maxRisk = (a, b) => (RISK_ORDER.indexOf(b) > RISK_ORDER.indexOf(a) ? b : a);

/**
 * Decide a file write and ledger it. Returns { allowed, reason, why, risk }.
 * Every allowed in-repo write joins this session's ledger: `written` (whole session, which
 * is what risk is classified from, so risk only ratchets up) and `pending` (since the Stop
 * gate last settled, which is what the gate checks).
 * A write into a main checkout is denied before anything else, wherever the session runs:
 * judged by the target's own checkout, so a worktree session cannot write back into main.
 * A write to a secret path is denied first of all (doc 36 P1): Claude's `Edit(**\/.env*)` denies
 * cover it there, but Antigravity's write tools had no equivalent.
 * @param {{ sessionId: string, targetFile: string, cwd: string, content?: string, isMainCheckout?: (absPath: string) => boolean }} args
 */
export function evaluateWrite({ sessionId, targetFile, cwd, content, isMainCheckout = inMainCheckout }) {
    const top = gitTop(cwd) || cwd;
    const raw = String(targetFile ?? '');
    if (raw && isSecretPath(raw)) {
        return {
            allowed: false, why: 'secret path',
            reason: `${raw} is a secret file. Agents never read or write secrets (AGENTS.md §4 rule 7); `
                + '`.env.example` is the template. Ask the human to make this change.',
        };
    }
    if (raw && isMainCheckout(path.isAbsolute(raw) ? raw : path.resolve(top, raw))) {
        return { allowed: false, why: 'main checkout', reason: MAIN_CHECKOUT_REASON(raw) };
    }
    const rel = normalise(targetFile, top);
    if (!rel) return { allowed: true, why: 'outside the repo' };
    if (!safeId(sessionId)) return { allowed: true, why: 'no session id' };
    const state = { ...emptyState(), ...readState(sessionId) };
    if (needsResearch(rel, content) && !state.researchCaptured) {
        saveState(sessionId, { ...state, researchOwed: true });
        return {
            allowed: false,
            why: 'vendor or dependency path without research',
            reason:
                `${rel} is a vendor-integration or dependency path, so research comes first:\n` +
                '  1. npm run knowledge:search "<problem> <lib@version>"\n' +
                '  2. If cache miss: run 3 parallel searches, fill ResearchEntry\n' +
                `  3. npm run research:capture '<json>' --conv ${sessionId}`,
        };
    }
    const written = [...new Set([...state.written, rel])].slice(-LEDGER_MAX);
    const pending = [...new Set([...state.pending, rel])].slice(-LEDGER_MAX);
    const { route } = classify('', written, loadRouting(top));
    const risk = maxRisk(state.risk, route?.risk ?? 'R1');
    saveState(sessionId, { ...state, written, pending, risk, route: risk === state.risk ? state.route : route?.id ?? state.route });
    return { allowed: true, why: 'ledgered', risk };
}

function blockCountPath(sessionId) {
    return path.join(os.tmpdir(), `agy-stop-${safeId(sessionId)}.json`);
}

export function getBlockCount(sessionId) {
    if (!safeId(sessionId)) return 0;
    try { return JSON.parse(fs.readFileSync(blockCountPath(sessionId), 'utf8')).count || 0; }
    catch { return 0; }
}

export function incrementBlockCount(sessionId) {
    if (!safeId(sessionId)) return;
    try {
        fs.writeFileSync(blockCountPath(sessionId),
            JSON.stringify({ count: getBlockCount(sessionId) + 1, lastUpdated: Date.now() }));
    } catch { /* non-blocking */ }
}

export function resetBlockCount(sessionId) {
    if (!safeId(sessionId)) return;
    try { fs.rmSync(blockCountPath(sessionId), { force: true }); } catch { /* non-blocking */ }
}

/**
 * Default Stop gate: session-gate.mjs in a child process, at the repo root. A child, so a
 * test run or `tsc` can never hang or crash the hook process itself. A gate that cannot run
 * or answer is reported as deferred, never as a pass.
 */
export function runGateProcess(paths, root) {
    const top = gitTop(root) || root;
    const res = spawnSync(process.execPath, [path.join(top, 'scripts/agent-system/hooks/session-gate.mjs'), ...paths], {
        cwd: top, encoding: 'utf8', timeout: STOP_GATE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
    });
    try { return JSON.parse(String(res.stdout).trim().split('\n').pop()); }
    catch { return { ok: true, ran: [], failures: [], deferred: ['session gate could not run; gate:quick at push still will'] }; }
}

/**
 * Decide whether the agent may stop. Returns { block, reason, notice }. `notice` is shown to
 * the person when the agent stops anyway. Never blocks more than MAX_CONSECUTIVE_STOP_BLOCKS
 * times in a row (an unbounded loop burns credits); at the cap it lets the agent stop but
 * says UNVERIFIED, so a failed gate is never mistaken for done.
 * @param {{ sessionId: string, root?: string, runGate?: (paths: string[], root: string) => { ok: boolean, ran: string[], failures: { step: string, tail: string }[], deferred: string[], regenerated?: string[] } }} args
 * @returns {{ block: boolean, why: string, reason?: string, notice?: string }}
 */
export function evaluateStop(args) {
    const started = Date.now();
    const out = decideStop(args);
    // The scorecard counts these: how often Stop blocks, and how often it gives up UNVERIFIED.
    audit(args.root ?? process.cwd(), 'stop', { why: out.why, block: out.block, ms: Date.now() - started });
    return out;
}

function decideStop({ sessionId, root = process.cwd(), runGate = runGateProcess }) {
    const state = readState(sessionId);
    // Settled (passed, or gave up at the cap): stop re-checking until the next write, so
    // later question-only turns in the same session end for free.
    const settle = () => { if (state) saveState(sessionId, { ...state, pending: [], lastFailure: undefined }); };
    if (getBlockCount(sessionId) >= MAX_CONSECUTIVE_STOP_BLOCKS) {
        resetBlockCount(sessionId);
        settle();
        return {
            block: false,
            why: 'block cap reached',
            notice: `UNVERIFIED — gate failed (${state?.lastFailure ?? 'see the last block'}). ` +
                'Do not report this task as done; npm run gate:quick shows the failure.',
        };
    }
    if (!state?.pending?.length) return { block: false, why: 'nothing written since last settle' };
    const block = (why, lastFailure, reason) => {
        incrementBlockCount(sessionId);
        saveState(sessionId, { ...state, lastFailure });
        return { block: true, why, reason };
    };

    const gate = runGate(state.pending, root);
    const deferred = gate.deferred?.length ? gate.deferred.join('; ') : '';
    if (!gate.ok) {
        const steps = gate.failures.map((f) => f.step).join(', ');
        return block('gate failed', steps,
            `Blocked: ${steps} failed for the files this session wrote (${state.pending.length}). Fix the cause; ` +
            'never skip or loosen a test.\n\n' + gate.failures.map((f) => `── ${f.step}\n${f.tail}`).join('\n\n'));
    }
    // Derived docs drifted from what this session wrote and were regenerated (doc 36 S4). Block
    // once so they join the change: the next Stop finds them current and goes on.
    if (gate.regenerated?.length) {
        return block('docs regenerated', 'docs regenerated',
            'The Stop gate regenerated derived docs from the files this session wrote:\n'
            + gate.regenerated.map((r) => `- ${r}`).join('\n')
            + '\nReview them (git diff) and include them in this change\'s commit; generated output never ships stale.');
    }
    const res = spawnSync(process.execPath, [path.join(root, 'scripts/agent-system/check-evidence.mjs'), '--enforce'], {
        cwd: root, encoding: 'utf8', timeout: 25000,
    });
    if (res.status !== 0) {
        return block('evidence missing', 'evidence check',
            'Blocked: task completion halted because required evidence check failed.\n' +
            'Before stopping, produce and record required machine-checkable evidence (npm run evidence:record -- <id>).\n\n' +
            (res.stderr || res.stdout || 'evidence:check exited non-zero').trim());
    }
    resetBlockCount(sessionId);
    settle();
    return { block: false, why: 'gate and evidence current', ...(deferred && { notice: `Gate partly deferred: ${deferred}.` }) };
}

export async function readStdinJson() {
    let raw = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;
    try { return raw.trim() ? JSON.parse(raw) : {}; } catch { return null; }
}
