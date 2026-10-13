/**
 * plan:lint `review` check: a plan is held to the review bar of the code it orders.
 *
 * WHY (L-083, 2026-10-05): the write ledger classifies risk from the paths a session
 * writes, and a plan doc matches no route, so a plan for an R3 prompt change owed
 * nothing. `exec:review --check` trusted the `--roles` its author passed, so doc 33's
 * assessment passed with no CISO section, no launch checklist and no reviewer. The
 * build was gated; the plan the build follows was not.
 *
 * So the risk is derived from the plan itself: every code path it cites, with or without
 * a `:line` and inside code fences too, is classified like a write, and the highest tier
 * wins. At R2+ the plan must carry:
 *   - an Executive Assessment whose required roles come from those paths and the routes
 *     they hit (the same `rolesFor` the brief uses), checked by `checkAssessment`;
 *   - at R3+, a `### Launch checklist` subsection under it;
 *   - a `| **Review** |` header row reading `pending`, or naming the reviewer receipt AND
 *     `owner approved YYYY-MM-DD`.
 *
 * An edited plan (plan:lint `changed` mode) gets this check whenever the edit raises its
 * tier, so appending an R3 work order to an old plan cannot dodge it.
 *
 * WHAT IT DOES NOT PROVE: the approval line is self-reported text, like a receipt's
 * actor. It makes a missing review visible in the gate; it cannot make one honest.
 */
import { checkAssessment, rolesFor } from '../agent-system/exec-review.mjs';
import { classify } from '../agent-system/resolve-task.mjs';

const RISK_ORDER = ['R0', 'R1', 'R2', 'R3', 'R4'];
// `:line` optional: "edit lib/config/prompt-registry.ts (the carouselData block)" orders R3 work too.
const CITED_PATH = /(?<![\w/.:-])((?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|mjs|cjs|js|css|json|sql|tf|ya?ml|sh))(?![\w/-])/g;
const ASSESSMENT = /^#{2,3}\s.*Executive Assessment/i;
const APPROVED = /reviewer receipt.*owner approved \d{4}-\d{2}-\d{2}/i;

/** The highest route tier any cited code path classifies to, and the routes hit. */
export function planRisk(text, routing) {
    const paths = [...new Set([...text.matchAll(CITED_PATH)].map((m) => m[1]))];
    let risk = 'R0';
    const routeIds = new Set();
    for (const p of paths) {
        const { route } = classify('', [p], routing);
        if (!route) continue;
        routeIds.add(route.id);
        if (RISK_ORDER.indexOf(route.risk) > RISK_ORDER.indexOf(risk)) risk = route.risk;
    }
    return { risk, paths, routeIds: [...routeIds] };
}

/** True when `text` cites code of a higher tier than `baseText` did. */
export function riskRaised(baseText, text, routing) {
    return RISK_ORDER.indexOf(planRisk(text, routing).risk) > RISK_ORDER.indexOf(planRisk(baseText, routing).risk);
}

/**
 * @param {string[]} lines  prose lines of the plan (1-based line = index + 1)
 * @param {{ routing: object, rolesConfig?: object, riskText?: string }} ctx
 *   `riskText`: the raw document, so paths cited inside code fences count toward the tier.
 */
export function checkPlanReview(lines, { routing, rolesConfig, riskText }) {
    const { risk, paths, routeIds } = planRisk(riskText ?? lines.join('\n'), routing);
    if (RISK_ORDER.indexOf(risk) < RISK_ORDER.indexOf('R2')) return [];
    const why = `the plan cites ${risk} code (${routeIds.join(', ')})`;
    const findings = [];

    const reviewIdx = lines.findIndex((l) => /^\|\s*\**Review\**\s*\|/i.test(l));
    if (reviewIdx === -1) {
        findings.push({ check: 'review', line: 1, detail: `${why}: add a \`| **Review** |\` header row reading "pending", or the reviewer receipt plus "owner approved YYYY-MM-DD"` });
    } else {
        const value = lines[reviewIdx].split('|')[2]?.trim() ?? '';
        if (!/^\**pending\b/i.test(value) && !APPROVED.test(value)) {
            findings.push({ check: 'review', line: reviewIdx + 1, detail: 'Review row must read "pending", or name the reviewer receipt and "owner approved YYYY-MM-DD"' });
        }
    }

    const start = lines.findIndex((l) => ASSESSMENT.test(l));
    if (start === -1) {
        findings.push({ check: 'review', line: 1, detail: `${why}: no Executive Assessment section (AGENTS.md §4 rule 9)` });
        return findings;
    }
    const depth = lines[start].match(/^#+/)[0].length;
    const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${depth}}\\s`).test(l));
    const section = lines.slice(start, end === -1 ? undefined : end).join('\n');

    const requiredRoles = rolesFor(routeIds.join(' ').replace(/-/g, ' '), paths, rolesConfig).map((r) => r.id);
    const { problems } = checkAssessment(section, rolesConfig ? { requiredRoles, config: rolesConfig } : { requiredRoles });
    for (const p of problems) findings.push({ check: 'review', line: start + 1, detail: `${p} (required roles: ${requiredRoles.join(', ')})` });

    if (RISK_ORDER.indexOf(risk) >= RISK_ORDER.indexOf('R3') && !/^###\s+Launch checklist/im.test(section)) {
        findings.push({ check: 'review', line: start + 1, detail: `${why}: an R3+ assessment needs a \`### Launch checklist\` subsection (rollback, flag, migration, monitoring)` });
    }
    return findings;
}
