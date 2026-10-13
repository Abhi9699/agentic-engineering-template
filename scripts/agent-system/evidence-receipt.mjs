#!/usr/bin/env node
/**
 * Evidence receipts — the missing half of the evidence gate.
 *
 *   node scripts/agent-system/evidence-receipt.mjs record <evidence-id> [--artifact <path>] [--base <ref>]
 *   node scripts/agent-system/evidence-receipt.mjs verify <evidence-id> [--base <ref>]
 *
 * `--base <ref>` reads the change as `git diff <ref>` instead of `git status`, so a
 * branch whose work is already committed can still be reviewed and receipted. Without
 * it a clean tree "requires nothing" and the receipt cannot be recorded (2026-10-05:
 * the WO-1R review on feature/carousel-prod-ready had to call `record()` by hand).
 *
 * WHY THIS EXISTS. `check-evidence` could say what a change OWED, but never whether it
 * had been produced. Its own probe for `runtime-screenshot` returned the string
 * "driver available — screenshot must be captured for THIS change, not a previous one",
 * which is a reminder, not a check. So the gate could not be promoted to blocking:
 * there was nothing to block on.
 *
 * A receipt binds a piece of evidence to the CONTENT it attests to. It records the
 * sha256 of every file that triggered the requirement. If any of those files changes
 * afterwards, the receipt is stale and no longer counts — which is the only property
 * that makes this worth anything. A screenshot from before the last edit does not
 * show the code that is about to ship.
 *
 * WHAT A RECEIPT DOES NOT PROVE, stated plainly because the gate will read as stronger
 * than it is: that the screenshot showed the right screen, or that the eval output was
 * good. It proves the command was run against exactly this content, BY a named actor.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHO RAN IT (`actor`, added 2026-09-03)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Until this, no part of the evidence chain recorded an identity. Every `producer` in
 * `evidence.json` is a shell command, and this file's own note used to end "not that
 * anyone judged the result" — which was true and was the problem. `routing.json` declares
 * that `reviewer` verifies the money path, and nothing anywhere could tell whether the
 * implementer had produced its own sign-off. The separation existed in the manifest and
 * nowhere else.
 *
 * So a receipt now names its actor, and for the evidence types where independence is the
 * whole point the actor is CONSTRAINED — not by a new field, but by the `reviewerRole` the
 * evidence type already declares. Those are exactly the non-machine-checkable types:
 * `visual-taste-review`, `server-component-placement`, `zod-boundary-coverage`. A judgement
 * signed by the agent whose work is being judged is not a second opinion.
 *
 * MACHINE-CHECKABLE EVIDENCE IS DELIBERATELY UNCONSTRAINED. `npm test` does not become
 * more true because a different agent ran it — the command is the judge, and forcing a
 * second spawn to re-run a deterministic check would be ceremony that buys nothing. The
 * actor is still recorded there, because knowing who ran what is cheap and occasionally
 * decisive.
 *
 * This is enforcement of *attribution*, not of honesty: an actor string is self-reported.
 * It makes the separation visible and auditable, which is strictly more than the previous
 * state of not representing it at all.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { changedPaths, requiredEvidenceFor } from './check-evidence.mjs';

export const RECEIPT_DIR = '.evidence';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Content hash of one file, or null when it no longer exists. */
function hashFile(root, relativePath) {
    const absolute = path.join(root, relativePath);
    if (!existsSync(absolute)) return null;
    return sha256(readFileSync(absolute));
}

/** The files that triggered this evidence requirement, with their current hashes. */
export function coveredFiles(root, evidenceId, base = null, changed = changedPaths(root, base)) {
    const evidenceTypes = readJson(path.join(root, 'agent-system/evidence.json')).evidenceTypes;
    const required = requiredEvidenceFor(changed, evidenceTypes);
    const entry = required.find((r) => r.evidence.id === evidenceId);
    if (!entry) return null;
    const matchers = entry.evidence.changedPaths ?? [];
    const paths = changed.filter((p) => matchers.some((glob) => globMatch(glob, p)));
    return Object.fromEntries(paths.map((p) => [p, hashFile(root, p)]));
}

