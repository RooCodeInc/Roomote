import { randomUUID } from 'node:crypto';

import {
  createFastAgentTaskLauncher,
  type LaunchFastAgentTask,
} from '@roomote/cloud-agents/server';
import { asc, db, eq, users } from '@roomote/db/server';
import type { LinearClient } from '@roomote/linear';
import {
  ALL_REPOSITORIES,
  buildFastAgentChildTaskMetadata,
  TaskPayloadKind,
  type FastAgentConversation,
} from '@roomote/types';

const LINEAR_MCP_URL = 'https://mcp.linear.app/mcp';

export type LinearFastConversation = Extract<
  FastAgentConversation,
  { surface: 'linear' }
>;

/**
 * A Linear agent session is one Fast conversation: the organization is the
 * workspace and the session id is both the identity and the reply target.
 */
export function buildLinearFastConversation(input: {
  organizationId: string;
  agentSessionId: string;
}): LinearFastConversation {
  return {
    surface: 'linear',
    workspaceId: input.organizationId,
    conversationId: input.agentSessionId,
    replyTarget: { channelId: input.agentSessionId },
  };
}

/**
 * The deployment's Linear client for an organization, or null when the
 * organization is not connected or its token cannot be refreshed.
 */
export async function resolveLinearFastSessionClient(
  organizationId: string,
): Promise<LinearClient | null> {
  // Loaded on use: the MCP data layer and the Linear package pull in the
  // whole schema, and this module sits on the Fast delivery path that many
  // lighter callers import.
  const [
    { findLinearDeploymentMcpConnectionByIdentity },
    { getValidAccessToken },
    { createLinearClient },
  ] = await Promise.all([
    import('./mcp/linear-connections'),
    import('./mcp/data'),
    import('@roomote/linear'),
  ]);
  const connection = await findLinearDeploymentMcpConnectionByIdentity({
    linearOrganizationId: organizationId,
  });
  if (!connection) {
    return null;
  }
  const accessToken = await getValidAccessToken(connection.id, LINEAR_MCP_URL);
  return accessToken ? createLinearClient(accessToken) : null;
}

/**
 * Direct issue delegations can arrive without any human identity. The signed
 * webhook and the organization connection make them trusted, and the
 * deployment's first administrator owns the Session they run in.
 */
export async function resolveLinearAutomationLaunchUserId(): Promise<
  string | null
> {
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'admin'))
    .orderBy(asc(users.createdAt))
    .limit(1);
  return admin?.id ?? null;
}

type LinearAgentSessionIssue = NonNullable<
  Awaited<ReturnType<LinearClient['getAgentSessionIssue']>>
>;

/**
 * Delegated work from a Linear Session is a standard task bound to the agent
 * session and linked to its issue. The Session owns every reply into Linear;
 * the child only reports to its orchestrator.
 */
export function createFastAgentLinearTaskLauncher(params: {
  userId: string;
  conversation: LinearFastConversation;
  resolveIssue: () => Promise<LinearAgentSessionIssue | null>;
}): LaunchFastAgentTask {
  const agentSessionId = params.conversation.replyTarget.channelId;
  let issuePromise: Promise<LinearAgentSessionIssue | null> | undefined;
  const loadIssue = () => (issuePromise ??= params.resolveIssue());

  return async (input) => {
    const issue = await loadIssue();
    const launch = createFastAgentTaskLauncher({
      userId: params.userId,
      surface: 'linear',
      taskUrlCampaign: 'fast-delegation',
      channels: {
        linearSessionId: agentSessionId,
        linearOrganizationId: params.conversation.workspaceId,
        ...(issue ? { linearIssueId: issue.id } : {}),
      },
      buildTask: ({
        prompt,
        environmentId,
        model,
        reasoningEffort,
        parentSessionId,
      }) => ({
        type: TaskPayloadKind.StandardTask,
        payload: {
          repo: ALL_REPOSITORIES,
          description: prompt,
          ...(issue
            ? {
                linkedWorkItems: [
                  {
                    provider: 'linear' as const,
                    identifier: issue.identifier,
                    url: issue.url,
                    title: issue.title,
                  },
                ],
              }
            : {}),
          ...buildFastAgentChildTaskMetadata({
            sessionId: parentSessionId,
            conversation: params.conversation,
          }),
          ...(environmentId && environmentId !== ALL_REPOSITORIES
            ? { environmentId }
            : {}),
          ...(model
            ? { harnessModelOverrides: { 'opencode-server': model } }
            : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
        },
      }),
    });
    return launch(input);
  };
}

/** Stable id for a Linear response activity, which Linear does not return. */
export function buildLinearFastReplyMessageId(): string {
  return `linear-response:${randomUUID()}`;
}
