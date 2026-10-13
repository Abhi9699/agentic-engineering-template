#!/usr/bin/env node
/**
 * check:tokens — Tier-1 token gate (doc 22 §7 step 1, universal per §0.1).
 * Runs in pre-commit, `npm run gate`, and CI for every tool + human.
 *
 *   node scripts/check-tokens.mjs                    scan; exit 1 on blocking findings
 *   node scripts/check-tokens.mjs --update-baseline  re-freeze the ratchet — only
 *                                                    after paying debt DOWN, never
 *                                                    to admit new violations
 *
 * BLOCK (no ratchet): R5 scoped-token — a var() whose token app/globals.css
 *   defines only under a non-root selector (every `--lp-*` lives under
 *   `.landing-theme`). Outside that selector it resolves to nothing and the
 *   declaration becomes `unset`, silently overriding the cascade beneath it.
 *
 * BLOCK (ratcheted — frozen debt may only shrink):
 *   R1 undefined-token: var(--x) defined nowhere → the declaration silently
 *      drops at runtime (the invisible-defect bug class). Vendor runtime
 *      tokens (--radix-*) are exempt.
 *   R2 raw-hex: hex belongs in app/globals.css as a token; CSS Modules use
 *      var(--…). Escape hatch: trailing `allow-hex <reason>` comment.
 *   R3 off-scale spacing: px spacing off the grid. Promoted from WARN to BLOCK on
 *      2026-08-29. It had been advisory since it was written, and advisory is why 6
 *      off-scale values accumulated across 6 files while raw hex - ratcheted from the
 *      start - stayed at zero. Same ratchet as R1/R2: the existing 6 are frozen as
 *      debt and may only shrink; anything NEW blocks.
 */
import { readFileSync, writeFileSync, existsSync, globSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
    parseDefinedTokens,
    findUndefinedVarRefs,
    findRawHex,
    findOffScaleSpacing,
    scopedTokens,
    findScopedVarRefs,
    ratchetCounts,
    diffAgainstBaseline,
    growthAgainstBaseline,
} from './lib/token-checks.mjs';

const GLOBALS = 'app/globals.css';
const BASELINE = 'scripts/token-baseline.json';

function moduleFiles() {
    return [...globSync('components/**/*.module.css'), ...globSync('app/**/*.module.css')]
        .map((p) => p.replaceAll('\\', '/'))
        .sort();
}

function report(newViolations, header, hint) {
    console.error(`\ncheck:tokens — ${header} [BLOCK]:`);
    for (const v of newViolations) {
        const [file, ident] = v.key.split('|');
        console.error(`  ${file}: ${ident} ×${v.count} (baseline allows ${v.allowed}) — ${hint}`);
    }
}

/**
 * R4 — white text may not sit on `--lp-grad`. BLOCKING, no ratchet.
 *
 * WHY (2026-08-29): `--lp-grad` is #7c5cff -> #22d3ee. White on it measures
 * 4.35:1 at the violet end, 2.93:1 at the midpoint and 1.81:1 at the cyan end.
 * It fails WCAG AA (4.5:1) across the ENTIRE ramp and is close to unreadable on
 * the cyan half. Nine controls shipped that way, including the cookie-consent
 * "Accept all" button, which renders on every page of the site.
 *
 * `--gradient-brand-strong` (#6D4CFF -> #0E7490) is the accessible pairing at
 * 5.09 / 5.66 / 5.36, and is what every app-page control already uses: a solid
 * `background-color` base plus a `background-image` gradient, so the gradient has
 * a readable fallback and a contrast checker reads a real colour rather than
 * transparent. Convention documented in app/globals.css.
 *
 * WHY THIS BLOCKS AND critique DOES NOT: critique measured this correctly and
 * flagged it on all 17 page/width/theme combinations — but critique is ADVISORY
 * and needs a running server, so the finding sat unread. A measurement nobody is
 * obliged to act on is not a gate.
 *
 * MATCHES BOTH `background:` AND `background-image:`. The first version matched only
 * the shorthand, and writing the identical defect as `background-image: var(--lp-grad)`
 * passed clean — verified by planting it. A gate you have only watched fail one way is
 * a gate you have only half tested (L-031).
 *
 * Decorative `--lp-grad` (dividers, glows, background-clip:text) is deliberately
 * untouched. The Aurora Noir identity is not the defect; unreadable text is.
 */
