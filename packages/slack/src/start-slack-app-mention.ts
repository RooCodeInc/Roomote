import {
  getSlackThreadDisplayName,
  wrapSlackMessage,
  wrapSlackReplyingTo,
  wrapSlackThreadContext,
  wrapSlackTurnPolicy,
} from '@roomote/cloud-agents';
import { enqueueTask } from '@roomote/cloud-agents/server';
import { db, eq, sql, taskRuns } from '@roomote/db/server';
import {
  type ReasoningEffort,
  type SlackAppMentionTask,
  type TaskInitiator,
  type TaskTrigger,
  type TaskVisibility,
  type TaskWorkflow,
  TaskPayloadKind,
  getSlackConversationUrlFromTaskPayload,
  resolveEvalHarnessSelection,
} from '@roomote/types';

import { findActiveSlackTaskRun } from './find-active-slack-task-run';
import { resolveSlackReactionNames } from './emoji-preferences';
import {
  type SlackStartedMessageData,
  queueSlackMessage,
} from './slack-messages';
import { isSlackStartedTaskMessage } from './slack-thread-message-utils';
import type { SlackThreadMessage } from './types';

function compareSlackTimestamps(left: string, right: string): number {
  return Number(left) - Number(right);
}

/**
 * Resolves the linked Roomote user id carried by an initiator, if any.
 * Automation initiators and unmatched external senders have none.
 */
function getLinkedInitiatorUserId(
  initiator: TaskInitiator,
): string | undefined {
  if (initiator.kind !== 'user') {
    return undefined;
  }

  return 'userId' in initiator ? initiator.userId : initiator.matchedUserId;
}

function buildActiveSlackFollowUpPrompt(input: {
  text: string;
  agentContext?: string;
  ts: string;
  threadMessages?: SlackThreadMessage[];
  latestOwnBotReplyText?: string;
  latestOwnBotReplyTs?: string;
}): { formattedPrompt: string; reactionsAllowed: boolean } {
  const earlierMessages = (input.threadMessages ?? []).filter(
    (message) => compareSlackTimestamps(message.ts, input.ts) < 0,
  );
  const latestOwnBotReply =
    input.latestOwnBotReplyText?.trim() && input.latestOwnBotReplyTs?.trim()
      ? {
          text: input.latestOwnBotReplyText,
          ts: input.latestOwnBotReplyTs,
        }
      : null;
  const hasPriorBotReply = Boolean(latestOwnBotReply);
  const contextBlock = wrapSlackThreadContext(
    earlierMessages.map((message) => ({
      displayName: getSlackThreadDisplayName(message),
      text: message.text,
      ts: message.ts,
    })),
  );
  const replyingToBlock =
    latestOwnBotReply && hasPriorBotReply
      ? wrapSlackReplyingTo({
          displayName: 'Roomote',
          text: latestOwnBotReply.text,
          ts: latestOwnBotReply.ts,
        })
      : undefined;

  return {
    formattedPrompt: [
      contextBlock,
      replyingToBlock,
      wrapSlackTurnPolicy({
        reactionsAllowed: hasPriorBotReply,
        preferEmojiAck: hasPriorBotReply,
      }),
      wrapSlackMessage(input.text, {
        ts: input.ts,
        agentContext: input.agentContext,
      }),
    ]
      .filter(Boolean)
      .join('\n\n'),
    reactionsAllowed: hasPriorBotReply,
  };
}

