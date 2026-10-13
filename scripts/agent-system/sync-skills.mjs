#!/usr/bin/env node
/**
 * Skill integrity verification and lock generation (A2 — AA-GAP-05, AA-GAP-11).
 *
 *   node scripts/agent-system/sync-skills.mjs           verify; exit 1 on drift
 *   node scripts/agent-system/sync-skills.mjs --write    recompute pins + regenerate the lock
 *   node scripts/agent-system/sync-skills.mjs --json     machine-readable result
 *
 * ONE REGISTRY, NOT TWO. `agent-system/skills.json` is the authority. `skills-lock.json`
 * is regenerated FROM it as compatibility output for existing tooling, and carries a
 * generated header. Before A2 both were hand-writable, which is how the lock drifted
 * into an unverifiable state without anyone noticing.
 *
 * WHAT VERIFICATION CAN AND CANNOT TELL YOU. A matching hash proves the bytes on this
 * machine are the bytes that were pinned. It does NOT prove the pinned bytes were ever
 * safe, nor that upstream has not changed. Provenance review is a human act; this only
 * makes tampering and accidental edits visible.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ALGORITHM_ID, hashSkillDirectory } from './skill-hash.mjs';

const SKILLS_DIR = '.agents/skills';
const MANIFEST = 'agent-system/skills.json';
const LOCK = 'skills-lock.json';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** Compare every manifest skill against the bytes on disk. */
export function verifySkills(root = process.cwd()) {
    const manifest = readJson(path.join(root, MANIFEST));
    const findings = [];
    const computed = new Map();

    const present = existsSync(path.join(root, SKILLS_DIR))
        ? new Set(readdirSync(path.join(root, SKILLS_DIR)).filter((n) => statSync(path.join(root, SKILLS_DIR, n)).isDirectory()))
        : new Set();

    for (const skill of manifest.skills) {
        const dir = path.join(root, SKILLS_DIR, skill.id);
        if (!present.has(skill.id)) {
            // Absence means different things depending on provenance, and conflating
            // them is what AA-GAP-05 is about:
            //   - quarantined      → absence is the desired end state
            //   - lock-listed      → .gitignore excludes these, so a CLEAN CHECKOUT
            //                        legitimately lacks them. That is a capability gap
            //                        to report, not an integrity failure to fail on;
            //                        no fetch step exists yet (A2 deferred it).
            //   - tracked          → these are committed, so absence is a real error.
            if (skill.status === 'quarantined') continue;
            // provider-native → the PROVIDER ships it (a Claude plugin or built-in).
            // There are no bytes in this repository to hash and none to install, so
            // absence here is the permanent, correct state. It is registered anyway so
            // that prose naming it is checkable and so `availableOn` can tell an agent
            // on another provider not to go looking. Registration is not verification:
            // nothing in this repo can attest to what a provider-shipped skill contains.
            if (skill.provenance === 'provider-native') {
                findings.push({
                    skill: skill.id,
                    kind: 'provider-native',
                    severity: 'info',
                    detail: `shipped by ${(skill.availableOn ?? ['every provider']).join(', ')}; nothing in this repository can materialize, pin or verify it`,
                });
                continue;
            }
            if (skill.provenance === 'lock-listed-external') {
                findings.push({
                    skill: skill.id,
                    kind: 'not-materialized',
                    severity: 'info',
                    detail: 'pinned but not present; expected on a clean checkout because .gitignore excludes it. Install it to use the capability.',
                });
                continue;
            }
            findings.push({ skill: skill.id, kind: 'missing', severity: 'error', detail: 'tracked in git but absent from the working tree' });
            continue;
        }

        if (skill.provenance === 'tracked-first-party') {
            try {
                const res = spawnSync('git', ['check-ignore', '-q', path.join(SKILLS_DIR, skill.id)], { cwd: root });
                if (res.status === 0) {
                    findings.push({
                        skill: skill.id,
                        kind: 'gitignored-tracked',
                        severity: 'error',
                        detail: `marked tracked-first-party but ignored by .gitignore — add !${SKILLS_DIR}/${skill.id}/ to .gitignore`,
                    });
                }
            } catch {
                // git unavailable, continue
            }
        }

        const { hash, fileCount } = hashSkillDirectory(dir);
        computed.set(skill.id, { hash, fileCount });
        if (skill.integrity) {
            if (skill.integrity.algorithm !== ALGORITHM_ID) {
                findings.push({ skill: skill.id, kind: 'algorithm-mismatch', severity: 'error', detail: `pinned with ${skill.integrity.algorithm}, this tool computes ${ALGORITHM_ID}; regenerate with --write` });
            } else if (skill.integrity.hash !== hash) {
                findings.push({ skill: skill.id, kind: 'hash-mismatch', severity: 'error', detail: `pinned ${skill.integrity.hash.slice(0, 16)}… but the working tree hashes ${hash.slice(0, 16)}…` });
            }
        } else if (skill.status !== 'quarantined') {
            findings.push({ skill: skill.id, kind: 'unpinned', severity: 'error', detail: 'materialized and active but carries no integrity pin' });
        }
    }

    for (const id of present) {
        if (!manifest.skills.some((s) => s.id === id)) {
            findings.push({ skill: id, kind: 'unregistered', severity: 'error', detail: 'present on disk but absent from the manifest — quarantine or register it' });
        }
    }
    return { manifest, findings, computed };
}

