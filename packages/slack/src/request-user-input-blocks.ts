import {
  type AcpRequestUserInputAnswers,
  type AcpRequestUserInputQuestion,
  type SlackBlock,
} from '@roomote/types';

interface SlackRequestUserInputPromptState {
  requestId: string;
  questions: AcpRequestUserInputQuestion[];
  currentQuestionIndex?: number;
  answers?: AcpRequestUserInputAnswers;
}

interface SlackRequestUserInputButtonValue {
  requestId: string;
  questionId?: string;
  questionIndex?: number;
  answer?: string;
  cancel?: boolean;
}

function questionAllowsCustomAnswer(
  question: AcpRequestUserInputQuestion,
): boolean {
  return !question.options || question.options.length === 0 || question.isOther;
}

function formatDisplayedOptionLabel(label: string): string {
  const suffix = ' (Recommended)';
  return label.endsWith(suffix) ? label.slice(0, -suffix.length) : label;
}

function buildFooterText(question: AcpRequestUserInputQuestion): string {
  if (!question.options || question.options.length === 0) {
    return '_@-mention me with your answer._';
  }

  if (questionAllowsCustomAnswer(question)) {
    return '_You can also @-mention me with a custom response._';
  }

  return '_You can also @-mention me with one of the suggestions above._';
}

export function buildSlackRequestUserInputButtonValue(
  value: SlackRequestUserInputButtonValue,
): string {
  return JSON.stringify(value);
}

export function getSlackRequestUserInputCurrentQuestion(
  state: SlackRequestUserInputPromptState,
): {
  question: AcpRequestUserInputQuestion;
  questionIndex: number;
} | null {
  if (state.questions.length === 0) {
    return null;
  }

  const rawIndex = state.currentQuestionIndex ?? 0;
  const questionIndex =
    Number.isInteger(rawIndex) &&
    rawIndex >= 0 &&
    rawIndex < state.questions.length
      ? rawIndex
      : 0;

  return {
    question: state.questions[questionIndex]!,
    questionIndex,
  };
}

export function buildSlackRequestUserInputReplyHint(
  state: SlackRequestUserInputPromptState,
): string {
  const current = getSlackRequestUserInputCurrentQuestion(state);

  if (!current) {
    return '_@-mention me with your answer._';
  }

  return buildFooterText(current.question);
}

export function buildSlackAnsweredRequestUserInputBlocks(params: {
  question: AcpRequestUserInputQuestion;
  answer: string;
}): SlackBlock[] {
  return [
    {
      type: 'markdown',
      text: `${params.question.question}\n\n**Picked:** ${params.answer}`,
    },
  ];
}

export function buildSlackCancelledRequestUserInputBlocks(params: {
  question: AcpRequestUserInputQuestion;
}): SlackBlock[] {
  return [
    {
      type: 'markdown',
      text: `${params.question.question}\n\n**Cancelled.**`,
    },
  ];
}

export function buildSlackRequestUserInputBlocks(
  state: SlackRequestUserInputPromptState & { footerText?: string },
): SlackBlock[] {
  const current = getSlackRequestUserInputCurrentQuestion(state);

  if (!current) {
    return [
      {
        type: 'markdown',
        text: '**Input needed**\n\n_I could not render this question. @-mention me with your answer._',
      },
    ];
  }

  const { question, questionIndex } = current;
  const blocks: SlackBlock[] = [];

  blocks.push({
    type: 'markdown',
    text: question.question,
  });

  if (question.options && question.options.length > 0) {
    question.options.forEach((option, index) => {
      const displayedLabel = formatDisplayedOptionLabel(option.label);
      const descriptionLine =
        option.description.length > 0 ? `\n${option.description}` : '';

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${index + 1}. ${displayedLabel}*${descriptionLine}`,
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Pick', emoji: true },
          value: buildSlackRequestUserInputButtonValue({
            requestId: state.requestId,
            questionId: question.id,
            questionIndex,
            answer: option.label,
          }),
          action_id: `request_user_input_answer_${index}`,
        },
      });
    });
  }

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Cancel', emoji: true },
        value: buildSlackRequestUserInputButtonValue({
          requestId: state.requestId,
          questionIndex,
          cancel: true,
        }),
        action_id: 'request_user_input_cancel',
      },
    ],
  });

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: state.footerText ?? buildFooterText(question),
      },
    ],
  });

  return blocks;
}
