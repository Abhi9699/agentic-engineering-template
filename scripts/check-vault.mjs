#!/usr/bin/env node
/**
 * Vault governance gate: structure, links, sources, semantic freshness,
 * decision coverage, task-state consistency, and current path validity.
 *
 * Usage: node scripts/check-vault.mjs [--quiet]
 */
import { auditVault } from './lib/vault-governance.mjs';

const unknownArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== '--quiet');
if (unknownArguments.length > 0) {
  throw new Error(`Unknown arguments: ${unknownArguments.join(', ')}`);
}

const result = auditVault(process.cwd());
if (!process.argv.includes('--quiet')) {
  for (const error of result.errors) console.error(`ERROR   ${error}`);
  for (const warning of result.warnings) console.warn(`WARN    ${warning}`);
}
console.log(
  `\nvault-check: ${result.noteCount} notes · ${result.errors.length} error(s) · ${result.warnings.length} warning(s) · health score ${result.score}/100`,
);
process.exit(result.errors.length > 0 ? 1 : 0);
