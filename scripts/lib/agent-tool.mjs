/**
 * Which coding agent is running this process, read from the environment it exports (doc 36 M1).
 *
 * WHY: 622 commits carried a Claude co-author trailer and Antigravity's commits could not be
 * told apart from the owner's, so no outcome (gate failures, fix commits) could be measured
 * per tool. Measured 2026-10-11:
 * - Claude Code exports `CLAUDECODE=1` and `AI_AGENT=claude-code_<version>_agent`.
 * - Antigravity's own variable is unknown, and the machine-wide `ANTIGRAVITY_CLI_ALIAS` is
 *   visible inside Claude sessions too, so it is deliberately NOT read here. Antigravity is
 *   identified by its own command guard instead (antigravity-command-guard.mjs).
 *
 * `AGENT_TOOL` is an explicit override any tool's terminal profile can set.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string} 'claude', another tool's name, or '' when no agent is detected
 */
export function detectTool(env = process.env) {
    const clean = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    const explicit = clean(env.AGENT_TOOL);
    if (explicit) return explicit;
    const ai = String(env.AI_AGENT ?? '').toLowerCase();
    if (env.CLAUDECODE === '1' || ai.startsWith('claude')) return 'claude';
    return clean(ai.split('_')[0]);
}
