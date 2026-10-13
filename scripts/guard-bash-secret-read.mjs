#!/usr/bin/env node
/**
 * PreToolUse guard: block a Bash/PowerShell command that READS a secret file.
 *
 * WHY THIS EXISTS — the gap it closes (audited 2026-08-27):
 * `.claude/settings.json` denies `Read(**\/.env)` and friends, but Claude Code
 * "checks file permissions against Edit(path) and Read(path) rules only" for its
 * FILE TOOLS. A shell command is matched against `Bash(...)` rules, not `Read(...)`
 * rules — and `cat`, `head`, `tail`, `grep`, `type` are in the built-in read-only
 * command set that "runs without a permission prompt in every mode".
 * So `cat .env.local` bypassed the entire secret-read boundary with no prompt.
 * Source: https://code.claude.com/docs/en/permissions (Read-only commands;
 * "Block a file from being read"), verified 2026-08-27.
 *
 * Shares isSecretPath() with the commit-time guard so the read boundary and the
 * write boundary can never disagree about what counts as a secret.
 *
 * Fails CLOSED on malformed input: if we cannot parse the command we deny.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isSecretPath, normalizePath } from './guard-secrets.mjs';

/** Path-shaped tokens that could name a secret. Deliberately greedy. */
const CANDIDATE = /[\w./\~-]*(?:\.env(?:\.[\w-]+)*|service_account[\w.-]*\.json)/gi;

/**
 * Heredoc bodies: which ones are skipped, and why so few (hardened 2026-10-08).
 *
 * A heredoc body is often prose that merely NAMES a secret path, such as a commit message or a
 * doc being written. The first version of this guard blocked an AGENTS.md edit for that, and a
 * false positive that blocks honest work trains people to bypass the guard.
 *
 * But stripping every `<<X ... X` hid real reads:
 * - `echo '<<X'; cat .env.local` (the `<<` was only text)
 * - `bash <<X` (the body runs)
 * - an unquoted delimiter (`$(...)` in the body runs)
 * - `cat <<'X' | sh`
 *
 * So a body is skipped only when its opener line has one of the shapes below. The delimiter
 * must be quoted, so the body cannot expand, and the consumer must store the text rather than
 * run it. Every other heredoc body is scanned.
 */
