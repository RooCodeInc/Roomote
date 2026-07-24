import type { AcpRequestUserInputQuestion } from '@roomote/types';

import type { CommunicationMessageButton } from './provider';

type DiscordRequestUserInputPromptState = {
  requestId: string;
  questions: AcpRequestUserInputQuestion[];
  currentQuestionIndex?: number;
};

function formatDisplayedOptionLabel(label: string): string {
  const suffix = ' (Recommended)';
  return label.endsWith(suffix) ? label.slice(0, -suffix.length) : label;
}

function questionAllowsCustomAnswer(
  question: AcpRequestUserInputQuestion,
): boolean {
  return !question.options || question.options.length === 0 || question.isOther;
}

function requestToken(requestId: string): string {
  return requestId.slice(-8);
}

export function getDiscordRequestUserInputCurrentQuestion(params: {
  questions: AcpRequestUserInputQuestion[];
  currentQuestionIndex?: number;
}): { question: AcpRequestUserInputQuestion; questionIndex: number } | null {
  if (params.questions.length === 0) {
    return null;
  }

  const rawIndex = params.currentQuestionIndex ?? 0;
  const questionIndex =
    Number.isInteger(rawIndex) &&
    rawIndex >= 0 &&
    rawIndex < params.questions.length
      ? rawIndex
      : 0;

  return {
    question: params.questions[questionIndex]!,
    questionIndex,
  };
}

/** Discord custom_id max is 100 chars; keep these compact. */
export function buildDiscordRequestUserInputAnswerCallbackData(params: {
  runId: number;
  requestId: string;
  questionIndex: number;
  optionIndex: number;
}): string {
  return `discord:rui:${params.runId}:${params.questionIndex}:${params.optionIndex}:${requestToken(params.requestId)}`;
}

export function buildDiscordRequestUserInputCancelCallbackData(params: {
  runId: number;
  requestId: string;
}): string {
  return `discord:rui_cancel:${params.runId}:${requestToken(params.requestId)}`;
}

export function parseDiscordRequestUserInputAnswerCallbackData(
  value: string | undefined,
): {
  runId: number;
  questionIndex: number;
  optionIndex: number;
  requestToken: string;
} | null {
  const match = /^discord:rui:(\d+):(\d+):(\d+):([A-Za-z0-9_-]{1,16})$/u.exec(
    value ?? '',
  );
  if (!match) {
    return null;
  }

  const runId = Number.parseInt(match[1]!, 10);
  const questionIndex = Number.parseInt(match[2]!, 10);
  const optionIndex = Number.parseInt(match[3]!, 10);
  const token = match[4]!;

  if (
    !Number.isSafeInteger(runId) ||
    runId <= 0 ||
    !Number.isInteger(questionIndex) ||
    questionIndex < 0 ||
    !Number.isInteger(optionIndex) ||
    optionIndex < 0
  ) {
    return null;
  }

  return {
    runId,
    questionIndex,
    optionIndex,
    requestToken: token,
  };
}

export function parseDiscordRequestUserInputCancelCallbackData(
  value: string | undefined,
): { runId: number; requestToken: string } | null {
  const match = /^discord:rui_cancel:(\d+):([A-Za-z0-9_-]{1,16})$/u.exec(
    value ?? '',
  );
  if (!match) {
    return null;
  }

  const runId = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    return null;
  }

  return { runId, requestToken: match[2]! };
}

export function hasDiscordRequestUserInputCallbackData(
  value: string | undefined,
): boolean {
  return (
    parseDiscordRequestUserInputAnswerCallbackData(value) !== null ||
    parseDiscordRequestUserInputCancelCallbackData(value) !== null
  );
}

function formatSingleQuestion(question: AcpRequestUserInputQuestion): string {
  const lines = [question.question];
  if (question.options && question.options.length > 0) {
    lines.push('');
    question.options.forEach((option, index) => {
      const label = formatDisplayedOptionLabel(option.label);
      const description =
        option.description.trim().length > 0 ? ` — ${option.description}` : '';
      lines.push(`${index + 1}. **${label}**${description}`);
    });
  }
  return lines.join('\n');
}

export function buildDiscordRequestUserInputPromptText(
  state: DiscordRequestUserInputPromptState,
): string {
  if (state.questions.length === 0) {
    return '**Input needed**\n\nI could not render this question. Reply with your answer, or `cancel` to skip.';
  }

  const current = getDiscordRequestUserInputCurrentQuestion(state);
  if (!current) {
    return '**Input needed**\n\nI could not render this question. Reply with your answer, or `cancel` to skip.';
  }

  const lines: string[] = [];
  if (state.questions.length > 1) {
    lines.push(
      `**Question ${current.questionIndex + 1} of ${state.questions.length}**`,
    );
  }
  lines.push(formatSingleQuestion(current.question));

  lines.push('');
  if (!current.question.options || current.question.options.length === 0) {
    lines.push('_Reply with your answer, or `cancel` to skip._');
  } else if (questionAllowsCustomAnswer(current.question)) {
    lines.push(
      '_Pick a button, reply with an option number/label or a custom answer, or `cancel` to skip._',
    );
  } else {
    lines.push(
      '_Pick a button, reply with an option number or label, or `cancel` to skip._',
    );
  }

  return lines.join('\n');
}

export function buildDiscordRequestUserInputButtons(params: {
  runId: number;
  request: DiscordRequestUserInputPromptState;
}): CommunicationMessageButton[][] | undefined {
  const current = getDiscordRequestUserInputCurrentQuestion(params.request);
  if (!current) {
    return undefined;
  }

  const { question, questionIndex } = current;
  const rows: CommunicationMessageButton[][] = [];

  if (question.options && question.options.length > 0) {
    const optionButtons = question.options.slice(0, 20).map((option, index) => {
      const label = formatDisplayedOptionLabel(option.label);
      return {
        text: label.slice(0, 80),
        callbackData: buildDiscordRequestUserInputAnswerCallbackData({
          runId: params.runId,
          requestId: params.request.requestId,
          questionIndex,
          optionIndex: index,
        }),
      };
    });

    for (let i = 0; i < optionButtons.length; i += 5) {
      rows.push(optionButtons.slice(i, i + 5));
    }
  }

  rows.push([
    {
      text: 'Cancel',
      callbackData: buildDiscordRequestUserInputCancelCallbackData({
        runId: params.runId,
        requestId: params.request.requestId,
      }),
    },
  ]);

  return rows.slice(0, 5);
}

export function buildDiscordAnsweredRequestUserInputText(params: {
  question: AcpRequestUserInputQuestion;
  answer: string;
}): string {
  return `${params.question.question}\n\n**Picked:** ${params.answer}`;
}

export function buildDiscordCancelledRequestUserInputText(): string {
  return '**Input cancelled**';
}
