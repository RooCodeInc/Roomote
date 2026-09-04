import {
  fastAgentConversationRepository,
  getOrCreateFastAgentSession,
  type FastAgentActiveTask,
} from '@roomote/cloud-agents/server';
import { db, getSessionForTask } from '@roomote/db/server';
import type { FastAgentConversation } from '@roomote/types';

import { admitFastAgentHumanFollowUp } from './fast-agent-human-follow-up';
import { queueFastAgentSurfaceReply } from './fast-agent-surface-reply';
import {
  buildSourceControlDiscussionUrl,
  buildSourceControlFastConversation,
  type SourceControlFastDiscussion,
} from './source-control-fast-delivery';

export type StartSourceControlFastSessionTurnResult =
  | {
      status: 'queued';
      fastConversationId: string;
      /**
       * The message joined the Session that already owns this discussion
       * through a task, instead of the discussion's own Session.
       */
      joinedOwningSession?: true;
    }
  | { status: 'unavailable' };

type OwningFastSession = {
  id: string;
  conversation: FastAgentConversation;
};

const PROVIDER_LABELS: Record<SourceControlFastDiscussion['provider'], string> =
  {
    github: 'GitHub',
    gitlab: 'GitLab',
    bitbucket: 'Bitbucket',
    ado: 'Azure DevOps',
    gitea: 'Gitea',
  };

/**
 * The Session that owns this discussion through one of its tasks, when that
 * Session lives somewhere else: the Slack thread or web Session whose task
 * opened the pull request. The first active task with a Session decides; a
 * task that belongs to the discussion's own Session means the discussion is
 * already home and nothing is rerouted.
 */
async function findOwningFastSession({
  conversation,
  activeTasks,
}: {
  conversation: FastAgentConversation;
  activeTasks: FastAgentActiveTask[];
}): Promise<OwningFastSession | null> {
  for (const task of activeTasks) {
    const session = await getSessionForTask(db, task.taskId).catch(() => null);
    if (!session?.fastConversationId) {
      continue;
    }
    const record = await fastAgentConversationRepository
      .findById({ id: session.fastConversationId })
      .catch(() => null);
    if (!record) {
      continue;
    }
    const owner = record.conversation;
    if (
      owner.surface === conversation.surface &&
      owner.workspaceId === conversation.workspaceId &&
      owner.conversationId === conversation.conversationId
    ) {
      return null;
    }
    return { id: record.id, conversation: owner };
  }
  return null;
}

function buildOwningSessionContext({
  discussion,
  senderDisplayName,
  url,
  agentContext,
}: {
  discussion: SourceControlFastDiscussion;
  senderDisplayName: string | null;
  url: string;
  agentContext: string;
}): string {
  const noun = discussion.kind === 'pull' ? 'pull request' : 'issue';
  const who = senderDisplayName?.trim() || 'A teammate';
  return [
    `${who} posted this message on ${PROVIDER_LABELS[discussion.provider]} ${noun} ${discussion.repositoryFullName}#${discussion.number} (${url}), which a task in this Session opened. Your replies in this turn are posted on that ${noun} as well as in this conversation, so write for both audiences.`,
    '',
    agentContext,
  ].join('\n');
}

/**
 * Enters a mention into the discussion's Fast Session. Turns are queued so
 * a busy Session steers or replays them instead of dropping them.
 *
 * When a task in another Session opened the discussion (a Slack Session's
 * task opened this pull request), the mention joins that Session instead, so
 * one transcript holds the conversation and the pull request it produced. The
 * Session answers on the discussion and on its home surface.
 */
export async function startSourceControlFastSessionTurn(input: {
  discussion: SourceControlFastDiscussion;
  userId: string;
  senderDisplayName: string | null;
  question: string;
  agentContext: string;
  currentMessageId: string;
  activeTasks?: FastAgentActiveTask[];
}): Promise<StartSourceControlFastSessionTurnResult> {
  const conversation = buildSourceControlFastConversation(input.discussion);
  const activeTasks = input.activeTasks ?? [];

  const owningSession = await findOwningFastSession({
    conversation,
    activeTasks,
  });
  if (owningSession) {
    const url = buildSourceControlDiscussionUrl(input.discussion);
    const admission = await admitFastAgentHumanFollowUp({
      parent: {
        sessionId: owningSession.id,
        conversation: owningSession.conversation,
      },
      event: {
        type: 'human_follow_up',
        eventId: input.currentMessageId,
        currentMessageId: input.currentMessageId,
        userId: input.userId,
        question: input.question,
        ...(input.senderDisplayName
          ? { senderDisplayName: input.senderDisplayName }
          : {}),
        agentContext: buildOwningSessionContext({
          discussion: input.discussion,
          senderDisplayName: input.senderDisplayName,
          url,
          agentContext: input.agentContext,
        }),
        ...(activeTasks.length ? { activeTasks } : {}),
        sourceControlReplyTarget: {
          provider: input.discussion.provider,
          host: input.discussion.host,
          repositoryFullName: input.discussion.repositoryFullName,
          kind: input.discussion.kind,
          number: input.discussion.number,
          ...(input.discussion.reviewCommentId
            ? { reviewCommentId: input.discussion.reviewCommentId }
            : {}),
          ...(input.discussion.replyCommentId
            ? { replyCommentId: input.discussion.replyCommentId }
            : {}),
          url,
        },
      },
      forceQueue: true,
    });
    if (admission.kind === 'queued') {
      return {
        status: 'queued',
        fastConversationId: owningSession.id,
        joinedOwningSession: true,
      };
    }
  }

  const fastSession = await getOrCreateFastAgentSession({
    userId: input.userId,
    conversation,
  });
  const queued = await queueFastAgentSurfaceReply({
    sessionId: fastSession.id,
    userId: input.userId,
    senderDisplayName: input.senderDisplayName,
    question: input.question,
    agentContext: input.agentContext,
    currentMessageId: input.currentMessageId,
    ...(activeTasks.length ? { activeTasks } : {}),
  });
  return queued
    ? { status: 'queued', fastConversationId: fastSession.id }
    : { status: 'unavailable' };
}