const SAFE_OPENERS = [
    // cat > file <<'X'  (or `cat <<'X' > file`), the last command on its line.
    /(?:^|[;&|(]\s*)cat\s*(?:>>?\s*[^\s;&|<>`$]+\s*)?<<-?\s*(['"])(\w+)\1\s*(?:>>?\s*[^\s;&|<>`$]+\s*)?$/,
    // git commit|tag ... -F - <<'X'   ·   gh ... --body-file - <<'X'
    /(?:^|[;&|]\s*)(?:git\s+(?:commit|tag)|gh)\s[^;&|`$<]*\s(?:-F|--file|--body-file)\s+-\s[^;&|`$<]*<<-?\s*(['"])(\w+)\1\s*$/,
    // git|gh ... -m "$(cat <<'X'
    /(?:^|[;&|]\s*)(?:git|gh)\s[^;&|`<]*\s(?:-m|--message|--body|--title|--notes)\s+"\$\(cat\s+<<-?\s*(['"])(\w+)\1\s*$/,
];

/**
 * Drop the body lines of allowlisted heredocs. Every opener and terminator line is kept, so a
 * read on either line is still seen.
 *
 * When in doubt it scans. The body is kept when:
 * - no terminator is found; or
 * - a line merely starts with the delimiter (inside `$(...)` bash may end the heredoc there).
 */
function stripSafeHeredocs(command) {
    const lines = command.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        out.push(lines[i]);
        const opener = lines[i].replace(/\r$/, '');
        const m = SAFE_OPENERS.map((re) => opener.match(re)).find(Boolean);
        if (!m) continue;
        const delim = m[2];
        const dash = opener.slice(opener.lastIndexOf('<<')).startsWith('<<-');
        const bare = (l) => (dash ? l.replace(/^\t+/, '') : l).replace(/\r$/, '');
        let end = -1;
        for (let j = i + 1; j < lines.length; j++) {
            const l = bare(lines[j]);
            if (l === delim) { end = j; break; }
            if (l.startsWith(delim)) break;
        }
        if (end === -1) continue;
        out.push(lines[end]);
        i = end;
    }
    return out.join('\n');
}

/** Names a wildcard is tested against: the secret files met in practice (all isSecretPath). */
const SECRET_NAMES = [
    '.env', '.env.local', '.env.production', '.env.development', '.env.test', '.env.preview',
    '.env.production.local', '.env.development.local', '.env.test.local', 'service_account.json',
];

/**
 * The words bash actually passes on (doc 36 S1, 2026-10-11): line continuations joined, quotes
 * removed and backslash escapes resolved. `".e"nv.local`, `.e''nv.local` and `.e\nv.local` all
 * read `.env.local`, and a scan of the raw text saw none of them. A `\\` stays one backslash, so
 * a Windows path handed to a native program keeps its separators.
 */
const bashWords = (text) => text.replace(/\\\r?\n/g, '').replace(/['"]/g, '').replace(/\\([\s\S])/g, '$1');

/**
 * The same words with bash's real quoting rules (2026-10-11 review): a backslash inside quotes
 * stays, as bash keeps it, so `powershell -c "gc .\.e*"` hands PowerShell the path `.\.e*`.
 * Inside double quotes only `\$`, `` \` ``, `\"`, `\\` and `\<newline>` are escapes.
 */
function quotedWords(text) {
    let out = '';
    let quote = '';
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote === "'") {
            if (c === "'") quote = '';
            else out += c;
        } else if (c === '\\') {
            const next = text[i + 1] ?? '';
            if (next === '\n') i++;
            else if (next === '\r' && text[i + 2] === '\n') i += 2;
            else if (quote === '"' && !'$`"\\'.includes(next)) out += c;
            else { out += next; i++; }
        } else if (c === '"' || (c === "'" && !quote)) quote = quote ? '' : c;
        else out += c;
    }
    return out;
}

/**
 * A directory a wildcard is confined to, proved to hold no secret (doc 36 S1). `agent-system/*.json`
 * can only expand inside `agent-system/`, so it is safe when that directory holds no secret-named
 * entry. Proved only when all of these hold, else the wildcard is flagged as before:
 * - the directory is literal (no wildcard, `$`, `~`) and exists in every checked cwd;
 * - the command is one simple command: no unquoted `;`, `&`, `|`, newline, `$(`, backtick or
 *   process substitution, so nothing it runs can create files before its own globs expand;
 * - nothing in it changes directory (`cd`, `pushd`, `Set-Location`, `git -C`).
 * Residual: a program that globs by itself (`rg -g`, `find -path`) may match a same-named
 * directory elsewhere under its search root.
 * @param {string} command the raw command
 * @param {string[]} cwds directories the shell may resolve from (hook payload cwd, process cwd)
 */
function confinedDirProver(command, cwds) {
    if (!cwds.length) return () => false;
    const unquoted = command.replace(/'[^']*'|"(?:[^"\\$`]|\\.)*"/g, '');
    if (/[;&|\n`]|\$\(|[<>]\(/.test(unquoted)) return () => false;
    if (/\b(?:cd|pushd|popd|chdir|Set-Location|sl)\b|\bgit\b.*\s-C\b/i.test(command)) return () => false;
    return (dir) => /^[\w.:/\\-]+$/.test(dir) && cwds.every((cwd) => {
        try {
            return fs.readdirSync(path.resolve(cwd, dir)).every((name) => !isSecretPath(name));
        } catch {
            return false; // missing or unreadable: cannot prove it
        }
    });
}

/**
 * A wildcard token that could expand to a secret, such as `.en*`, `.e?v.local`, `service_acc*`
 * or `*.local`.
 * - A token with no literal character at all (`*`) is not flagged; that would block every
 *   listing.
 * - In bash a leading wildcard does not match a leading dot. In PowerShell it does.
 * - Bash text arrives through `bashWords`, so `"^\S*\s*"` is the word `^S*s*`, not a path
 *   ending in `s*`.
 * @param {(dir: string) => boolean} [confined] proves a bash wildcard's directory holds no secret
 * @param {number} [minLiteral] literal characters the base must keep to count
 */
function globSecrets(text, shell, confined = () => false, minLiteral = 1) {
    const hits = [];
    for (const token of text.split(/[\s'"(),;|<>=]+/)) {
        if (!/[*?[]/.test(token)) continue;
        const cut = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
        const base = token.slice(cut + 1);
        if (base.replace(/[*?[\]]/g, '').length < minLiteral) continue;
        if (shell === 'bash' && cut > 0 && !/[*?[]/.test(token.slice(0, cut)) && confined(token.slice(0, cut))) continue;
        const re = globRegex(base);
        if (!re) continue; // not a valid pattern, so the shell does not expand it as one either
        const leadWild = /^[*?[]/.test(base);
        if (SECRET_NAMES.some((n) => re.test(n) && !(shell === 'bash' && leadWild && n.startsWith('.')))) hits.push(token);
    }
    return hits;
}

/**
 * Wildcards that keep a quoted `\` (2026-10-11 review). Only a native Windows program sees one,
 * so a token whose prefix is a path takes PowerShell's wildcard rules: one literal is enough and
 * a leading wildcard matches a dot file. A prefix is a path when it is anchored (starts `.`,
 * `..`, `~` or `$VAR`, holds a drive: `D:\Projects*`, `\\?\D:`, or starts `\` with no regex
 * metacharacter: `\server\share`), or when it holds no
 * regex metacharacter (`^$+{}()|`, or `:` outside a drive, which no Windows name may hold) and
 * its first part, literal or wildcard, is a directory in a cwd; with no cwd to check, it is a
 * path. Any other prefix is a regex (`'name\s*='`, `"^\S*\s*foo"`), matched only when its base
 * keeps two literal characters. A proved secret-free directory (`confinedDirProver`) passes.
 */
function quotedPathSecrets(text, cwds, confined) {
    const hits = [];
    for (const token of text.split(/[\s'"(),;|<>=]+/)) {
        const cut = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
        if (!token.includes('\\') || !/[*?[]/.test(token.slice(cut + 1))) continue;
        const dir = token.slice(0, cut);
        const parts = dir.split(/[\\/]/);
        const drive = (p) => /^[A-Za-z]:$/.test(p);
        const regex = /[\^$+{}()|]/.test(dir) || parts.some((p) => p.includes(':') && !drive(p));
        const anchored = (cut > 0 && parts[0] === '' && !regex) || /^(?:\.{1,2}|~|\$[\w:{}]+)$/.test(parts[0]) || parts.some(drive);
        const isPath = anchored || (!regex && (!cwds.length || cwds.some((cwd) => startsInDir(cwd, parts[0]))));
        if (!isPath) hits.push(...globSecrets(token, 'bash', () => false, 2));
        else if (!confined(parts.join('/'))) hits.push(...globSecrets(token, 'powershell'));
    }
    return hits;
}

/** A shell wildcard as an anchored, case-insensitive RegExp, or null when it is not valid. */
function globRegex(glob) {
    try {
        return new RegExp(`^${glob.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\[!/g, '[^')}$`, 'i');
    } catch {
        return null;
    }
}

/** Whether `part` (a literal name or a wildcard) names a directory directly inside `cwd`. */
function startsInDir(cwd, part) {
    if (!part) return false;
    try {
        const re = globRegex(part);
        return fs.readdirSync(cwd, { withFileTypes: true }).some((e) => e.isDirectory() && re?.test(e.name));
    } catch {
        return true; // an unreadable cwd proves nothing, so the prefix counts as a path
    }
}

/**
 * PowerShell (`--powershell`, wired to Claude's PowerShell tool, 2026-10-08) has no heredoc,
 * so nothing is stripped: `<<X` is plain text there. Its escape character is the backtick
 * (`` .e`nv ``), so the text is also scanned with backticks removed.
 *
 * Bash is scanned twice: as written, and as `bashWords` (quotes and escapes resolved). Wildcards
 * are matched on that form and on `quotedWords` (`quotedPathSecrets`).
 * @param {unknown} command
 * @param {{ shell?: 'bash' | 'powershell', cwds?: string[] }} [options] `cwds` lets a bash
 *   wildcard confined to a secret-free directory pass (`confinedDirProver`); without it none does.
 * @returns {string[]} secret paths the command names, and wildcard tokens that could expand to one.
 */
export function secretsReferenced(command, { shell = 'bash', cwds = [] } = {}) {
    if (typeof command !== 'string') return [];
    const hits = new Set();
    if (shell === 'bash') {
        const raw = stripSafeHeredocs(command);
        const words = bashWords(raw);
        for (const text of [raw, words]) for (const p of literalSecrets(text)) hits.add(p);
        const confined = confinedDirProver(command, cwds);
        for (const g of globSecrets(words, shell, confined)) hits.add(g);
        for (const g of quotedPathSecrets(quotedWords(raw), cwds, confined)) hits.add(g);
        return [...hits];
    }
    for (const text of [command, command.replaceAll('`', '')]) {
        for (const p of literalSecrets(text)) hits.add(p);
        for (const g of globSecrets(text, shell)) hits.add(g);
    }
    return [...hits];
}

/** Secret paths named literally in `text`. */
function literalSecrets(text) {
    const hits = [];
    for (const m of text.matchAll(CANDIDATE)) {
        const raw = m[0];
        // After `$`, the leading word is a variable name the shell replaces (`cat x$IFS.env.local`
        // reads `.env.local`), so the path also counts without it (2026-10-08 review).
        const forms = text[m.index - 1] === '$' ? [raw, raw.replace(/^\w+/, '')] : [raw];
        for (const form of forms) {
            const token = normalizePath(form.replace(/^['"]|['"]$/g, ''));
            if (isSecretPath(token)) hits.push(token);
        }
    }
    return hits;
}

/** Whether `word` (without its dash) is an accepted spelling of PowerShell's -EncodedCommand. */
const isEncodedFlag = (word) => ['e', 'ec'].includes(word) || (word.length >= 2 && 'encodedcommand'.startsWith(word));

/**
 * Constructs whose real text the scanner cannot see, denied as unverifiable rather than guessed:
 * - an encoded PowerShell command (`pwsh -enc ...`), on either tool;
 * - on the PowerShell tool, `Invoke-Expression`/`iex` and `[scriptblock]::Create`, which run a
 *   string built at runtime.
 * @param {unknown} command
 * @param {{ shell?: 'bash' | 'powershell' }} [options]
 * @returns {string} the construct found, or ''
 */
export function unverifiableConstruct(command, { shell = 'bash' } = {}) {
    if (typeof command !== 'string') return '';
    const text = command.replaceAll('`', '');
    for (const m of text.matchAll(/\b(?:powershell|pwsh)(?:\.exe)?\b([^\n;|&]*)/gi)) {
        const flag = (m[1].match(/(?:^|\s)[-/][a-z]+\b/gi) ?? []).find((f) => isEncodedFlag(f.trim().slice(1).toLowerCase()));
        if (flag) return `${flag.trim()} (an encoded PowerShell command)`;
    }
    if (shell === 'powershell') {
        const m = text.match(/\b(?:iex|Invoke-Expression)\b|\[scriptblock\]::Create/i);
        if (m) return m[0];
    }
    return '';
}

const deny = (reason) => JSON.stringify({
    hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
    },
});

/**
 * The hook body, run through scripts/hook-fail-closed.mjs so a crash blocks the call.
 * @param {string} raw the PreToolUse payload
 * @param {string[]} args `--powershell` for Claude's PowerShell tool
 * @returns {string} a deny decision, or '' to allow
 */
export function hookMain(raw, args = []) {
    let command, cwd;
    try {
        const payload = JSON.parse(raw);
        command = payload?.tool_input?.command;
        cwd = typeof payload?.cwd === 'string' ? payload.cwd : '';
    } catch {
        return deny('guard-bash-secret-read: could not parse the hook payload, so it cannot prove this command does not read a secret. Failing closed.');
    }
    const shell = args.includes('--powershell') ? 'powershell' : 'bash';
    const opaque = unverifiableConstruct(command, { shell });
    if (opaque) {
        return deny(`Blocked: this command uses ${opaque}, whose real text the secret-read guard cannot check. Run the command directly instead.`);
    }
    const cwds = [...new Set([cwd, process.cwd()].filter(Boolean))];
    const found = secretsReferenced(command, { shell, cwds });
    if (!found.length) return '';
    return deny(
        `Blocked: this command references ${found.join(', ')} — a secret file. `
        + 'Secrets are never read by an agent (AGENTS.md §4, §9). `.env.example` is the readable template; '
        + 'env var names belong in docs/ops/15-setup-runbook.md. If you need a value, ask the human to provide it.',
    );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    let raw = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;
    const out = hookMain(raw, process.argv.slice(2));
    if (out) console.log(out);
    process.exit(0);
}
