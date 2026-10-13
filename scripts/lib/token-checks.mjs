/**
 * Design-token checks (doc 22 §7 step 1 — Tier-1 Constrain).
 *
 * Pure functions consumed by scripts/check-tokens.mjs (CLI; pre-commit, gate,
 * CI — universal per doc 22 §0.1) and unit-tested in
 * scripts/__tests__/token-checks.test.ts.
 *
 * Rules:
 *  R1 undefined-token (BLOCK): `var(--x)` in a CSS Module must resolve to a
 *     custom property defined in app/globals.css or in the same module file.
 *     An undefined token silently drops the declaration at runtime — the
 *     invisible-text class of bug.
 *  R2 raw-hex (BLOCK, ratcheted): hex colors belong in app/globals.css as
 *     tokens; CSS Modules must use var(--…). Includes colours baked into an
 *     inline SVG data URI, which cannot read a var() and so never flip. Existing debt is frozen in
 *     scripts/token-baseline.json and may only shrink. Escape hatch for a
 *     deliberate exception: trailing `/* allow-hex <reason> *​/` on the line.
 *  R3 off-scale-spacing (WARN): px spacing not on the 4px grid.
 *  R5 scoped-token (BLOCK, no ratchet): a `var(--x)` where --x is defined in
 *     app/globals.css ONLY under a non-root selector — reaching for it from a
 *     file that does not render inside that selector resolves to nothing. See
 *     `findScopedVarRefs`.
 */