export async function startSlackAppMentionTask(input: {
  /**
   * Who initiated the launch. Stamped immutably onto the task row; the
   * initiator union carries identity, so no separate userId is required.
   */
  initiator: TaskInitiator;
  /** What caused the launch ('message' for mentions, 'manual' for buttons). */
  trigger: TaskTrigger;
  /** Defaults to 'standard'; the Slack `!eval` launcher passes 'eval'. */
  workflow?: Extract<TaskWorkflow, 'standard' | 'eval'>;
  visibility?: TaskVisibility;
  channel: string;
  teamId: string;
  teamDomain?: string;
  slackUserId: string;
  persistedSlackUserId?: string | null;
  text: string;
  slackMessageContext?: string;
  agentPromptText?: string;
  /**
   * Deprecated: acknowledgement/completion reactions are fixed defaults and
   * cannot be customized. Kept on the input type only for call-site
   * compatibility; values are ignored.
   */
  ackEmoji?: string;
  completionEmoji?: string;
  ts: string;
  threadTs: string;
  repo: string;
  branch?: string;
  sha?: string;
  harness?: string;
  model?: string;
  environmentId?: string;
  reasoningEffort?: ReasoningEffort;
  readinessMessage?: string;
  images?: string[];
  threadMessages?: SlackThreadMessage[];
  latestOwnBotReplyText?: string;
  latestOwnBotReplyTs?: string;
  webPath?: string;
  slackConversationUrl?: string;
  skipInitialActingUser?: boolean;
  /**
   * Started-message metadata callers persist themselves via
   * setSlackStartedMessageTs after the launch. Accepted here so call sites
   * can keep one launch-shaped object; the wrapper does not consume it.
   */
  queuedStartedMessage?: SlackStartedMessageData;
}): Promise<{
  id: number | null;
  taskId: string | null;
  reusedExistingRun: boolean;
}> {
  const activeRun = await findActiveSlackTaskRun(input.threadTs, {
    slackTeamId: input.teamId,
  });
  const linkedInitiatorUserId = getLinkedInitiatorUserId(input.initiator);
  const promptRelevantThreadMessages = input.threadMessages?.length
    ? input.threadMessages.filter(
        (message) => !isSlackStartedTaskMessage(message),
      )
    : undefined;
  const latestOwnBotReplyInput =
    input.latestOwnBotReplyText?.trim() && input.latestOwnBotReplyTs?.trim()
      ? {
          text: input.latestOwnBotReplyText,
          ts: input.latestOwnBotReplyTs,
        }
      : null;
  const promptRelevantLatestOwnBotReply =
    latestOwnBotReplyInput &&
    !isSlackStartedTaskMessage({
      ...latestOwnBotReplyInput,
      bot_id: 'BROOMOTE',
    })
      ? latestOwnBotReplyInput
      : undefined;
  if (activeRun) {
    const agentPromptText = input.agentPromptText?.trim();
    const agentContext = [agentPromptText, input.slackMessageContext]
      .filter((value): value is string => Boolean(value))
      .join('\n\n');
    const builtPrompt = buildActiveSlackFollowUpPrompt({
      text: input.text,
      agentContext: agentContext || undefined,
      ts: input.ts,
      threadMessages: promptRelevantThreadMessages,
      latestOwnBotReplyText: promptRelevantLatestOwnBotReply?.text,
      latestOwnBotReplyTs: promptRelevantLatestOwnBotReply?.ts,
    });
    const formattedPrompt = builtPrompt.formattedPrompt;
    const turnPolicy = { reactionsAllowed: builtPrompt.reactionsAllowed };
    const slackConversationUrl = input.slackConversationUrl?.trim();

    if (
      slackConversationUrl &&
      getSlackConversationUrlFromTaskPayload(activeRun.payload) !==
        slackConversationUrl
    ) {
      try {
        // Merge in the database rather than writing back the in-memory
        // payload snapshot, so concurrent payload updates are not lost.
        await db
          .update(taskRuns)
          .set({
            payload: sql`${taskRuns.payload} || ${JSON.stringify({ slackConversationUrl })}::jsonb`,
          })
          .where(eq(taskRuns.id, activeRun.id));
      } catch (error) {
        console.warn(
          `Failed to persist slackConversationUrl for run ${activeRun.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await queueSlackMessage(activeRun.id, {
      text: input.text,
      agentContext: agentContext || undefined,
      user: input.slackUserId,
      userId: linkedInitiatorUserId,
      ts: input.ts,
      images: input.images?.length ? input.images : undefined,
      formattedPrompt,
      turnPolicy,
    });

    return {
      id: activeRun.id,
      taskId: activeRun.taskId,
      reusedExistingRun: true,
    };
  }

  const workspaceReadiness = input.environmentId
    ? 'environment_backed'
    : 'bare_repo';
  const reactionNames = await resolveSlackReactionNames();
  const ackEmoji = reactionNames.ackEmoji;
  const completionEmoji = reactionNames.completionEmoji;

  // The Slack command parser validates this combination up front, so a failure
  // here means a non-eval caller passed an inconsistent harness/model; fall back
  // to no routing rather than throwing inside the launch path.
  const evalSelection = resolveEvalHarnessSelection({
    harness: input.harness,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
  });
  const evalHarness = evalSelection.ok ? evalSelection.harness : undefined;
  const evalHarnessModelOverrides = evalSelection.ok
    ? evalSelection.harnessModelOverrides
    : undefined;

  const task = {
    ...(evalHarness ? { harness: evalHarness } : {}),
    type: TaskPayloadKind.SlackAppMention,
    payload: {
      channel: input.channel,
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(input.teamDomain ? { teamDomain: input.teamDomain } : {}),
      ...(input.persistedSlackUserId === null
        ? {}
        : { user: input.persistedSlackUserId ?? input.slackUserId }),
      text: input.text,
      ...(input.slackMessageContext?.trim()
        ? { slackMessageContext: input.slackMessageContext.trim() }
        : {}),
      ...(input.agentPromptText?.trim()
        ? { agentPromptText: input.agentPromptText.trim() }
        : {}),
      ...(ackEmoji ? { ackEmoji } : {}),
      ...(completionEmoji ? { completionEmoji } : {}),
      ts: input.ts,
      thread_ts: input.threadTs,
      repo: input.repo,
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.sha ? { sha: input.sha } : {}),
      ...(input.environmentId ? { environmentId: input.environmentId } : {}),
      ...(input.reasoningEffort
        ? { reasoningEffort: input.reasoningEffort }
        : {}),
      ...(evalHarnessModelOverrides
        ? { harnessModelOverrides: evalHarnessModelOverrides }
        : {}),
      workspaceReadiness,
      ...(input.readinessMessage
        ? { readinessMessage: input.readinessMessage }
        : {}),
      ...(input.images?.length ? { images: input.images } : {}),
      ...(promptRelevantThreadMessages?.length
        ? { threadMessages: promptRelevantThreadMessages }
        : {}),
      ...(promptRelevantLatestOwnBotReply
        ? { latestOwnBotReplyText: promptRelevantLatestOwnBotReply.text }
        : {}),
      ...(promptRelevantLatestOwnBotReply
        ? { latestOwnBotReplyTs: promptRelevantLatestOwnBotReply.ts }
        : {}),
      ...(input.webPath ? { webPath: input.webPath } : {}),
      ...(input.slackConversationUrl?.trim()
        ? { slackConversationUrl: input.slackConversationUrl.trim() }
        : {}),
    },
  } satisfies SlackAppMentionTask;

  const launchResult = await enqueueTask(
    {
      task,
      initiator: input.initiator,
      workflow: input.workflow ?? 'standard',
      surface: 'slack',
      trigger: input.trigger,
      ...(input.visibility ? { visibility: input.visibility } : {}),
      channels: {
        slackChannelId: input.channel,
        slackThreadTs: input.threadTs,
      },
    },
    input.skipInitialActingUser ? { skipInitialActingUser: true } : {},
  );

  return {
    id: launchResult.id,
    taskId: launchResult.taskId,
    reusedExistingRun: false,
  };
}
