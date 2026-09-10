export const FAST_AGENT_MODEL_ROLE = 'orchestration' as const;

// Generous ceiling on one fast-agent turn: long enough for delegation-heavy
// responses, short enough that a crashed turn self-heals the session status.
// Streaming touch points re-extend it so long turns keep the lease fresh.
export const FAST_RESPONDING_LEASE_MS = 15 * 60 * 1000;
// Assistant-message persists also extend the lease, but a turn can spend
// longer than the lease inside tool calls or a streaming stretch without
// persisting one; the time-based renewal keeps the lease fresh for exactly
// as long as the turn is actually executing.
export const FAST_RESPONDING_LEASE_RENEW_MS = FAST_RESPONDING_LEASE_MS / 3;
export const FAST_AGENT_GITHUB_MCP_PATH = '/api/mcp-routing/github';
export const FAST_AGENT_TASKS_API_PATH = '/api/mcp/tasks';
export const FAST_AGENT_ENVIRONMENTS_API_PATH = '/api/mcp/environments';
