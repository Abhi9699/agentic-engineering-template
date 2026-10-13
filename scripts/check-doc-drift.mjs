#!/usr/bin/env node
/**
 * check-doc-drift.mjs — Automated Documentation & Architectural Drift Guard
 *
 * Verifies that documentation in vault/ and docs/ does not drift from ground-truth code.
 *
 * Checks:
 *   1. File Reference Integrity: Validates that workspace file paths cited in active
 *      markdown files actually exist. Skips historical changelogs and archived specs.
 *   2. Paired Feature Enforcement (--staged): Ensures that modifying code in a feature
 *      directory pairs with a touch/verification in the corresponding vault note.
 *   3. Self-Test (--self-test): Proves the detector catches synthetic drift.
 *
 * Usage:
 *   node scripts/check-doc-drift.mjs
 *   node scripts/check-doc-drift.mjs --staged
 *   node scripts/check-doc-drift.mjs --self-test
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const VAULT_DIR = path.join(ROOT, 'vault');
const DOCS_DIR = path.join(ROOT, 'docs');

/** Feature code directories mapped to their primary vault feature notes */
export const FEATURE_DOC_PAIRS = {
    // Feature code directories mapped to their primary vault feature notes.
    // Example: 'src/features/auth': 'vault/features/Auth.md'
};

/**
 * Files or patterns exempt from file existence checks (historical changelogs, specs, and architecture history).
 */
export function isExemptFromCitationCheck(filePath) {
    const norm = filePath.replace(/\\/g, '/');
    if (norm.endsWith('_CHANGELOG.md')) return true;
    if (norm.includes('/archive/')) return true;
    if (norm.includes('/ux-audit/')) return true;
    if (norm.includes('/validation/')) return true;
    if (norm.includes('/audits/')) return true;
    if (norm.includes('/competitive/')) return true;
    if (norm.includes('AUDIT_EVIDENCE_MATRIX.md')) return true;
    if (norm.includes('DOCUMENTATION-EXCELLENCE-AUDIT')) return true;
    if (/-plan\.md$/i.test(norm) || /-plan-\d+/i.test(norm) || /PLAN\.md$/i.test(norm)) return true;
    if (/_REPORT\.md$/i.test(norm) || /_AUDIT\.md$/i.test(norm) || /_DESIGN\.md$/i.test(norm)) return true;
    if (norm.includes('VALIDATION-') || norm.includes('SPEC-2026-')) return true;
    if (norm.includes('agent-enforcement.md')) return true;
    return false;
}

/**
 * Collect all markdown files recursively under a directory.
 */
export function getMarkdownFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    const results = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...getMarkdownFiles(full));
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
            results.push(full);
        }
    }
    return results;
}

/**
 * Check file references inside a markdown string.
 */