/** All custom-property names defined in a CSS text (any selector block). */
export function parseDefinedTokens(cssText) {
    const out = new Set();
    for (const m of cssText.matchAll(/(?:^|[\s;{])(--[a-z0-9-]+)\s*:/gi)) out.add(m[1]);
    return out;
}

/**
 * Custom properties injected at runtime — defined on the element by JS/the
 * framework, so no CSS definition exists to find. Never flag these:
 *  - `--radix-*`     Radix UI sets these on the popover/tooltip content element.
 *  - next/font vars  `--font-display|--font-body|--font-mono` are set on <html>
 *                    by next/font (app/layout.tsx `variable:` config).
 */
export const VENDOR_TOKEN_PREFIXES = ['--radix-'];
export const RUNTIME_TOKENS = new Set(['--font-display', '--font-body', '--font-mono']);

/** var(--x) references whose token is in neither `globalTokens` nor the file's own defs. */
export function findUndefinedVarRefs(cssText, globalTokens) {
    const local = parseDefinedTokens(cssText);
    const hits = [];
    const lines = cssText.split('\n');
    lines.forEach((line, i) => {
        for (const m of line.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
            const name = m[1];
            if (VENDOR_TOKEN_PREFIXES.some((p) => name.startsWith(p))) continue;
            if (RUNTIME_TOKENS.has(name)) continue;
            if (!globalTokens.has(name) && !local.has(name)) {
                hits.push({ line: i + 1, token: name });
            }
        }
    });
    return hits;
}

/**
 * Colours baked into an inline SVG data URI.
 *
 * `findRawHex` blanks `url(...)` payloads wholesale, because a base64 or path
 * payload is full of hex-looking runs that are not colours. That blanket
 * exemption hid a real theme bug: settings.module.css drew the select chevron
 * from a data URI with `stroke='%236b7280'` baked in. A data URI cannot read a
 * var(), so that grey was identical in light and dark — and no gate could see
 * it: R2 skipped the payload and R5 found no var() to check.
 *
 * So SVG payloads are scanned after all, for the two forms a colour takes
 * there: a percent-encoded (or literal) hex, and a named colour on a
 * fill/stroke attribute. Base64 payloads stay exempt — they are opaque, and a
 * false positive on one would be unfixable without decoding it.
 */
export function findDataUriColors(line) {
    const hits = [];
    for (const m of line.matchAll(/url\(([^)]*)\)/g)) {
        const payload = m[1];
        if (!/^["']?data:image\/svg\+xml/i.test(payload.trim())) continue;
        if (/;base64,/i.test(payload)) continue;
        /*
         * `(?<!url\()` — inside an SVG, `url(%23gradientId)` is a reference to
         * another element, not a colour. An id made only of hex characters
         * would otherwise read as one. Lengths are the four legal hex forms,
         * anchored so `%23abcdefgh` does not match its first six characters.
         */
        for (const c of payload.matchAll(/(?<!url\()(?:%23|#)([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z])/g)) {
            hits.push(`#${c[1]}`);
        }
        /*
         * `(?!\()` rules out `fill='url(#grad)'`, which names a paint server
         * rather than a colour — without it, every gradient reference in an
         * inline SVG reads as a named colour called "url".
         */
        for (const c of payload.matchAll(/\b(?:fill|stroke|stop-color)\s*(?:=|%3D)\s*['"%2]*\s*([a-z]{3,20})(?![0-9a-z(])/gi)) {
            const v = c[1].toLowerCase();
            if (!['none', 'transparent', 'currentcolor', 'inherit', 'url'].includes(v)) hits.push(v);
        }
    }
    return hits;
}

/** Raw hex or raw rgb/rgba/hsl color literals outside globals.css. Honors a trailing `allow-hex` comment. */
export function findRawHex(cssText) {
    const hits = [];
    cssText.split('\n').forEach((line, i) => {
        if (/allow-hex|allow-color/.test(line)) return;
        for (const v of findDataUriColors(line)) hits.push({ line: i + 1, value: `data-uri ${v}` });
        // strip url(...) payloads (data URIs legitimately contain hex-like runs)
        const cleaned = line.replace(/url\([^)]*\)/g, 'url()');
        for (const m of cleaned.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(\s*\d+|\bhsla?\s*\(\s*\d+/g)) {
            hits.push({ line: i + 1, value: m[0] });
        }
    });
    return hits;
}

/** px values in spacing props off the 4px grid (warn-only). 1px is allowed (borders/hairlines). */
export function findOffScaleSpacing(cssText) {
    const hits = [];
    // Match each spacing declaration wherever it sits on the line and scan only
    // its value segment — so `width: 10px` sharing a line never false-positives.
    const decl = /(?:^|[{;\s])(?:padding|margin|gap|row-gap|column-gap|top|right|bottom|left|inset)(?:-[a-z-]+)?\s*:\s*([^;}]*)/gi;
    cssText.split('\n').forEach((line, i) => {
        for (const d of line.matchAll(decl)) {
            for (const m of d[1].matchAll(/(\d+)px/g)) {
                const v = Number(m[1]);
                /*
                 * 2px, not 4px (Task R11 step 2, decided 2026-07-26).
                 *
                 * The 4px rule produced 257 standing warnings — and 222 of them
                 * (87%) were 2px half-steps: 6, 10, 14, 18, 22, 26, 30, 34.
                 * That is not 222 mistakes, it is a system: 4px for layout
                 * rhythm, 2px half-steps for micro-spacing inside controls
                 * (chip padding, icon gaps, badge insets), where a 4px jump is
                 * visibly coarse. A rule that 87% of the codebase deliberately
                 * violates is not enforcing anything — it is training everyone
                 * to scroll past warnings, which is precisely the dynamic that
                 * let the R5 colour debt accumulate unseen.
                 *
                 * So the scale now matches the system actually in use, and the
                 * ~35 genuinely arbitrary values (3, 5, 7, 9, 13, 15px) became
                 * real findings and were fixed.
                 */
                if (v > 1 && v % 2 !== 0) hits.push({ line: i + 1, value: `${v}px` });
            }
        }
    });
    return hits;
}

/**
 * R5 — scoped-token leakage. BLOCKING, no ratchet.
 *
 * WHY (2026-09-02): `parseDefinedTokens` reads app/globals.css as flat text and
 * records every `--x:` it sees, whatever selector it sits under. All ~90
 * `--lp-*` tokens are defined under `.landing-theme`, so an app-side
 * `var(--lp-cyan)` counted as "defined" and R1 passed it — while at runtime it
 * resolves to nothing.
 *
 * That is not a no-op. A `var()` that resolves to nothing makes the declaration
 * INVALID AT COMPUTED-VALUE TIME, and per CSS Variables §3 the property is then
 * set to `unset` — it does NOT fall back to an earlier declaration. So the
 * broken rule actively overrides the cascade beneath it. Measured on /settings:
 * the globally-mounted cookie banner lost its elevation (`box-shadow: none`),
 * both hover states, and — because `.closeBtn:focus-visible` outranks the
 * global `:focus-visible` and then unset itself — its entire keyboard focus
 * ring, while `:focus-visible` still matched. A WCAG 2.4.7 failure on every
 * authenticated route, invisible to `check:tokens`, `lint`, `tsc` and
 * `critique` alike.
 *
 * A selector counts as GLOBAL if it targets the document root, since those
 * tokens are in scope everywhere: `:root`, `html`, `body`, `*`, and the
 * next-themes classes `.dark` / `.light` that live on <html>.
 */

/** Selector fragments that put a token in scope for the whole document. */
const GLOBAL_SCOPE_PATTERNS = [/(^|[\s,>+~])(:root|html|body|\*)\b/i, /(^|[\s,>+~])\.(dark|light)\b/];

const isGlobalSelector = (sel) => GLOBAL_SCOPE_PATTERNS.some((re) => re.test(sel));

/**
 * Map every custom property in a stylesheet to the selectors that define it.
 * Walks brace depth so nesting and at-rules (`@media`, `@supports`) are handled:
 * an at-rule does not change the selector context, so it pushes a null frame.
 */
export function parseTokenScopes(cssText) {
    /** @type {Map<string, Set<string>>} */
    const scopes = new Map();
    /** @type {(string|null)[]} */
    const stack = [];
    let prelude = '';

    for (let i = 0; i < cssText.length; i++) {
        const ch = cssText[i];
        if (ch === '/' && cssText[i + 1] === '*') {
            const end = cssText.indexOf('*/', i + 2);
            i = end === -1 ? cssText.length : end + 1;
            continue;
        }
        if (ch === '{') {
            const sel = prelude.trim().replace(/\s+/g, ' ');
            stack.push(sel.startsWith('@') ? null : sel);
            prelude = '';
            continue;
        }
        if (ch === '}') {
            stack.pop();
            prelude = '';
            continue;
        }
        if (ch === ';') {
            prelude = '';
            continue;
        }
        if (ch === '-' && cssText[i + 1] === '-') {
            const m = /^(--[a-z0-9-]+)\s*:/i.exec(cssText.slice(i));
            // A definition, not a var() reference: only a declaration has the
            // property name at the start of the current prelude.
            if (m && !/var\(\s*$/.test(prelude.slice(-6)) && prelude.trim() === '') {
                const owner = [...stack].reverse().find((s) => s !== null) ?? ':root';
                if (!scopes.has(m[1])) scopes.set(m[1], new Set());
                scopes.get(m[1]).add(owner);
                i += m[0].length - 1;
                prelude = '';
                continue;
            }
        }
        prelude += ch;
    }
    return scopes;
}

/** Tokens with at least one definition, none of which is document-global. */
export function scopedTokens(cssText) {
    /** @type {Map<string, string[]>} */
    const out = new Map();
    for (const [token, sels] of parseTokenScopes(cssText)) {
        const all = [...sels];
        if (!all.some(isGlobalSelector)) out.set(token, all);
    }
    return out;
}

/**
 * Which files may legitimately reach for a scoped token, keyed by the selector
 * that scopes it. Path prefixes, matched against forward-slash repo paths.
 *
 * `.landing-theme` is applied by components/landing/landing-page-content.tsx and
 * components/marketing/marketing-shell.tsx, so anything rendered *inside* those
 * two is in scope. Note the file-level entry for the legal directory: the legal
 * PAGES render inside marketing-shell, but legal/cookie-banner.module.css is
 * mounted from app/layout.tsx on EVERY route including the authenticated app —
 * which is exactly the bug this rule exists to catch, so it is not listed.
 */
export const SCOPED_TOKEN_ALLOW = {
    '.landing-theme': [
        'components/landing/',
        'components/marketing/',
        'components/features-marketing/',
        'components/compare/',
        'components/faq/',
        'components/pricing/',
        'components/legal/legal.module.css',
    ],
};

/**
 * `var(--x)` references to tokens that are out of scope in this file.
 * `scoped` is the Map from `scopedTokens(globalsCss)`; `filePath` uses forward
 * slashes. A token the file defines itself is its own business and is skipped.
 */
export function findScopedVarRefs(cssText, scoped, filePath) {
    const local = parseDefinedTokens(cssText);
    const hits = [];
    cssText.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
            const token = m[1];
            if (local.has(token) || !scoped.has(token)) continue;
            const selectors = scoped.get(token);
            const allowed = selectors.every((sel) =>
                (SCOPED_TOKEN_ALLOW[sel] ?? []).some((prefix) => filePath.startsWith(prefix)),
            );
            if (!allowed) hits.push({ line: i + 1, token, scope: selectors.join(', ') });
        }
    });
    return hits;
}

/**
 * Ratchet keys: file + stable identity (line numbers shift; file+value+count
 * only ever shrinks). `field` picks the identity: 'value' (hex) or 'token'
 * (undefined refs).
 */
export function ratchetCounts(findingsByFile, field = 'value') {
    /** @type {Record<string, number>} */
    const counts = {};
    for (const [file, hits] of Object.entries(findingsByFile)) {
        for (const h of hits) {
            const key = `${file}|${String(h[field]).toLowerCase()}`;
            counts[key] = (counts[key] ?? 0) + 1;
        }
    }
    return counts;
}

/**
 * Entries a proposed re-freeze would GROW.
 *
 * WHY THIS EXISTS (2026-09-03). The ratchet's whole contract is "this file may only
 * SHRINK", and `--update-baseline` re-freezes to whatever the tree currently contains.
 * Those two facts together mean the contract was honour-system sitting on top of a
 * ratchet: an agent that introduced new debt, hit the block, and reached for
 * `--update-baseline` "to make the gate pass" would launder its own violation into the
 * frozen baseline, and every later run would report OK. The script's comment forbade
 * it; nothing refused it.
 *
 * A ratchet that can be re-cut in the other direction is a ratchet in name only, so
 * the re-freeze now has to prove it is a paydown. Growth is refused outright rather
 * than warned about — a warning here is the same honour system with extra steps.
 *
 * @returns {Array<{key: string, from: number, to: number}>} empty when the re-freeze
 *          only shrinks or holds, which is the only shape allowed to be written.
 */
export function growthAgainstBaseline(current, baseline) {
    const grown = [];
    for (const [key, count] of Object.entries(current)) {
        const allowed = baseline[key] ?? 0;
        if (count > allowed) grown.push({ key, from: allowed, to: count });
    }
    return grown;
}

/**
 * Compare current raw-hex counts to the frozen baseline.
 * Returns { newViolations, paidDown } — newViolations block; paidDown is
 * debt that no longer reproduces (prompt to re-freeze smaller).
 */
export function diffAgainstBaseline(current, baseline) {
    const newViolations = [];
    const paidDown = [];
    for (const [key, n] of Object.entries(current)) {
        const allowed = baseline[key] ?? 0;
        if (n > allowed) newViolations.push({ key, count: n, allowed });
    }
    for (const [key, allowed] of Object.entries(baseline)) {
        if ((current[key] ?? 0) < allowed) paidDown.push({ key, allowed, count: current[key] ?? 0 });
    }
    return { newViolations, paidDown };
}
