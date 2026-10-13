#!/usr/bin/env node
/**
 * The Ship Gate - Universal validation ladder.
 * Modes:
 *   node scripts/gate.mjs          # Standard local gate
 *   node scripts/gate.mjs --quick  # Quick mode
 *   node scripts/gate.mjs --terse  # Compact 1-line per check output
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const isTerse = args.includes('--terse');
const isQuick = args.includes('--quick');

export const STATIC_CHECKS = [
    { name: 'check:rules', cmd: 'npm', args: ['run', 'check:rules'] },
    { name: 'check:agents', cmd: 'npm', args: ['run', 'check:agents'] },
    { name: 'check:control-plane', cmd: 'npm', args: ['run', 'check:control-plane'] },
    { name: 'check:vault', cmd: 'npm', args: ['run', 'check:vault'] },
    { name: 'typecheck', cmd: 'npm', args: ['run', 'typecheck'] },
    { name: 'test', cmd: 'npm', args: ['run', 'test'] }
];

console.log(`\n=== Running Ship Gate (${isQuick ? 'quick' : 'standard'}${isTerse ? ', terse' : ''}) ===\n`);

let failed = false;

for (const check of STATIC_CHECKS) {
    if (isTerse) {
        process.stdout.write(`• ${check.name.padEnd(24)} `);
    } else {
        console.log(`--- [RUN] ${check.name} ---`);
    }

    const start = Date.now();
    const res = spawnSync(check.cmd, check.args, {
        stdio: isTerse ? 'pipe' : 'inherit',
        shell: true,
        env: process.env
    });
    const dur = ((Date.now() - start) / 1000).toFixed(1);

    if (res.status === 0) {
        if (isTerse) {
            console.log(`PASS (${dur}s)`);
        } else {
            console.log(`[PASS] ${check.name} (${dur}s)\n`);
        }
    } else {
        failed = true;
        if (isTerse) {
            console.log(`FAIL (${dur}s)`);
            if (res.stdout) console.error(res.stdout.toString());
            if (res.stderr) console.error(res.stderr.toString());
        } else {
            console.error(`\n[FAIL] ${check.name} (exit code ${res.status})\n`);
        }
        break;
    }
}

if (failed) {
    console.error('\n❌ Ship Gate FAILED. Fix issues before committing.\n');
    process.exit(1);
} else {
    console.log('\n✅ Ship Gate GREEN. All checks passed.\n');
    process.exit(0);
}
