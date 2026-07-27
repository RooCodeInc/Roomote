/**
 * Slack-posting Roomote MCP tools that only the parent OpenCode session may
 * use. Subagent sessions must return their report to the parent agent, which
 * relays any Slack-visible update, instead of posting duplicate thread
 * messages themselves.
 *
 * Two enforcement layers consume this list and stay in sync through it:
 *
 * 1. Config exclusion (primary): the generated OpenCode agent configs in
 *    `agent-home.ts` disable these tools (`tools: { <name>: false }`) for
 *    every worker-defined subagent and for OpenCode's built-in `general`
 *    agent, so subagent sessions never see the tools at all.
 * 2. Hook deny (backstop): the Slack silence hook
 *    (`slack-silence-hook-script.ts`) hard-denies these tools from any
 *    non-parent session on PreToolUse with reason `subagent_slack_post`.
 *    This stays default-closed for agent types the generated configs do not
 *    cover (e.g. user-defined custom agents).
 */
export const SLACK_POSTING_TOOL_BASENAMES = [
  'send_chat_reply',
  'send_chat_reaction_emoji',
  'add_reaction_to_slack_message',
  'post_to_channel',
  'reply_to_slack_thread',
] as const;

/**
 * The same tools as registered on the roomote MCP server, in the
 * `<server>_<tool>` form OpenCode uses for agent-level tool exclusions
 * (`tools` is the deprecated-but-supported alias that normalizes into
 * per-tool `permission` rules).
 */
export const SLACK_POSTING_TOOL_EXCLUSIONS: Readonly<Record<string, false>> =
  Object.fromEntries(
    SLACK_POSTING_TOOL_BASENAMES.map((name) => [
      `roomote_${name}`,
      false as const,
    ]),
  );
