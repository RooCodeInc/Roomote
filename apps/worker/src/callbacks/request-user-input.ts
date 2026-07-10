import type {
  AcpRequestUserInputPayload,
  AcpRequestUserInputQuestion,
} from '@roomote/types';
import type { TaskRun } from '@roomote/sdk/client';

function formatQuestionOptions(
  question: AcpRequestUserInputQuestion,
): string[] {
  if (!question.options || question.options.length === 0) {
    return [];
  }

  return question.options.map(
    (option, index) => `${index + 1}. ${option.label} — ${option.description}`,
  );
}

function formatQuestion(
  question: AcpRequestUserInputQuestion,
  index: number,
  totalQuestions: number,
): string {
  const questionPrefix = totalQuestions > 1 ? `Question ${index + 1}: ` : '';
  const lines = [`${questionPrefix}${question.question}`];
  const options = formatQuestionOptions(question);

  if (options.length > 0) {
    lines.push(...options);
  }

  return lines.join('\n');
}

export function buildRequestUserInputTaskUrl(
  taskRun: TaskRun,
  source: 'slack' | 'linear',
): string {
  const webPath =
    taskRun.payload &&
    typeof taskRun.payload === 'object' &&
    'webPath' in taskRun.payload
      ? (taskRun.payload as { webPath?: unknown }).webPath
      : null;
  const normalizedWebPath =
    typeof webPath === 'string' && webPath.startsWith('/') ? webPath : null;
  const url = new URL(
    normalizedWebPath ?? `/task/${taskRun.taskId}`,
    process.env.ROOMOTE_APP_URL,
  );

  url.searchParams.set('utm_source', source);
  url.searchParams.set('utm_medium', 'integration');
  url.searchParams.set('utm_campaign', 'request_user_input');

  return url.toString();
}

export function supportsIntegrationRequestUserInput(
  request: AcpRequestUserInputPayload,
): boolean {
  return request.questions.every((question) => !question.isSecret);
}

export function getRequestUserInputPromptSignature(
  request: AcpRequestUserInputPayload,
): string {
  return JSON.stringify({
    requestId: request.requestId,
    questions: request.questions,
  });
}

export function isSingleQuestionRequestUserInput(
  request: AcpRequestUserInputPayload,
): boolean {
  return request.questions.length === 1;
}

function questionAllowsCustomAnswer(
  question: AcpRequestUserInputQuestion,
): boolean {
  return !question.options || question.options.length === 0 || question.isOther;
}

export function formatRequestUserInputPrompt(
  request: AcpRequestUserInputPayload,
): string {
  const lines = request.questions.map((question, index) =>
    formatQuestion(question, index, request.questions.length),
  );
  let responseGuidance: string;

  if (request.questions.length === 1) {
    const question = request.questions[0]!;

    if (!question.options || question.options.length === 0) {
      responseGuidance = 'Reply with your answer, or `cancel` to skip.';
    } else if (questionAllowsCustomAnswer(question)) {
      responseGuidance =
        'Reply with an option number, the option label, your own custom answer, or `cancel` to skip.';
    } else {
      responseGuidance =
        'Reply with an option number, the option label, or `cancel` to skip.';
    }
  } else if (request.questions.every(questionAllowsCustomAnswer)) {
    responseGuidance =
      'Reply with one answer per line in order, or prefix each line with `1:`, `2:`, etc. Reply `cancel` to skip.';
  } else {
    responseGuidance =
      'Reply with one answer per line in order using option numbers, option labels, or allowed custom answers. You can also prefix each line with `1:`, `2:`, etc. Reply `cancel` to skip.';
  }

  lines.push(responseGuidance);

  return lines.join('\n\n');
}
