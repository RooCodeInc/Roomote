import { findActiveSlackJob } from './find-active-slack-job';
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
  startedMessageJobId,
  logContext,
  prefetchedMessages,
}: {
  slack: Pick<SlackNotifier, 'fetchThreadMessages' | 'normalizeIncomingText'>;
  channel: string;
  threadTs: string;
  botUserId?: string;
  startedMessageJobId?: number | null;
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
    startedMessageJobId != null
      ? getSlackStartedMessageTs(startedMessageJobId)
      : findActiveSlackJob(threadTs).then((activeJob) =>
          activeJob ? getSlackStartedMessageTs(activeJob.id) : null,
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
