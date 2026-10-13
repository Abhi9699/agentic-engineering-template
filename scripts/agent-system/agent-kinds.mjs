/**
 * Which agents.json entries this repository generates a subagent for (doc 34 W5).
 *
 * An entry with no `runtime` is a generated subagent: it gets adapters for every provider
 * it claims, an instructions `_shared.md`, a budgets.json model tier and a context budget.
 * `runtime: "main-session"` is the session the user drives, which builds inline;
 * `runtime: "built-in"` is a subagent the provider ships (Claude Explore). Both still sit in
 * the graph — routes name them, they supply capabilities and sign evidence — but nothing is
 * generated for them, so every adapter, parity and budget check skips them through this.
 */

/** @param {{ status?: string, runtime?: string }} agent */
export function isGeneratedSubagent(agent) {
    return agent.status === 'active' && !agent.runtime;
}
