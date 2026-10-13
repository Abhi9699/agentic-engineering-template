#!/usr/bin/env node
/**
 * Structural validation of agent-system/*.json against manifest.schema.json (A1).
 *
 * A deliberately small JSON Schema 2020-12 subset — enough for these manifests and
 * nothing more — implemented here rather than pulled from npm. `ajv` only resolves
 * transitively in this repo, and AGENTS.md §3 forbids changing dependencies without
 * an explicit decision. A 150-line validator we own beats a dependency we did not
 * choose. It supports: type, required, properties, additionalProperties, items,
 * minItems, enum, const, pattern, format(date), minLength, minimum,
 * exclusiveMinimum, oneOf, allOf, if/then, $ref (local), and $defs.
 *
 * Structure only. Cross-file semantics — reachability, ownership, acyclicity,
 * quarantine — belong to check-graph.mjs, because JSON Schema cannot express them.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DIR = 'agent-system';
const SCHEMA = 'manifest.schema.json';

function resolveRef(root, ref) {
    if (!ref.startsWith('#/')) throw new Error(`unsupported $ref: ${ref}`);
    let node = root;
    for (const part of ref.slice(2).split('/')) node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (!node) throw new Error(`unresolvable $ref: ${ref}`);
    return node;
}

const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

/** @returns {string[]} human-readable errors, empty when valid */
export function validate(schema, value, root = schema, at = '') {
    const errors = [];
    const push = (m) => errors.push(`${at || '<root>'}: ${m}`);

    if (schema.$ref) return validate(resolveRef(root, schema.$ref), value, root, at);

    if (schema.const !== undefined && value !== schema.const) push(`must equal ${JSON.stringify(schema.const)}`);
    if (schema.enum && !schema.enum.includes(value)) push(`must be one of ${schema.enum.join(', ')} (got ${JSON.stringify(value)})`);

    if (schema.type) {
        const actual = typeOf(value);
        const ok = schema.type === 'integer' ? Number.isInteger(value) : actual === schema.type;
        if (!ok) {
            push(`expected ${schema.type}, got ${actual}`);
            return errors; // further checks would be noise
        }
    }

    if (typeof value === 'string') {
        if (schema.minLength !== undefined && value.length < schema.minLength) push(`must be at least ${schema.minLength} characters`);
        if (schema.pattern && !new RegExp(schema.pattern).test(value)) push(`must match ${schema.pattern} (got "${value}")`);
        if (schema.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) push(`must be an ISO date (got "${value}")`);
        if (schema.format === 'uri' && !/^https?:\/\//.test(value)) push(`must be an absolute URL (got "${value}")`);
    }

    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) push(`must be >= ${schema.minimum}`);
        if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) push(`must be > ${schema.exclusiveMinimum}`);
    }

    if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < schema.minItems) push(`must have at least ${schema.minItems} item(s)`);
        if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, root, `${at}[${i}]`)));
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const key of schema.required ?? []) {
            if (!(key in value)) push(`missing required property "${key}"`);
        }
        for (const [key, sub] of Object.entries(schema.properties ?? {})) {
            if (key in value) errors.push(...validate(sub, value[key], root, at ? `${at}.${key}` : key));
        }
        if (schema.additionalProperties === false) {
            for (const key of Object.keys(value)) {
                if (!(schema.properties ?? {})[key]) push(`unexpected property "${key}"`);
            }
        } else if (typeof schema.additionalProperties === 'object') {
            for (const [key, v] of Object.entries(value)) {
                if (!(schema.properties ?? {})[key]) errors.push(...validate(schema.additionalProperties, v, root, at ? `${at}.${key}` : key));
            }
        }
    }

    if (schema.oneOf) {
        const passing = schema.oneOf.filter((s) => validate(s, value, root, at).length === 0);
        if (passing.length !== 1) push(`must match exactly one alternative (matched ${passing.length})`);
    }
    for (const sub of schema.allOf ?? []) errors.push(...validate(sub, value, root, at));

    if (schema.if) {
        const matches = validate(schema.if, value, root, at).length === 0;
        if (matches && schema.then) errors.push(...validate(schema.then, value, root, at));
        if (!matches && schema.else) errors.push(...validate(schema.else, value, root, at));
    }

    return errors;
}

export function validateAll(root = process.cwd()) {
    const schema = JSON.parse(readFileSync(path.join(root, DIR, SCHEMA), 'utf8'));
    const files = readdirSync(path.join(root, DIR)).filter((f) => f.endsWith('.json') && f !== SCHEMA).sort();
    const results = [];
    for (const file of files) {
        let doc;
        try {
            doc = JSON.parse(readFileSync(path.join(root, DIR, file), 'utf8'));
        } catch (e) {
            results.push({ file, errors: [`unparseable JSON: ${e instanceof Error ? e.message : String(e)}`] });
            continue;
        }
        results.push({ file, errors: validate(schema, doc, schema) });
    }
    return results;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const results = validateAll();
    let failed = 0;
    for (const { file, errors } of results) {
        if (errors.length) {
            failed++;
            console.error(`FAIL ${DIR}/${file}`);
            for (const e of errors) console.error(`  - ${e}`);
        }
    }
    if (failed) {
        console.error(`\n${failed} manifest(s) failed structural validation.`);
        process.exit(1);
    }
    console.log(`validate-manifests OK - ${results.length} manifests match ${SCHEMA}.`);
}
