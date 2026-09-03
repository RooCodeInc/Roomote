import { getOrCreateFastAgentSession } from '@roomote/cloud-agents/server';
import { db, getSessionForFastConversation } from '@roomote/db/server';
import { Env } from '@roomote/env';
import type { AgentSessionEventPayload, LinearClient } from '@roomote/linear';

import { queueFastAgentSurfaceReply } from './fast-agent-surface-reply';
import { buildLinearFastConversation } from './linear-fast-session';

function formatLinearComment(comment: {
  body: string;
  user?: { name: string };
  createdAt?: string;
}): string {
  const author = comment.user?.name ?? 'Unknown';
  const when = comment.createdAt ? ` (${comment.createdAt})` : '';
  return `${author}${when}:\n${comment.body}`;
}

/**
 * What the Session reads with a Linear event: the issue, the discussion so
 * far on the first turn, and any agent guidance the workspace configured.
 */
/**
 * Assigning an issue to the agent makes Linear author a stub comment such as
 * "This thread is for an agent session with @roomote." That is plumbing, not
 * a request: a Session handed the stub would acknowledge the thread instead
 * of working the issue, so it falls through to the work-on-issue prompt.
 */
function isLinearDelegationStub(text: string): boolean {
  return /^this thread is for an agent session\b/i.test(text);
}

function normalizeLinearRequestText(
  text: string | undefined,
): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed || isLinearDelegationStub(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function buildLinearFastTurn(input: {
  payload: AgentSessionEventPayload;
  agentSession: AgentSessionEventPayload['agentSession'];
}): {
  question: string;
  agentContext: string;
  currentMessageId: string;
  senderDisplayName: string | null;
} {
  const { payload, agentSession } = input;
  const issue = agentSession.issue;
  const promptBody = normalizeLinearRequestText(
    payload.agentActivity?.content?.body,
  );
  const firstTurn = payload.action !== 'prompted';
  const question =
    (firstTurn
      ? normalizeLinearRequestText(agentSession.comment?.body)
      : promptBody) ||
    promptBody ||
    `Work on ${issue.identifier}: ${issue.title}`;

  const contextParts = [
    `<linear_issue identifier="${issue.identifier}" url="${issue.url}">`,
    `Title: ${issue.title}`,
    ...(issue.description ? [`Description:\n${issue.description}`] : []),
    ...(issue.team?.name ? [`Team: ${issue.team.name}`] : []),
    ...(issue.project?.name ? [`Project: ${issue.project.name}`] : []),
    '</linear_issue>',
  ];
  // Stub comments are plumbing on the issue too; keep them out of the
  // discussion the Session reads.
  const previousComments = (
    firstTurn ? (agentSession.previousComments ?? []) : []
  ).filter((comment) => !isLinearDelegationStub(comment.body.trim()));
  if (previousComments.length > 0) {
    contextParts.push(
      '<issue_comments>',
      previousComments.map(formatLinearComment).join('\n\n'),
      '</issue_comments>',
    );
  }
  const guidance = [
    agentSession.guidance?.system,
    agentSession.guidance?.instructions,
  ]
    .filter((part): part is string => Boolean(part?.trim()))
    .join('\n\n');
  if (guidance) {
    contextParts.push(
      '<workspace_guidance>',
      guidance,
      '</workspace_guidance>',
    );
  }
  contextParts.push(
    'This conversation is a Linear agent session on the issue above. Your replies post to the session as agent responses, so keep them concise and link the issue when delegating work.',
  );

  const sender = agentSession.user ?? agentSession.creator;
  return {
    question,
    agentContext: contextParts.join('\n'),
    currentMessageId:
      payload.agentActivity?.id ??
      `linear:${agentSession.id}:${payload.action}:${payload.webhookTimestamp}`,
    senderDisplayName: sender?.name?.trim() || null,
  };
}

export type StartLinearFastSessionTurnResult =
  | { status: 'queued'; fastConversationId: string }
  | { status: 'unavailable'; reason: string };

/**
 * Enters a Linear agent session event into its Fast Session. The first turn
 * links the Session page from Linear so the person can follow along; every
 * turn is queued so a busy Session steers or replays it instead of dropping
 * it.
 */
export async function startLinearFastSessionTurn(input: {
  payload: AgentSessionEventPayload;
  agentSession: AgentSessionEventPayload['agentSession'];
  userId: string;
  linearClient: LinearClient;
}): Promise<StartLinearFastSessionTurnResult> {
  const { payload, agentSession, userId } = input;
  const conversation = buildLinearFastConversation({
    organizationId: payload.organizationId,
    agentSessionId: agentSession.id,
  });
  const turn = buildLinearFastTurn({ payload, agentSession });
  const fastSession = await getOrCreateFastAgentSession({
    userId,
    conversation,
  });

  if (fastSession.created) {
    const session = await getSessionForFastConversation(db, fastSession.id);
    if (session) {
      await input.linearClient
        .updateSessionExternalUrls(agentSession.id, [
          {
            label: 'Open in Roomote',
            url: `${Env.R_APP_URL}/sessions/${session.id}`,
          },
        ])
        .catch((error) => {
          console.warn(
            `[LinearFastSession] Could not link the Session from agent session ${agentSession.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
  }

  const queued = await queueFastAgentSurfaceReply({
    sessionId: fastSession.id,
    userId,
    senderDisplayName: turn.senderDisplayName,
    question: turn.question,
    agentContext: turn.agentContext,
    currentMessageId: turn.currentMessageId,
  });
  if (!queued) {
    return {
      status: 'unavailable',
      reason: 'The Linear organization is not connected or its token expired.',
    };
  }
  return { status: 'queued', fastConversationId: fastSession.id };
}