function findWhiteOnLpGrad(text) {
    const lines = text.split(/\r?\n/);
    const out = [];
    lines.forEach((line, i) => {
        if (!/^\s*background(-image)?:\s*var\(--lp-grad\)/.test(line)) return;
        const rest = lines.slice(i + 1, i + 7).join('\n');
        if (/color:\s*var\(--color-on-gradient\)/.test(rest) && !/background-clip/.test(rest)) {
            out.push({ line: i + 1 });
        }
    });
    return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const update = process.argv.includes('--update-baseline');
    if (!existsSync(GLOBALS)) {
        if (moduleFiles().length === 0) {
            console.log('check:tokens OK - no CSS modules found; token check skipped.');
            process.exit(0);
        }
        console.error("check:tokens - " + GLOBALS + " not found");
        process.exit(1);
    }
    const globalsCss = readFileSync(GLOBALS, 'utf8');
    const globalTokens = parseDefinedTokens(globalsCss);
    const scoped = scopedTokens(globalsCss);

    /** @type {Record<string, Array<{line:number,token:string}>>} */
    const undefByFile = {};
    /** @type {Record<string, Array<{line:number,value:string}>>} */
    const hexByFile = {};
    /** @type {Record<string, Array<{line:number,value:string}>>} */
    const spacingByFile = {};
    const warns = [];
    /** @type {string[]} */
    const contrastFails = [];
    /** @type {string[]} */
    const scopeFails = [];

    for (const file of moduleFiles()) {
        const text = readFileSync(file, 'utf8');
        const un = findUndefinedVarRefs(text, globalTokens);
        if (un.length) undefByFile[file] = un;
        const hex = findRawHex(text);
        if (hex.length) hexByFile[file] = hex;
        const spacing = findOffScaleSpacing(text);
        if (spacing.length) spacingByFile[file] = spacing;
        for (const w of spacing) warns.push(`${file}:${w.line}  ${w.value} off the 4px scale`);
        for (const c of findWhiteOnLpGrad(text)) contrastFails.push(`${file}:${c.line}`);
        for (const sc of findScopedVarRefs(text, scoped, file)) {
            scopeFails.push(`${file}:${sc.line}  var(${sc.token}) — defined only under \`${sc.scope}\``);
        }
    }

    const current = {
        undefined: ratchetCounts(undefByFile, 'token'),
        hex: ratchetCounts(hexByFile, 'value'),
        spacing: ratchetCounts(spacingByFile, 'value'),
    };

    if (update) {
        /*
         * A re-freeze must be a PAYDOWN. `--update-baseline` writes whatever the tree
         * currently holds, so without this an agent that added debt, hit the block and
         * reached for this flag would launder its own violation into the frozen
         * baseline — and every run afterwards would report OK. Refused, not warned:
         * a warning here is the same honour system with extra steps.
         */
        const frozen = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
        const grown = [
            ...growthAgainstBaseline(current.undefined, frozen.undefined ?? {}).map((g) => ({ ...g, bucket: 'undefined' })),
            ...growthAgainstBaseline(current.hex, frozen.hex ?? {}).map((g) => ({ ...g, bucket: 'hex' })),
            ...growthAgainstBaseline(current.spacing, frozen.spacing ?? {}).map((g) => ({ ...g, bucket: 'spacing' })),
        ];
        if (grown.length) {
            console.error('\ncheck:tokens --update-baseline REFUSED — this would GROW the frozen debt:');
            for (const g of grown) {
                const [file, ident] = g.key.split('|');
                console.error(`  [${g.bucket}] ${file}: ${ident} ${g.from} -> ${g.to}`);
            }
            console.error('\n  The baseline may only shrink. Fix the violation instead of freezing it.');
            console.error('  If the debt is genuinely unavoidable, it needs a decision and a comment, not a re-freeze.');
            process.exit(1);
        }
        const sort = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
        writeFileSync(
            BASELINE,
            JSON.stringify(
                {
                    $comment:
                        'Token-debt ratchet (doc 22 §7 step 1). Every entry is REAL debt: `undefined` = var() refs to tokens that do not exist (the declaration silently drops — fix by defining the token in app/globals.css WITH visual verification); `hex` = raw hex that should be a token. This file may only SHRINK. Never add to it to admit new debt; new violations block. Re-freeze after paying down: node scripts/check-tokens.mjs --update-baseline',
                    undefined: sort(current.undefined),
                    hex: sort(current.hex),
                    spacing: sort(current.spacing),
                },
                null,
                2,
            ) + '\n',
        );
        console.log(
            `check:tokens — baseline frozen: ${Object.keys(current.undefined).length} undefined-token + ${Object.keys(current.hex).length} raw-hex debt entries.`,
        );
        process.exit(0);
    }

    const stored = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
    const baseUndef = stored.undefined ?? {};
    const baseHex = stored.hex ?? {};
    const baseSpacing = stored.spacing ?? {};

    const dUndef = diffAgainstBaseline(current.undefined, baseUndef);
    const dHex = diffAgainstBaseline(current.hex, baseHex);
    const dSpacing = diffAgainstBaseline(current.spacing, baseSpacing);

    let failed = false;
    if (contrastFails.length) {
        failed = true;
        console.error('\ncheck:tokens — white text on --lp-grad [BLOCK]:');
        for (const c of contrastFails) {
            console.error(`  ${c}  white on --lp-grad measures 1.81-4.35:1, below the 4.5 AA floor`);
        }
        console.error('  Use the accessible pairing every app-page control already uses:');
        console.error('    background-color: var(--gradient-brand-strong-base);');
        console.error('    background-image: var(--gradient-brand-strong);');
    }
    if (scopeFails.length) {
        failed = true;
        console.error('\ncheck:tokens — out-of-scope token reference(s) [BLOCK]:');
        for (const f of scopeFails) console.error(`  ${f}`);
        console.error('  These resolve to NOTHING outside their selector, which makes the whole');
        console.error('  declaration invalid-at-computed-value-time: the property is set to `unset`,');
        console.error('  overriding the cascade beneath it rather than falling back to it.');
        console.error('  Use the app token instead, or render the file inside that selector.');
    }
    if (dUndef.newViolations.length) {
        failed = true;
        report(dUndef.newViolations, 'new undefined token reference(s)', `define the token in ${GLOBALS} (or fix the name)`);
    }
    if (dHex.newViolations.length) {
        failed = true;
        report(dHex.newViolations, 'new raw hex in CSS Modules', 'make it a token or add `allow-hex <reason>`');
    }
    if (dSpacing.newViolations.length) {
        failed = true;
        report(dSpacing.newViolations, 'new off-scale spacing', 'use a multiple of the grid, or state why in a comment');
    }
    const paid = dUndef.paidDown.length + dHex.paidDown.length + dSpacing.paidDown.length;
    if (paid) {
        console.log(`\n[ratchet] ${paid} baseline entr(ies) no longer reproduce — debt paid down. Shrink with: node scripts/check-tokens.mjs --update-baseline`);
    }
    if (warns.length) {
        console.log(`\ncheck:tokens — ${warns.length} warning(s) [off-scale spacing, non-blocking]${warns.length > 10 ? ' (first 10)' : ''}:`);
        for (const w of warns.slice(0, 10)) console.log(`  ${w}`);
    }
    if (failed) process.exit(1);
    const debt = Object.keys(baseUndef).length + Object.keys(baseHex).length + Object.keys(baseSpacing).length;
    console.log(
        `check:tokens OK — ${moduleFiles().length} modules, ${globalTokens.size} tokens, 0 new violations (${debt} frozen debt entries to burn down), ${warns.length} warning(s).`,
    );
}
