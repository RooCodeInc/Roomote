import {
  buildDiscordAnsweredRequestUserInputText,
  buildDiscordCancelledRequestUserInputText,
  getDiscordRequestUserInputCurrentQuestion,
  getPendingCommunicationRequestUserInput,
  clearPendingCommunicationRequestUserInput,
  submitPendingCommunicationRequestUserInputAnswer,
  type PendingCommunicationRequestUserInput,
} from '@roomote/communication';
import {
  parseAcpRequestUserInputAnswerReply,
  type AcpRequestUserInputAnswers,
} from '@roomote/types';
import { setTrustedRunActingUserOnSuccess } from '@roomote/db/server';
import { createTeamsCommunicationProviderFromRuntimeCredentials as createTeamsCommunicationProvider } from '@roomote/sdk/server';

import { apiLogger } from '../../logging.js';

async function submitPendingRui(
  conversationId: string,
  pendingRequest: PendingCommunicationRequestUserInput,
  answers: AcpRequestUserInputAnswers,
  userId: string,
): Promise<boolean> {
  return submitPendingCommunicationRequestUserInputAnswer(
    'teams',
    conversationId,
    pendingRequest,
    {
      answers,
      userId,
      timestamp: Date.now(),
    },
  );
}

/**
 * Try to treat an inbound Teams message as an answer to a pending
 * request_user_input prompt. Teams has text-only option intake for now
 * (no adaptive-card button handler yet).
 */
export async function tryHandleTeamsRequestUserInputMessage(params: {
  activeRunId: number;
  userId: string;
  text: string;
  conversationId: string;
  serviceUrl?: string | null;
  threadId?: string | null;
}): Promise<boolean> {
  const conversationKey =
    params.threadId?.trim() || params.conversationId.trim();
  const pendingRequest = await getPendingCommunicationRequestUserInput(
    'teams',
    conversationKey,
  );
  if (!pendingRequest) {
    return false;
  }
  if (pendingRequest.runId !== params.activeRunId) {
    await clearPendingCommunicationRequestUserInput('teams', conversationKey, {
      requestId: pendingRequest.requestId,
    }).catch(() => undefined);
    return false;
  }
  if (pendingRequest.status === 'submitted') {
    return true;
  }

  const parsedReply = parseAcpRequestUserInputAnswerReply(
    pendingRequest.questions,
    params.text,
  );
  if (!parsedReply) {
    return false;
  }

  const cancelled = parsedReply.resolution === 'cancelled';
  const answers = cancelled ? {} : parsedReply.answers;
  const answerText = cancelled
    ? 'cancel'
    : Object.values(parsedReply.answers)
        .flatMap((entry) => entry.answers)
        .join(', ');

  const queued = await setTrustedRunActingUserOnSuccess({
    runId: params.activeRunId,
    userId: params.userId,
    operation: async () =>
      submitPendingRui(conversationKey, pendingRequest, answers, params.userId),
  });

  if (!queued) {
    return true;
  }

  const current = getDiscordRequestUserInputCurrentQuestion(pendingRequest);
  const confirmationText = cancelled
    ? buildDiscordCancelledRequestUserInputText()
    : current
      ? buildDiscordAnsweredRequestUserInputText({
          question: current.question,
          answer: answerText,
        })
      : `**Picked:** ${answerText}`;

  if (pendingRequest.promptMessageId && params.serviceUrl) {
    try {
      const provider = await createTeamsCommunicationProvider();
      if (provider) {
        await provider.updateMessage({
          channelId: params.conversationId,
          messageId: pendingRequest.promptMessageId,
          serviceUrl: params.serviceUrl,
          text: confirmationText,
          textFormat: 'markdown',
        });
      }
    } catch (error) {
      apiLogger.warn(
        `[teams.request_user_input] Failed to update prompt: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return true;
}
