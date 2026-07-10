/**
 * Humanizes an automation key for display, e.g. `pr_review` -> "PR Review",
 * `mcp_recommendations` -> "MCP Recommendations". Shared across the web
 * dashboard/analytics and server-side stats so automation labels stay
 * consistent wherever an automation key is surfaced to a human.
 */
const AUTOMATION_LABEL_ACRONYMS = new Set(['pr', 'ci', 'mcp']);

export function formatAutomationLabel(key: string): string {
  return key
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) =>
      AUTOMATION_LABEL_ACRONYMS.has(word)
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}
