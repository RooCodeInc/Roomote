import { findActiveSlackTaskRun } from './find-active-slack-task-run';
import { getSlackStartedMessageTs } from './slack-messages';
import { splitThreadMessages } from './slack-thread-message-utils';
import type { SlackNotifier } from './slack-notifier';
import { fetchThreadMessagesSafe } from './thread-image-utils';
import type { SlackThreadMessage } from './types';

type PromptReadySlackThreadResult = ReturnType<typeof splitThreadMessages> & {
  messages: SlackThreadMessage[];
};

export async function getPromptReadyThreadMessages({
  slack,
  channel,
  threadTs,
  botUserId,
  startedMessageRunId,
  logContext,
  prefetchedMessages,
}: {
  slack: Pick<SlackNotifier, 'fetchThreadMessages' | 'normalizeIncomingText'>;
  channel: string;
  threadTs: string;
  botUserId?: string;
  startedMessageRunId?: number | null;
  logContext?: string;
  prefetchedMessages?: SlackThreadMessage[];
}): Promise<PromptReadySlackThreadResult> {
  const [rawMessages, startedMessageTs] = await Promise.all([
    prefetchedMessages
      ? Promise.resolve(prefetchedMessages)
      : logContext
        ? fetchThreadMessagesSafe({
            fetchThreadMessages: (params) => slack.fetchThreadMessages(params),
            channel,
            threadTs,
            logContext,
          })
        : slack.fetchThreadMessages({
            channel,
            threadTs,
          }),
    startedMessageRunId != null
      ? getSlackStartedMessageTs(startedMessageRunId)
      : findActiveSlackTaskRun(threadTs).then((activeRun) =>
          activeRun ? getSlackStartedMessageTs(activeRun.id) : null,
        ),
  ]);

  const messages = await Promise.all(
    rawMessages.map(async (message) => ({
      ...message,
      text: await slack.normalizeIncomingText(message.text),
    })),
  );
  const splitMessages = splitThreadMessages(
    messages,
    botUserId,
    startedMessageTs,
  );

  return {
    messages,
    ...splitMessages,
  };
}
