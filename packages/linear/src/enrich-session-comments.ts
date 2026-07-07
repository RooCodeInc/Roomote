import type { LinearClient } from './linear-client';
import type { AgentSession, LinearComment } from './types';

/**
 * Enrich an agent session's previousComments by fetching all comments
 * for the issue from the Linear API.
 *
 * The webhook payload's previousComments may not include comments from
 * external sources (synced GitHub issues, Slack threads, etc.). This
 * function fetches all comments via the API and returns a new agentSession
 * with a complete set of previousComments.
 *
 * If the API call fails, the original previousComments from the webhook
 * are preserved as a fallback.
 *
 * @param linearClient - An authenticated LinearClient instance
 * @param agentSession - The agent session from the webhook payload
 * @returns A new agentSession with enriched previousComments
 */
export async function enrichSessionComments(
  linearClient: LinearClient,
  agentSession: AgentSession,
): Promise<AgentSession> {
  const issueId = agentSession.issue.id;
  const triggeringCommentId = agentSession.comment?.id;

  try {
    const result = await linearClient.getIssueComments(issueId);

    if (!result.success || !result.comments) {
      console.warn(
        `[enrichSessionComments] Failed to fetch comments for issue ${issueId}: ${result.error ?? 'unknown error'}, using webhook previousComments as fallback`,
      );
      return agentSession;
    }

    // Filter out the triggering comment to avoid duplication with commentBody
    const enrichedComments: LinearComment[] = result.comments.filter(
      (c) => c.id !== triggeringCommentId,
    );

    const webhookCount = agentSession.previousComments?.length ?? 0;
    const apiCount = enrichedComments.length;

    if (apiCount > webhookCount) {
      console.log(
        `[enrichSessionComments] Enriched comments for issue ${issueId}: ` +
          `webhook had ${webhookCount}, API returned ${apiCount} ` +
          `(${apiCount - webhookCount} additional comments found)`,
      );
    } else {
      console.log(
        `[enrichSessionComments] Comments for issue ${issueId}: ` +
          `webhook had ${webhookCount}, API returned ${apiCount}`,
      );
    }

    return {
      ...agentSession,
      previousComments: enrichedComments,
    };
  } catch (error) {
    console.error(
      `[enrichSessionComments] Unexpected error enriching comments for issue ${issueId}: ` +
        `${error instanceof Error ? error.message : String(error)}, using webhook previousComments as fallback`,
    );
    return agentSession;
  }
}
