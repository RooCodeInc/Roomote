import {
  buildDiscordRequestUserInputPromptText,
  getDiscordRequestUserInputCurrentQuestion,
  type CommunicationMessageButton,
} from '@roomote/communication';
import { agentmailConversations, db, eq } from '@roomote/db/server';
import type { AcpRequestUserInputQuestion } from '@roomote/types';

import {
  buildAgentMailRuiAnswerToken,
  buildAgentMailRuiAnswerUrl,
} from './rui-answer-links';

/**
 * request_user_input over email: the prompt is one email whose options are
 * button-styled one-click answer links (signed tokens; the claim stays
 * atomic), with a free-text reply as the always-available fallback. Buttons
 * render only for single-question prompts with options — the same restriction
 * the chat callback intake enforces — and multi-question prompts fall back to
 * reply-per-line text.
 */
export async function buildAgentMailRequestUserInputMessage(params: {
  conversationId: string;
  requestId: string;
  questions: AcpRequestUserInputQuestion[];
  currentQuestionIndex: number;
}): Promise<{ text: string; buttons?: CommunicationMessageButton[][] }> {
  const promptText = buildDiscordRequestUserInputPromptText({
    requestId: params.requestId,
    questions: params.questions,
    currentQuestionIndex: params.currentQuestionIndex,
  });
  const text = `${promptText}\n\nReply to this email with your answer, or use the buttons below when shown.`;

  if (params.questions.length !== 1) {
    return { text };
  }

  const current = getDiscordRequestUserInputCurrentQuestion(params);
  const options = current?.question.options ?? [];
  if (!current || options.length === 0) {
    return { text };
  }

  const conversation = await db.query.agentmailConversations.findFirst({
    where: eq(agentmailConversations.id, params.conversationId),
    columns: { latestInboundUserId: true, ownerUserId: true },
  });
  const responderUserId =
    conversation?.latestInboundUserId ?? conversation?.ownerUserId;
  if (!responderUserId) {
    return { text };
  }

  const buttons: CommunicationMessageButton[][] = options.map(
    (option, index) => [
      {
        text: option.label,
        url: buildAgentMailRuiAnswerUrl(
          buildAgentMailRuiAnswerToken({
            conversationId: params.conversationId,
            requestId: params.requestId,
            questionId: current.question.id,
            optionIndex: index,
            userId: responderUserId,
          }),
        ),
      },
    ],
  );

  return { text, buttons };
}
