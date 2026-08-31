import {
  fastAgentConversationRepository,
  getTaskUrl,
} from '@roomote/cloud-agents/server';
import {
  and,
  db,
  eq,
  getCustomAutomationById,
  slackInstallations,
  taskRuns,
} from '@roomote/db/server';
import { acquireRedisLock } from '@roomote/redis';
import {
  acquireSlackFastRootBindingLock,
  buildSlackRequestUserInputBlocks,
  getPendingSlackRequestUserInput,
  setPendingSlackRequestUserInput,
  SlackNotifier,
} from '@roomote/slack';
import {
  type AcpRequestUserInputQuestion,
  getFastAgentParentFromPayload,
} from '@roomote/types';

import { buildSlackClientMessageId } from '../fast-agent-parent-event';
import { buildCustomAutomationSlackMessage } from '../manager-slack';

const PUBLISH_LOCK_TTL_SECONDS = 10;
const PUBLISH_LOCK_ATTEMPTS = 20;
const PUBLISH_LOCK_RETRY_MS = 100;

async function waitForPublishRetry(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, PUBLISH_LOCK_RETRY_MS));
}

function getCustomAutomationId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const value = (payload as { customAutomationId?: unknown })
    .customAutomationId;
  return typeof value === 'string' && value ? value : null;
}

/**
 * Publish a structured prompt requested by a Fast-delegated child into the
 * parent Slack thread. The child never receives Slack credentials and never
 * owns prose delivery; this is a platform-rendered input control.
 */
export async function publishFastAgentRequestUserInput(input: {
  runId: number;
  requestId: string;
  taskId: string;
  questions: AcpRequestUserInputQuestion[];
}): Promise<{ published: boolean; messageTs?: string }> {
  const run = await db.query.taskRuns.findFirst({
    where: and(eq(taskRuns.id, input.runId), eq(taskRuns.taskId, input.taskId)),
    columns: { id: true, taskId: true, payload: true },
  });
  const parent = getFastAgentParentFromPayload(run?.payload);

  if (!run || !parent || parent.conversation.surface !== 'slack') {
    return { published: false };
  }

  const [session, installation] = await Promise.all([
    fastAgentConversationRepository.findById({
      id: parent.sessionId,
      fallbackConversation: parent.conversation,
    }),
    db.query.slackInstallations.findFirst({
      where: and(
        eq(slackInstallations.isActive, true),
        eq(slackInstallations.teamId, parent.conversation.workspaceId),
      ),
      columns: { botAccessToken: true },
    }),
  ]);

  if (
    !session ||
    session.conversation.surface !== 'slack' ||
    !installation?.botAccessToken
  ) {
    return { published: false };
  }

  const { workspaceId, replyTarget } = session.conversation;
  const { channelId } = replyTarget;
  let { threadId } = replyTarget;
  const slack = new SlackNotifier(installation.botAccessToken);
  if (!threadId) {
    const customAutomationId = getCustomAutomationId(run.payload);
    const automation = customAutomationId
      ? await getCustomAutomationById(customAutomationId)
      : null;
    if (!customAutomationId || !automation) {
      return { published: false };
    }

    const releaseRootBindingLock = await acquireSlackFastRootBindingLock({
      teamId: workspaceId,
      channelId,
    });
    try {
      const canonicalSession = await fastAgentConversationRepository.findById({
        id: session.id,
        fallbackConversation: session.conversation,
      });
      if (
        !canonicalSession ||
        canonicalSession.conversation.surface !== 'slack'
      ) {
        return { published: false };
      }

      threadId = canonicalSession.conversation.replyTarget.threadId;
      if (!threadId) {
        const text = `${automation.name} needs input to continue.`;
        threadId = await slack.postMessage({
          channel: channelId,
          ...buildCustomAutomationSlackMessage({
            automationId: customAutomationId,
            automationName: automation.name,
            text,
            contentBlocks: [{ type: 'markdown', text }],
            sessionId: session.id,
            taskUrl: getTaskUrl({
              taskId: input.taskId,
              utm: {
                source: 'slack',
                campaign: 'fast-automation-request-input',
              },
            }),
          }),
          unfurl_links: false,
          unfurl_media: false,
          client_msg_id: buildSlackClientMessageId(
            `fast-automation-input-root:${session.id}`,
          ),
        });
        if (!threadId) {
          throw new Error(
            'Slack did not create the Fast automation input thread.',
          );
        }

        await fastAgentConversationRepository.getOrCreate({
          userId: canonicalSession.userId,
          conversation: {
            ...canonicalSession.conversation,
            replyTarget: {
              ...canonicalSession.conversation.replyTarget,
              threadId,
            },
          },
        });
      }
    } finally {
      await releaseRootBindingLock().catch(() => {});
    }
  }

  const lockKey = `fast-agent:request-user-input:publish:${workspaceId}:${channelId}:${threadId}`;
  let releaseLock: Awaited<ReturnType<typeof acquireRedisLock>> = null;

  for (
    let attempt = 0;
    attempt < PUBLISH_LOCK_ATTEMPTS && !releaseLock;
    attempt += 1
  ) {
    releaseLock = await acquireRedisLock(lockKey, {
      ttlSeconds: PUBLISH_LOCK_TTL_SECONDS,
    });
    if (!releaseLock && attempt + 1 < PUBLISH_LOCK_ATTEMPTS) {
      await waitForPublishRetry();
    }
  }

  if (!releaseLock) {
    throw new Error('Timed out publishing Fast request_user_input prompt.');
  }

  try {
    const existing = await getPendingSlackRequestUserInput(threadId);

    if (existing && existing.requestId !== input.requestId) {
      // A child can only wait on one structured prompt at a time. Preserve the
      // prompt already visible to the user instead of silently replacing it.
      return { published: false, messageTs: existing.promptMessageTs };
    }

    if (existing?.status === 'submitted') {
      return { published: true, messageTs: existing.promptMessageTs };
    }

    const pendingRequest = {
      requestId: input.requestId,
      runId: input.runId,
      taskId: input.taskId,
      questions: input.questions,
      ...(existing
        ? {
            createdAt: existing.createdAt,
            status: existing.status,
            currentQuestionIndex: existing.currentQuestionIndex,
            answers: existing.answers,
            promptMessageTs: existing.promptMessageTs,
          }
        : {}),
    };

    await setPendingSlackRequestUserInput(threadId, pendingRequest);

    const blocks = buildSlackRequestUserInputBlocks({
      requestId: input.requestId,
      questions: input.questions,
      currentQuestionIndex: existing?.currentQuestionIndex,
      answers: existing?.answers,
    });
    const updated = existing?.promptMessageTs
      ? await slack.updateMessage({
          channel: channelId,
          ts: existing.promptMessageTs,
          message: { blocks },
        })
      : false;
    const messageTs = updated
      ? existing?.promptMessageTs
      : await slack.postMessage({
          channel: channelId,
          thread_ts: threadId,
          blocks,
          client_msg_id: buildSlackClientMessageId(input.requestId),
        });

    if (!messageTs) {
      throw new Error('Slack did not return a request_user_input timestamp.');
    }

    await setPendingSlackRequestUserInput(threadId, {
      ...pendingRequest,
      promptMessageTs: messageTs,
    });

    return { published: true, messageTs };
  } finally {
    await releaseLock().catch(() => {});
  }
}
