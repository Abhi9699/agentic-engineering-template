#!/usr/bin/env node
/**
 * Antigravity PreToolUse hook for `run_command`.
 *
 * Enforces two critical runtime boundaries:
 * 1. Secret read denial: Blocks any command referencing .env* or service_account*.json,
 *    reusing the repository's single authority `secretsReferenced` from `guard-bash-secret-read.mjs`.
 * 2. Windows PowerShell chaining denial: On Windows (PowerShell shell), denies
 *    unquoted `&&` to prevent statement separator syntax errors and stop failure-masking.
 *
 * Fails CLOSED: If no valid command string can be extracted from the payload, it denies.
 */
import { pathToFileURL } from 'node:url';
import { secretsReferenced } from '../../guard-bash-secret-read.mjs';

/**
 * Extracts the command string across known toolCall and tool_input conventions.
 *
 * @param {object} payload
 * @returns {string | undefined}
 */
export function extractCommand(payload) {
    return (
        payload?.toolCall?.args?.CommandLine ??
        payload?.toolCall?.args?.commandLine ??
        payload?.toolCall?.args?.command ??
        payload?.toolCall?.args?.cmd ??
        payload?.tool_input?.command ??
        payload?.tool_input?.CommandLine ??
        payload?.tool_input?.commandLine ??
        payload?.tool_input?.cmd
    );
}

/**
 * Checks if a command contains unquoted `&&` outside single or double quotes.
 *
 * @param {string} cmd
 * @returns {boolean}
 */
export function hasUnquotedChaining(cmd) {
    if (typeof cmd !== 'string' || !cmd.includes('&&')) return false;
    let inSingle = false;
    let inDouble = false;
    let escaped = false;

    for (let i = 0; i < cmd.length; i++) {
        const char = cmd[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === '`' || char === '\\') {
            escaped = true;
            continue;
        }
        if (char === "'" && !inDouble) {
            inSingle = !inSingle;
            continue;
        }
        if (char === '"' && !inSingle) {
            inDouble = !inDouble;
            continue;
        }
        if (!inSingle && !inDouble && char === '&' && cmd[i + 1] === '&') {
            return true;
        }
    }
    return false;
}

/**
 * A `git commit` that does not name the Antigravity trailer (doc 36 M1). This hook is the one
 * place that knows for certain the caller is Antigravity: its environment exports no variable
 * the git hook could read (scripts/lib/agent-tool.mjs). Global options such as `-C dir` or
 * `-c key=value` may sit between `git` and `commit`.
 * @param {string} cmd
 */
export function isUntaggedCommit(cmd) {
    if (!/\bgit(?:\.exe)?(?:\s+-[cC]\s+\S+|\s+--[\w-]+(?:=\S+)?)*\s+commit\b/i.test(cmd)) return false;
    return !/Agent-Tool:\s*antigravity\b/i.test(cmd);
}

/**
 * Evaluates an Antigravity PreToolUse hook payload.
 *
 * @param {object} payload
 * @returns {{ decision: 'allow' | 'deny', reason?: string }}
 */
export function evaluateHookPayload(payload) {
    const command = extractCommand(payload);

    if (typeof command !== 'string' || !command.trim()) {
        return {
            decision: 'deny',
            reason:
                'antigravity-command-guard: could not extract command string from hook payload. Failing closed.',
        };
    }

    // The hook runs in the workspace, as Claude's does: its cwd lets a regex prefix be told from a path.
    const secrets = secretsReferenced(command, { cwds: [process.cwd()] });
    if (secrets.length > 0) {
        return {
            decision: 'deny',
            reason:
                `Blocked: this command references ${secrets.join(', ')} — a secret file. ` +
                'Secrets are never read by an agent (AGENTS.md §4, §9). `.env.example` is the readable template; ' +
                'env var names belong in docs/ops/15-setup-runbook.md. If you need a value, ask the human to provide it.',
        };
    }

    if (isUntaggedCommit(command)) {
        return {
            decision: 'deny',
            reason:
                'Blocked: an Antigravity commit carries an `Agent-Tool: antigravity` trailer, so outcomes can be '
                + 'measured per tool (doc 36 M1). Re-run the same command with `--trailer "Agent-Tool: antigravity"` added.',
        };
    }

    if (process.platform === 'win32' && hasUnquotedChaining(command)) {
        return {
            decision: 'deny',
            reason:
                "Blocked: command chaining with '&&' is not valid in Windows PowerShell and hides step failures. " +
                'Run each command as a separate step.',
        };
    }

    return { decision: 'allow' };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    let raw = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;

    let payload;
    try {
        payload = raw.trim() ? JSON.parse(raw) : {};
    } catch {
        console.log(
            JSON.stringify({
                decision: 'deny',
                reason: 'antigravity-command-guard: could not parse hook payload. Failing closed.',
            })
        );
        process.exit(0);
    }

    const decision = evaluateHookPayload(payload);
    console.log(JSON.stringify(decision));
    process.exit(0);
}
