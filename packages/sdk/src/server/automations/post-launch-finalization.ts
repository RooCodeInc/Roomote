import {
  db,
  updateBackgroundAutomationSlackThreadMetadata,
} from '@roomote/db/server';
import type { CommunicationProvider } from '@roomote/types';

type AutomationLaunchConversation = {
  provider: CommunicationProvider;
  channelId: string;
  rootMessageId?: string | null;
};

export type FinalizeAutomationLaunchParams = {
  conversation: AutomationLaunchConversation;
  taskId: string;
  context: string;
  warn: (message: string) => void;
};

/**
 * Binds an already-enqueued automation task to its pre-existing conversation
 * root. A binding failure is diagnostic only: the task launch already succeeded.
 */
export async function finalizeAutomationLaunch(
  params: FinalizeAutomationLaunchParams,
): Promise<{ attached: boolean }> {
  const { conversation } = params;

  if (conversation.provider !== 'slack' || !conversation.rootMessageId) {
    return { attached: false };
  }

  try {
    const attached = await updateBackgroundAutomationSlackThreadMetadata(db, {
      surface: 'slack',
      slackChannelId: conversation.channelId,
      threadTs: conversation.rootMessageId,
      metadata: { sourceTaskId: params.taskId },
    });

    if (!attached) {
      params.warn(
        `${params.context} Could not link Slack thread ${conversation.rootMessageId} to task ${params.taskId}`,
      );
    }

    return { attached };
  } catch (error) {
    params.warn(
      `${params.context} Failed to link Slack thread ${conversation.rootMessageId} to task ${params.taskId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { attached: false };
  }
}
