import type { BackgroundAutomationKey } from '@roomote/types';

const AUTO_CLEAR_KEYS = new Set<BackgroundAutomationKey>([
  'dependabot_triage',
  'codeql_triage',
  'announcer',
  'code_quality_auditor',
  'platform_issue_alerts',
]);

/**
 * Only clear an unambiguous, terse no-op. A substantive report may mention
 * zero findings while also describing an access gap, a failure, or work done.
 */
export function isEmptyAutomationOutcome(
  automationKey: BackgroundAutomationKey,
  content: string,
): boolean {
  if (!AUTO_CLEAR_KEYS.has(automationKey)) return false;

  const text = content.replace(/[*_`]/gu, '').trim();
  if (
    !text ||
    text.length > 350 ||
    text.includes('[') ||
    text.includes(']') ||
    /[{}|#?]/u.test(text)
  )
    return false;

  const statements = text
    .split(/(?:[.!?](?:\s|$)|;\s*|\n+)/u)
    .map((statement) => statement.trim().replace(/[.!?]$/u, ''))
    .filter(Boolean);
  if (!statements.length) return false;

  return statements.every(
    (statement) =>
      /^(?:(?:scan|run|audit|triage)(?: complete| completed)?(?::| —| -)\s*)?(?:no|zero|0)\s+(?:(?:open|new|actionable|qualifying|relevant|merged|config(?:uration)?)\s+)*(?:alerts?|issues?|errors?|findings?|results?|output|items?|pull requests?|prs?|follow[- ]?ups?|work items?|remediation(?: work)?)(?:\s+(?:found|identified|detected|needed|required|to report|to summarize|to act on|submitted|started|created|posted|in (?:this|the) (?:scan|run|window)))?$/iu.test(
        statement,
      ) ||
      /^(?:nothing (?:to report|actionable|to summarize)|no action (?:needed|required)|no (?:follow[- ]?up|remediation|work items?) (?:needed|required|submitted|started|created))$/iu.test(
        statement,
      ),
  );
}