/** Same glob semantics check-evidence uses, kept local so the two cannot diverge silently. */
function globMatch(glob, candidate) {
    const source = '^' + glob.split('**')
        .map((s) => s.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
        .join('.*') + '$';
    return new RegExp(source).test(candidate);
}

/** The commit a review read, so a later delta review can diff from it. */
function headCommit(root) {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    } catch {
        return null;
    }
}

export function receiptPath(root, evidenceId) {
    return path.join(root, RECEIPT_DIR, `${evidenceId}.json`);
}

/**
 * Is this actor allowed to attest to this evidence type?
 *
 * Exported and pure so the rule is testable without touching the filesystem, and so
 * `verify` can re-apply it to a receipt that was written by an older version or by hand.
 *
 * @returns {string|null} the reason it is refused, or null when it is allowed
 */
export function actorProblem(actor, evidence, knownAgents) {
    if (!actor) {
        return 'no actor - a receipt with no author cannot show that the check was independent of the work';
    }
    const isHuman = actor.startsWith('human:');
    if (!isHuman && !knownAgents.includes(actor) && !evidence?.allowedActors?.includes(actor)) {
        return `unknown actor "${actor}" - expected an agent id from agents.json, or a "human:<role>" string`;
    }
    // Judgement types name the role that owns them. A judgement signed by the agent whose
    // work is being judged is not a second opinion.
    if (evidence?.allowedActors) {
        return isHuman || evidence.allowedActors.includes(actor)
            ? null
            : `evidence "${evidence.id}" may be signed only by ${evidence.allowedActors.join(' or ')} (or a human), not "${actor}"`;
    }
    if (evidence?.reviewerRole && actor !== evidence.reviewerRole && !isHuman) {
        return `evidence "${evidence.id}" is a judgement owned by "${evidence.reviewerRole}", but the receipt is signed by "${actor}" - the actor may not be its own critic`;
    }
    return null;
}

/**
 * Annotated because the defaults would otherwise infer `null` and reject every real
 * argument — `actor` is the whole point of this signature.
 *
 * @param {string} root
 * @param {string} evidenceId
 * @param {{ artifact?: string | null, base?: string | null, actor?: string | null, reviewFile?: string | null, verdict?: string | null }} [options]
 */
export function record(root, evidenceId, { artifact = null, base = null, actor = null, reviewFile = null, verdict = null } = {}) {
    // Actor first: a missing or ineligible actor is a usage error, and reporting
    // "nothing requires this" for a command that was also missing --actor sends the
    // caller to fix the wrong thing.
    const evidence = readJson(path.join(root, 'agent-system/evidence.json')).evidenceTypes
        .find((e) => e.id === evidenceId);
    const knownAgents = readJson(path.join(root, 'agent-system/agents.json')).agents.map((a) => a.id);
    const refusal = actorProblem(actor, evidence, knownAgents);
    if (refusal) return { ok: false, reason: refusal };
    // A cited review is recorded only by `npm run review:check`, after every claim in it was
    // checked against the code (scripts/agent-system/review.mjs). A bare record would be the
    // unchecked "looks good" that check exists to stop.
    if (evidence?.citedReview && !reviewFile) {
        return { ok: false, reason: `"${evidenceId}" is recorded by npm run review:check -- <review.md> --actor <id>, which checks every citation first` };
    }

    const covered = coveredFiles(root, evidenceId, base);
    if (covered === null) {
        return { ok: false, reason: `nothing in the current change requires "${evidenceId}" - a receipt would attest to nothing` };
    }

    mkdirSync(path.join(root, RECEIPT_DIR), { recursive: true });
    const receipt = {
        _note: 'Generated by scripts/agent-system/evidence-receipt.mjs. Proves a named actor ran a command against exactly this content; not that the result was good. The actor is self-reported.',
        evidenceId,
        actor,
        recordedAt: new Date().toISOString(),
        artifact,
        ...(reviewFile && { reviewFile: reviewFile.replaceAll('\\', '/'), head: headCommit(root), verdict }),
        covers: covered,
    };
    writeFileSync(receiptPath(root, evidenceId), `${JSON.stringify(receipt, null, 2)}\n`);
    return { ok: true, receipt, fileCount: Object.keys(covered).length };
}

/**
 * `changed` lets a caller verifying several receipts list the changed paths once:
 * `git status -uall` costs most of a second on a large Windows tree.
 *
 * @param {string} root
 * @param {string} evidenceId
 * @param {string | null} [base] the ref a branch-wide check diffs from; null checks the working tree
 * @param {string[]} [changed]
 * @returns {{ status: 'valid'|'missing'|'stale'|'not-required', detail: string }}
 */
