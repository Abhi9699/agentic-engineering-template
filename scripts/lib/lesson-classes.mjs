/**
 * The closed set of lesson classes (doc 36 P2) and the routes each one bears on.
 *
 * Every lesson in `vault/_Lessons.md` opens its `class:` field with one of these ids; the
 * free-text label it had before follows in parentheses. The set was derived from the 87
 * lessons as they stood on 2026-10-11 (doc 36 named 7 classes; two of them held no lesson,
 * and the two largest groups had none), so a new class is a ledger change, not a typo.
 *
 * The preflight surfaces a class's OPEN lessons when a task resolves to one of its routes:
 * keyword triggers alone never fired, because no lesson carried one.
 */

/**
 * Every route that changes files beyond a trivial edit. Read-only routes and `minor-change`
 * see no lessons: the prompt hook stays silent on a typo fix (agent-hooks-core.test.ts).
 */
const CHANGE_ROUTES = [
    'ui-change', 'backend-change', 'schema-migration', 'money-change',
    'publishing-change', 'prompt-change', 'control-plane-change', 'release',
];

/** @type {Record<string, { means: string, routes: string[] }>} */
export const LESSON_CLASSES = {
    'gate-gap': {
        means: 'a check was missing, too narrow, unable to fail, green for the wrong reason or bypassable',
        routes: ['control-plane-change', 'release'],
    },
    'money-path': {
        means: 'credits, prices, payments or the ledger went wrong at a seam',
        routes: ['money-change', 'schema-migration'],
    },
    'unmeasured-claim': {
        means: 'a result, figure or rule was asserted without the measurement or primary source behind it',
        routes: CHANGE_ROUTES,
    },
    'stale-fact': {
        means: 'something true once (a file, an index, copy, a derivation) drifted and was still relied on',
        routes: CHANGE_ROUTES,
    },
    'vendor-drift': {
        means: 'a vendor, dependency or tool did not behave as assumed',
        routes: ['backend-change', 'publishing-change', 'money-change', 'prompt-change', 'control-plane-change', 'release'],
    },
    'ui-craft': {
        means: 'what rendered or exported differed from what the code or a review suggested',
        routes: ['ui-change'],
    },
    'silent-loss': {
        means: 'data, a field or a feature was dropped and nothing failed',
        routes: ['ui-change', 'backend-change', 'money-change', 'schema-migration'],
    },
    process: {
        means: 'how work was set up (environment, branch, shared checkout, tooling) caused the defect',
        routes: ['control-plane-change', 'release'],
    },
};

/** The class id a `class:` field opens with, or '' when it opens with none of the set. */
export function lessonClass(field) {
    const id = String(field ?? '').trim().split(/[\s(]/)[0];
    return Object.hasOwn(LESSON_CLASSES, id) ? id : '';
}

/**
 * Lessons as `{ id, fields }`, from `## L-NNN — title` sections of `- **key:** value` lines.
 * @param {string} markdown
 */
export function parseLessons(markdown) {
    const out = [];
    for (const section of markdown.split(/^## (?=L-\d+)/m).slice(1)) {
        const id = section.match(/^(L-\d+)/)?.[1];
        if (!id) continue;
        /** @type {Record<string, string>} */
        const fields = {};
        for (const line of section.matchAll(/^-\s+\*\*([a-z]+):\*\*\s*(.+)$/gm)) fields[line[1]] = line[2].trim();
        out.push({ id, fields });
    }
    return out;
}

/**
 * OPEN lessons whose class bears on `route`.
 * @param {string} route a routing.json route id
 * @param {string} markdown the ledger
 */
export function openLessonsForRoute(route, markdown) {
    return parseLessons(markdown)
        .filter((l) => /^OPEN/.test(l.fields.status ?? '') && LESSON_CLASSES[lessonClass(l.fields.class)]?.routes.includes(route))
        .map((l) => l.id);
}