/** Recompute pins into the manifest and regenerate the compatibility lock. */
export function writeSkills(root = process.cwd()) {
    const { manifest, computed } = verifySkills(root);
    let pinned = 0;
    for (const skill of manifest.skills) {
        const c = computed.get(skill.id);
        // An absent skill keeps its pin. External skills are gitignored, so every worktree and
        // CI lacks them; deleting the pin here meant one --write from a clean checkout wiped
        // them all (ad0191cc, 2026-10-03), and the next checkout that has them failed unpinned.
        if (!c) continue;
        skill.integrity = { algorithm: ALGORITHM_ID, hash: c.hash, fileCount: c.fileCount };
        skill.hashVerifiable = true;
        pinned++;
    }
    writeFileSync(path.join(root, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');

    // Regenerated compatibility output. Never hand-edit; edit agent-system/skills.json.
    const lock = {
        _generated: `DO NOT EDIT. Generated from ${MANIFEST} by scripts/agent-system/sync-skills.mjs. Run \`npm run skills:sync -- --write\` after changing a skill.`,
        version: 2,
        algorithm: ALGORITHM_ID,
        skills: {},
    };
    for (const skill of manifest.skills) {
        if (skill.provenance !== 'lock-listed-external') continue;
        lock.skills[skill.id] = {
            source: skill.source ?? 'unknown',
            provenance: skill.provenance,
            status: skill.status,
            integrity: skill.integrity ?? null,
        };
    }
    writeFileSync(path.join(root, LOCK), JSON.stringify(lock, null, 2) + '\n');
    return { pinned, lockEntries: Object.keys(lock.skills).length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    if (process.argv.includes('--write')) {
        const { pinned, lockEntries } = writeSkills();
        console.log(`sync-skills --write OK — pinned ${pinned} skill(s) with ${ALGORITHM_ID}; regenerated ${LOCK} (${lockEntries} external entries).`);
        process.exit(0);
    }
    const { findings } = verifySkills();
    const blocking = findings.filter((f) => f.severity !== 'info');
    const informational = findings.filter((f) => f.severity === 'info');
    if (process.argv.includes('--json')) {
        console.log(JSON.stringify({ algorithm: ALGORITHM_ID, findings }, null, 2));
        process.exit(blocking.length ? 1 : 0);
    }
    if (informational.length) {
        console.log(`sync-skills — ${informational.length} capability gap(s), not failures:`);
        for (const f of informational) console.log(`  · [${f.kind}] ${f.skill}: ${f.detail}`);
    }
    if (blocking.length) {
        console.error(`\nsync-skills — ${blocking.length} integrity finding(s):\n`);
        for (const f of blocking) console.error(`  • [${f.kind}] ${f.skill}: ${f.detail}`);
        console.error('\nIf the change was intentional, re-pin with: npm run skills:sync -- --write');
        process.exit(1);
    }
    console.log(`sync-skills OK — every materialized skill matches its pin (${ALGORITHM_ID}).`);
}