export function verify(root, evidenceId, base = null, changed = changedPaths(root, base)) {
    const covered = coveredFiles(root, evidenceId, base, changed);
    if (covered === null) return { status: 'not-required', detail: 'no changed path triggers this evidence' };

    const file = receiptPath(root, evidenceId);
    if (!existsSync(file)) {
        return { status: 'missing', detail: `no receipt at ${RECEIPT_DIR}/${evidenceId}.json - produce the evidence, then record it` };
    }
    let receipt;
    try {
        receipt = readJson(file);
    } catch {
        return { status: 'stale', detail: 'receipt is unreadable - re-record it' };
    }

    const drifted = [];
    for (const [p, hash] of Object.entries(covered)) {
        if (receipt.covers?.[p] !== hash) drifted.push(p);
    }
    if (drifted.length) {
        return {
            status: 'stale',
            detail: `changed since the receipt: ${drifted.slice(0, 3).join(', ')}${drifted.length > 3 ? ` (+${drifted.length - 3})` : ''}`
                + ' - the evidence describes code that is no longer what will ship',
        };
    }
    /*
     * Re-applied on READ, not just on write. A receipt is a file on disk: it can predate
     * the actor rule, or be hand-edited to name a compliant actor after the fact. Checking
     * it here means the gate does not trust the artifact it is reading.
     */
    const evidence = readJson(path.join(root, 'agent-system/evidence.json')).evidenceTypes
        .find((e) => e.id === evidenceId);
    const knownAgents = readJson(path.join(root, 'agent-system/agents.json')).agents.map((a) => a.id);
    const refusal = actorProblem(receipt.actor, evidence, knownAgents);
    if (refusal) return { status: 'stale', detail: `${refusal} - re-record it with --actor` };
    if (evidence?.citedReview && !(receipt.reviewFile && existsSync(path.join(root, receipt.reviewFile)))) {
        return { status: 'stale', detail: 'no checked review file behind this receipt - record it with npm run review:check' };
    }
    // A BLOCK is recorded so the fix can be re-reviewed as a delta, but it never clears the gate.
    if (evidence?.citedReview && receipt.verdict !== 'PASS') {
        return { status: 'stale', detail: `the review's verdict is ${receipt.verdict ?? 'missing'} - fix the findings, then npm run review:pack -- --delta and review:check again` };
    }

    return { status: 'valid', detail: `recorded ${receipt.recordedAt} by ${receipt.actor}${receipt.artifact ? ` -> ${receipt.artifact}` : ''}` };
}

/** Every receipt on disk, so a stale directory can be reported rather than ignored. */
export function listReceipts(root) {
    const dir = path.join(root, RECEIPT_DIR);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}

/** The CLI's arguments: `<command> <evidence-id>` then `--artifact`, `--actor`, `--base` values. */
export function parseCliArgs(args) {
    const [command, evidenceId] = args;
    const value = (flag) => {
        const i = args.indexOf(flag);
        return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : null;
    };
    return { command, evidenceId, artifact: value('--artifact'), actor: value('--actor'), base: value('--base') };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const { command, evidenceId, artifact, actor, base } = parseCliArgs(process.argv.slice(2));

    if (!command || !evidenceId) {
        console.error('usage: evidence-receipt.mjs <record|verify> <evidence-id> --actor <agent-id|human:role> [--artifact <path>] [--base <ref>]');
        process.exit(2);
    }

    if (command === 'record') {
        const result = record(process.cwd(), evidenceId, { artifact, actor, base });
        if (!result.ok) {
            console.error(`evidence-receipt: ${result.reason}`);
            process.exit(1);
        }
        console.log(`recorded ${evidenceId} by ${actor} over ${result.fileCount} file(s) -> ${RECEIPT_DIR}/${evidenceId}.json`);
        process.exit(0);
    }

    if (command === 'verify') {
        const { status, detail } = verify(process.cwd(), evidenceId, base);
        console.log(`${evidenceId}: ${status} - ${detail}`);
        process.exit(status === 'valid' || status === 'not-required' ? 0 : 1);
    }

    console.error(`evidence-receipt: unknown command "${command}"`);
    process.exit(2);
}
