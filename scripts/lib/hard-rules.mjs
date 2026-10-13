/**
 * Canonical machine-checkable AGENTS.md §4 hard rules + pure scan engine.
 * Consumed by scripts/check-hard-rules.mjs (CLI, CI, git pre-commit hook).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Stack configuration bridge
let configuredDirs = ['src'];
if (existsSync('config/stack.config.json')) {
    try {
        const stackConfig = JSON.parse(readFileSync('config/stack.config.json', 'utf8'));
        if (Array.isArray(stackConfig.scanDirs)) configuredDirs = stackConfig.scanDirs;
    } catch {}
}

export const SCAN_DIRS = configuredDirs;
export const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);

const norm = (p) => p.replaceAll('\\', '/');
const isTest = (p) => /__tests__|\.test\.|\.spec\./.test(p);

/**
 * @typedef {{ id: string, severity: 'block'|'warn', pattern: RegExp, message: string,
 *             applies?: (relPath: string) => boolean,
 *             allow: (relPath: string, line: string, content?: string) => boolean }} Rule
 */

/** @type {Rule[]} */
export const RULES = [
    {
        id: 'locale-hydration',
        severity: 'block',
        pattern: /\.toLocaleString\(\s*\)/,
        message: "AGENTS.md §4: bare .toLocaleString() causes a hydration mismatch for non-US locales — pass an explicit locale, e.g. .toLocaleString('en-US').",
        allow: (p) => isTest(p),
    },
    {
        id: 'secret-compare',
        severity: 'block',
        pattern: /\w*(secret|token|signature|apikey|password)\w*\s*[!=]==|[!=]==\s*\w*(secret|token|signature|apikey|password)\w*/i,
        message: 'AGENTS.md §4b: compare secrets, tokens and signatures with crypto.timingSafeEqual(), never === (SEC-06).',
        allow: (p, line) => isTest(p)
            || /^\s*(\/\/|\*|\/\*)/.test(line)
            || /[!=]==\s*(undefined|null)\b|[!=]==\s*(''|""|``)|\b(undefined|null)\s*[!=]==|typeof\s/.test(line),
    },
    {
        id: 'ban-ts-comment',
        severity: 'block',
        pattern: /@ts-ignore|@ts-expect-error(?!\s+--\s*\S+|\s*:\s*\S+)/,
        message: 'AGENTS.md §4: @ts-ignore is banned; @ts-expect-error requires a written reason on the same line (e.g. // @ts-expect-error: <reason>).',
        allow: (_p, line) => /@ts-expect-error\s*[:—-]\s*\S/.test(line),
    },
    {
        id: 'crypto-random',
        severity: 'block',
        pattern: /Math\.random\(\)/,
        message: 'AGENTS.md §4: Math.random() is cryptographically insecure for tokens/IDs — use crypto.randomUUID() or crypto.getRandomValues().',
        applies: (p) => !isTest(p) && /token|auth|security|session|id/i.test(p),
        allow: (_p, line) => /^\s*(\/\/|\*|\/\*)/.test(line),
    },
    {
        id: 'pii-log',
        severity: 'block',
        pattern: /\b(logger\.(trace|debug|info|warn|error|fatal)|console\.(log|info|warn|error))\s*\(.*[{,]\s*(email|phone|phoneNumber|password|secret)\s*[,}:]/,
        message: 'PRV-05: no password, secret or raw PII in logs; mask or log internal identifiers instead.',
        allow: (p, line) => isTest(p) || /^\s*(\/\/|\*|\/\*)/.test(line),
    },
    {
        id: 'inner-html',
        severity: 'block',
        pattern: /dangerouslySetInnerHTML/,
        message: 'AI-03: dangerouslySetInnerHTML creates XSS vulnerabilities; render content safely as structured elements or text.',
        allow: (p, line) => isTest(p) || /^\s*(\/\/|\*|\/\*)/.test(line),
    }
];

function closingParen(content, open) {
    let depth = 0;
    for (let i = open; i < content.length; i++) {
        if (content[i] === '(') depth++;
        else if (content[i] === ')' && --depth === 0) return i;
    }
    return -1;
}

const lineOf = (content, index) => content.slice(0, index).split('\n').length;

/** @type {FileRule[]} */
export const FILE_RULES = [
    {
        id: 'fetch-signal',
        severity: 'block',
        message: 'REL-02: every outbound fetch passes a `signal` (AbortSignal.timeout(ms) or AbortController) so a hung host cannot hold execution.',
        applies: (p) => !isTest(p),
        check: (_p, content) => {
            const out = [];
            for (const m of content.matchAll(/(?<![\w.])fetch\(/g)) {
                const open = m.index + m[0].length - 1;
                const close = closingParen(content, open);
                const call = content.slice(open + 1, close === -1 ? undefined : close);
                if (/^\s*['"`]\//.test(call)) continue;
                if (!/\bsignal\b/.test(call)) out.push(lineOf(content, m.index));
            }
            return out;
        },
    }
];

/** Scans a single file against all RULES and FILE_RULES. Pure function. */
export function findViolations(relPath, content, ctx = {}) {
    const normPath = norm(relPath);
    const violations = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const rule of RULES) {
            if (rule.applies && !rule.applies(normPath)) continue;
            if (rule.pattern.test(line)) {
                if (rule.allow && rule.allow(normPath, line, content)) continue;
                violations.push({
                    ruleId: rule.id,
                    severity: rule.severity,
                    line: i + 1,
                    message: rule.message,
                });
            }
        }
    }

    for (const fileRule of FILE_RULES) {
        if (fileRule.applies && !fileRule.applies(normPath)) continue;
        const matchingLines = fileRule.check(normPath, content, ctx);
        for (const lineNum of matchingLines) {
            violations.push({
                ruleId: fileRule.id,
                severity: fileRule.severity,
                line: lineNum,
                message: fileRule.message,
            });
        }
    }

    return violations;
}