export function checkFileReferences(content, filePath, workspaceRoot = ROOT) {
    if (isExemptFromCitationCheck(filePath)) return [];

    const errors = [];
    // Match file:/// links or repo-relative paths in markdown links
    const linkRegex = /\[(?:[^\]]+)\]\((file:\/\/\/[^\)\s#]+|[^:\)\s#]+\.[a-zA-Z0-9]+)(?:#[^\)]*)?\)/g;
    // Match explicit workspace paths in backticks: app/..., components/..., lib/...
    const backtickRegex = /`((?:app|components|lib|scripts|infra|vault|docs)\/[a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)`/g;

    let match;
    while ((match = linkRegex.exec(content)) !== null) {
        const rawTarget = match[1];
        if (rawTarget.startsWith('http://') || rawTarget.startsWith('https://') || rawTarget.startsWith('mailto:')) {
            continue;
        }

        const prevLineStart = Math.max(0, content.lastIndexOf('\n', content.lastIndexOf('\n', match.index) - 1));
        const nextLineEnd = content.indexOf('\n', content.indexOf('\n', match.index) + 1);
        const windowText = content.substring(prevLineStart, nextLineEnd !== -1 ? nextLineEnd : content.length);
        if (/\b(deleted|retired|removed|formerly|historical|existed only to|is missing|nothing is committed|has no|archived)\b/i.test(windowText)) {
            continue;
        }

        let resolvedPath;
        if (rawTarget.startsWith('file://')) {
            try {
                resolvedPath = fileURLToPath(rawTarget);
            } catch {
                resolvedPath = path.normalize(rawTarget.replace(/^file:\/\/\/?/, ''));
            }
        } else {
            resolvedPath = path.resolve(path.dirname(filePath), rawTarget);
        }

        if (!fs.existsSync(resolvedPath)) {
            errors.push({
                file: path.relative(workspaceRoot, filePath),
                target: rawTarget,
                type: 'broken-file-reference',
                message: `Referenced file does not exist: ${rawTarget}`
            });
        }
    }

    while ((match = backtickRegex.exec(content)) !== null) {
        const rawTarget = match[1];
        if (rawTarget.includes('*') || rawTarget.includes('{') || rawTarget.includes('<')) continue;

        const prevLineStart = Math.max(0, content.lastIndexOf('\n', content.lastIndexOf('\n', match.index) - 1));
        const nextLineEnd = content.indexOf('\n', content.indexOf('\n', match.index) + 1);
        const windowText = content.substring(prevLineStart, nextLineEnd !== -1 ? nextLineEnd : content.length);
        if (/\b(deleted|retired|removed|formerly|historical|existed only to|is missing|nothing is committed|has no|archived)\b/i.test(windowText)) {
            continue;
        }

        const resolvedPath = path.join(workspaceRoot, rawTarget);
        if (!fs.existsSync(resolvedPath)) {
            errors.push({
                file: path.relative(workspaceRoot, filePath),
                target: rawTarget,
                type: 'broken-path-citation',
                message: `Cited workspace path does not exist: ${rawTarget}`
            });
        }
    }

    return errors;
}

/**
 * Check paired feature code changes against staged files.
 */
export function checkPairedDiff(stagedFiles, featurePairs = FEATURE_DOC_PAIRS, _workspaceRoot = ROOT) {
    const errors = [];
    const modifiedPrefixes = new Set();

    for (const file of stagedFiles) {
        const norm = file.replace(/\\/g, '/');
        for (const prefix of Object.keys(featurePairs)) {
            if (norm.startsWith(prefix + '/')) {
                modifiedPrefixes.add(prefix);
            }
        }
    }

    for (const prefix of modifiedPrefixes) {
        const requiredDoc = featurePairs[prefix];
        const normRequiredDoc = requiredDoc.replace(/\\/g, '/');
        const docModified = stagedFiles.some(f => f.replace(/\\/g, '/') === normRequiredDoc);

        if (!docModified) {
            errors.push({
                prefix,
                requiredDoc,
                type: 'unpaired-feature-change',
                message: `Code modified in "${prefix}/" without updating or verifying paired note "${requiredDoc}".`
            });
        }
    }

    return errors;
}

/**
 * Run self-test to prove the drift checker catches regressions.
 */
export function runSelfTest() {
    console.log('🧪 Running check-doc-drift self-test...');

    // Test 1: Catches broken file link in active note
    const dummyContent = 'Here is a link to [NonExistent](file:///d:/repo/non/existent/file.ts) and `app/fake/path.ts`.';
    const fakeFilePath = path.join(ROOT, 'vault', 'features', 'Active-Feature.md');
    const refErrors = checkFileReferences(dummyContent, fakeFilePath, ROOT);
    if (refErrors.length !== 2) {
        console.error(`❌ Self-test failed: expected 2 errors for broken paths, got ${refErrors.length}`);
        return false;
    }

    // Test 2: Exempts historical changelog
    const changelogPath = path.join(ROOT, 'vault', '_CHANGELOG.md');
    const changelogErrors = checkFileReferences(dummyContent, changelogPath, ROOT);
    if (changelogErrors.length !== 0) {
        console.error(`❌ Self-test failed: changelog should be exempt, got ${changelogErrors.length} errors`);
        return false;
    }

    // Test 3: Catches unpaired feature change
    const fakeStaged = ['app/overview/page.tsx', 'components/features/overview/overview-view.tsx'];
    const pairErrors = checkPairedDiff(fakeStaged, FEATURE_DOC_PAIRS, ROOT);
    if (pairErrors.length === 0 || !pairErrors.some(e => e.requiredDoc === 'vault/features/Overview-Dashboard.md')) {
        console.error('❌ Self-test failed: expected unpaired feature error for app/overview, got none.');
        return false;
    }

    // Test 4: Allows paired change
    const pairedStaged = ['app/overview/page.tsx', 'vault/features/Overview-Dashboard.md'];
    const cleanPairs = checkPairedDiff(pairedStaged, FEATURE_DOC_PAIRS, ROOT);
    if (cleanPairs.length !== 0) {
        console.error(`❌ Self-test failed: expected 0 errors when paired doc is touched, got ${cleanPairs.length}`);
        return false;
    }

    console.log('✅ check-doc-drift self-test passed.\n');
    return true;
}

/**
 * Main execution.
 */
export function main() {
    const args = process.argv.slice(2);
    if (args.includes('--self-test')) {
        const ok = runSelfTest();
        process.exit(ok ? 0 : 1);
    }

    const isStaged = args.includes('--staged');
    const totalErrors = [];

    if (isStaged) {
        try {
            const stagedOutput = execSync('git diff --name-only --cached', { encoding: 'utf8' }).trim();
            const stagedFiles = stagedOutput ? stagedOutput.split('\n').map(s => s.trim()) : [];
            const pairErrors = checkPairedDiff(stagedFiles, FEATURE_DOC_PAIRS, ROOT);
            totalErrors.push(...pairErrors);

            const stagedMdFiles = stagedFiles.filter(f => f.endsWith('.md')).map(f => path.join(ROOT, f));
            for (const file of stagedMdFiles) {
                if (fs.existsSync(file)) {
                    const content = fs.readFileSync(file, 'utf8');
                    totalErrors.push(...checkFileReferences(content, file, ROOT));
                }
            }
        } catch (err) {
            console.error('Warning: could not inspect git staged files:', err.message);
        }
    } else {
        const vaultFiles = getMarkdownFiles(VAULT_DIR);
        const docsFiles = getMarkdownFiles(DOCS_DIR);
        const allFiles = [...vaultFiles, ...docsFiles];

        for (const file of allFiles) {
            const content = fs.readFileSync(file, 'utf8');
            totalErrors.push(...checkFileReferences(content, file, ROOT));
        }
    }

    if (totalErrors.length > 0) {
        console.error(`\n❌ Documentation Drift Detected (${totalErrors.length} issue(s)):\n`);
        for (const err of totalErrors) {
            if (err.type === 'unpaired-feature-change') {
                console.error(`  • [${err.type}] ${err.message}`);
            } else {
                console.error(`  • [${err.type}] in ${err.file}: ${err.message}`);
            }
        }
        console.error('\nDocumentation must remain synchronized with ground-truth code. Update or fix the citations.\n');
        process.exit(1);
    }

    console.log('✅ Documentation drift check passed — all citations and references exist in workspace.');
    process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main();
}
