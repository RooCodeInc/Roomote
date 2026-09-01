import {
  type TaskMessageContentBlock,
  type TaskMessageEventType,
  type TaskMessageRole,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
  getTextFromContentBlocks,
  isVisibleInTranscript,
  TRANSCRIPT_VISIBILITY_METADATA_KEY,
} from './task-messages';
import {
  asBoolean,
  asFiniteNumber,
  asRecord,
  asRecordOrNull,
  asString,
  asStringOrNull,
} from './primitives';
import { isReasoningEffort } from './task-runs';
import { normalizeProviderUsageWorkflowPhase } from './provider-usage-workflow-phase';

export const ACP_ENVELOPE_EVENT_TYPES = {
  UserPrompt: 'roomote_runtime.user_prompt',
  AssistantThought: 'roomote_runtime.assistant_thought',
  AssistantThoughtChunk: 'roomote_runtime.assistant_thought_chunk',
  AssistantMessage: 'roomote_runtime.assistant_message',
  AssistantMessageChunk: 'roomote_runtime.assistant_message_chunk',
  Plan: 'roomote_runtime.plan',
  ToolCall: 'roomote_runtime.tool_call',
  ToolCallUpdate: 'roomote_runtime.tool_call_update',
  ToolResult: 'roomote_runtime.tool_result',
  QueuedMessagesUpdate: 'roomote_runtime.queued_messages_update',
  RequestUserInput: 'roomote_runtime.request_user_input',
  RequestUserInputResponse: 'roomote_runtime.request_user_input_response',
  TaskCancelled: 'roomote_runtime.task_cancelled',
} as const;

export type AcpEnvelopeEventType =
  (typeof ACP_ENVELOPE_EVENT_TYPES)[keyof typeof ACP_ENVELOPE_EVENT_TYPES];

/** Live-only event types that are streamed but never persisted. */
export const ACP_LIVE_EVENT_TYPES = {
  UsageUpdate: 'roomote_runtime.usage_update',
  ProviderUsage: 'roomote_runtime.provider_usage',
  AvailableCommandsUpdate: 'roomote_runtime.available_commands_update',
  CurrentModeUpdate: 'roomote_runtime.current_mode_update',
  PermissionsStateUpdate: 'roomote_runtime.permissions_state_update',
  ConfigOptionUpdate: 'roomote_runtime.config_option_update',
} as const;

export type AcpLiveEventType =
  (typeof ACP_LIVE_EVENT_TYPES)[keyof typeof ACP_LIVE_EVENT_TYPES];

/** All known Roomote runtime event types — envelope (persisted) + live-only (streamed). */
export type AcpEventType = AcpEnvelopeEventType | AcpLiveEventType;

/** Restore separation between bold reasoning headings concatenated by a provider. */
export function normalizeAcpReasoningText(text: string): string {
  return text.replace(/[^\r\n]+/g, (line) => {
    if (!line.startsWith('**') || !line.endsWith('**')) {
      return line;
    }

    const headings = line.slice(2, -2).split('****');
    if (
      headings.length < 2 ||
      headings.some((heading) => heading.length === 0 || heading.includes('**'))
    ) {
      return line;
    }

    return `**${headings.join('**\n\n**')}**`;
  });
}

export const ACP_LOGICAL_EVENT_ID_KEY = 'logicalEventId' as const;

export interface AcpLogicalEventIdParts {
  sessionId: string | null | undefined;
  turnId?: string | null | undefined;
  toolCallId?: string | null | undefined;
  eventType: string | null | undefined;
}

function normalizeLogicalEventIdPart(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

export function buildAcpLogicalEventId({
  sessionId,
  turnId,
  toolCallId,
  eventType,
}: AcpLogicalEventIdParts): string | null {
  const normalizedSessionId = normalizeLogicalEventIdPart(sessionId);
  const normalizedEventType = normalizeLogicalEventIdPart(eventType);

  if (!normalizedSessionId || !normalizedEventType) {
    return null;
  }

  return [
    normalizedSessionId,
    normalizeLogicalEventIdPart(turnId) ?? 'no-turn',
    normalizeLogicalEventIdPart(toolCallId) ?? 'no-tool',
    normalizedEventType,
  ].join(':');
}

const CHUNK_LOGICAL_EVENT_TYPE_ALIASES: Record<string, string> = {
  [ACP_ENVELOPE_EVENT_TYPES.AssistantMessageChunk]:
    ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
  [ACP_ENVELOPE_EVENT_TYPES.AssistantThoughtChunk]:
    ACP_ENVELOPE_EVENT_TYPES.AssistantThought,
};

/**
 * Streaming chunk events describe the same logical transcript item as their
 * consolidated counterpart (which is what gets persisted), so chunk-typed
 * logical ids collapse to the consolidated event type for reconciliation.
 */
export function canonicalizeAcpLogicalEventId(
  logicalEventId: string | null,
): string | null {
  if (!logicalEventId) {
    return null;
  }

  const separatorIndex = logicalEventId.lastIndexOf(':');
  const eventType = logicalEventId.slice(separatorIndex + 1);
  const canonicalEventType = CHUNK_LOGICAL_EVENT_TYPE_ALIASES[eventType];

  return canonicalEventType
    ? `${logicalEventId.slice(0, separatorIndex + 1)}${canonicalEventType}`
    : logicalEventId;
}

export function getAcpLogicalEventId(source: {
  logicalEventId?: unknown;
  metadata?: Record<string, unknown> | null;
  payload?: Record<string, unknown> | null;
}): string | null {
  return (
    normalizeLogicalEventIdPart(asStringOrNull(source.logicalEventId)) ??
    normalizeLogicalEventIdPart(
      asStringOrNull(source.metadata?.[ACP_LOGICAL_EVENT_ID_KEY]),
    ) ??
    normalizeLogicalEventIdPart(
      asStringOrNull(source.payload?.[ACP_LOGICAL_EVENT_ID_KEY]),
    )
  );
}

export const ACP_REQUEST_USER_INPUT_METHOD =
  'roomote/item/tool/requestUserInput' as const;

export const ACP_REQUEST_USER_INPUT_REQUEST_ID_PREFIX = 'rui' as const;

export interface AcpRequestUserInputQuestionOption {
  label: string;
  description: string;
}

export interface AcpRequestUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options?: AcpRequestUserInputQuestionOption[];
  /** Multiple-choice questions default to one selection when absent. */
  multiple?: boolean;
}

export type AcpRequestUserInputAnswers = Record<
  string,
  {
    answers: string[];
  }
>;

export function getAcpRequestUserInputValidationError(
  questions: AcpRequestUserInputQuestion[],
  answers: AcpRequestUserInputAnswers,
  resolution: 'submitted' | 'cancelled' = 'submitted',
): string | null {
  const questionIds = new Set(questions.map((question) => question.id));
  if (Object.keys(answers).some((questionId) => !questionIds.has(questionId))) {
    return 'One or more answers do not belong to this request.';
  }
  if (resolution === 'cancelled') return null;

  for (const question of questions) {
    const submitted = answers[question.id]?.answers ?? [];
    if (new Set(submitted).size !== submitted.length) {
      return 'Duplicate answers are not allowed.';
    }
    if (submitted.length === 0) {
      return 'Answer every question before submitting.';
    }
    if (!question.multiple && submitted.length > 1) {
      return 'This question accepts a single answer.';
    }
    if (question.options?.length) {
      const optionLabels = new Set(
        question.options.map((option) => option.label),
      );
      const customAnswerCount = submitted.filter(
        (answer) => !optionLabels.has(answer),
      ).length;
      if (customAnswerCount > (question.isOther ? 1 : 0)) {
        return 'One or more selections are not valid options.';
      }
    }
  }
  return null;
}

export interface AcpRequestUserInputRequestParams {
  sessionId: string;
  turnId: string;
  callId: string;
  questions: AcpRequestUserInputQuestion[];
}

export interface AcpRequestUserInputPayload extends AcpRequestUserInputRequestParams {
  requestId: string;
  status: 'pending';
  preset?: 'setup_starter_tasks';
}

export interface AcpRequestUserInputResponsePayload {
  requestId: string;
  sessionId: string;
  turnId: string;
  callId: string;
  answers: AcpRequestUserInputAnswers;
  resolution: 'submitted' | 'cancelled';
}

/**
 * Payload of the persisted `task_cancelled` marker envelope emitted when a
 * user explicitly stops an in-flight turn. Internal aborts (steer replay,
 * env-var resumable stop) do not emit this marker.
 */
export interface AcpTaskCancelledPayload {
  sessionId: string;
  /** Display name of the user who stopped the task, when known. */
  cancelledByName?: string;
  /** Surface the stop came from, e.g. `web`, `slack`, `telegram`, `api`. */
  source?: string;
}

export function parseAcpTaskCancelledPayload(
  payload: Record<string, unknown> | null,
): AcpTaskCancelledPayload | null {
  const sessionId = asStringOrNull(payload?.sessionId);

  if (!sessionId) {
    return null;
  }

  const cancelledByName = asStringOrNull(payload?.cancelledByName);
  const source = asStringOrNull(payload?.source);

  return {
    sessionId,
    ...(cancelledByName ? { cancelledByName } : {}),
    ...(source ? { source } : {}),
  };
}

export interface ParsedAcpRequestUserInputReply {
  answers: AcpRequestUserInputAnswers;
  resolution: 'submitted' | 'cancelled';
  /**
   * True when at least one answer to an options question was accepted only via
   * the isOther free-text fallback (it matched no option number or label).
   * Such replies are often conversational interjections rather than answers.
   */
  usedFreeTextOptionFallback?: boolean;
}

export function buildAcpRequestUserInputRequestId(params: {
  sessionId: string;
  turnId: string;
  callId: string;
}): string {
  return `${ACP_REQUEST_USER_INPUT_REQUEST_ID_PREFIX}:${params.sessionId}:${params.turnId}:${params.callId}`;
}

function parseAcpRequestUserInputQuestionOption(
  value: unknown,
): AcpRequestUserInputQuestionOption | null {
  const record = asRecordOrNull(value);
  const label = asStringOrNull(record?.label);
  const description = asStringOrNull(record?.description);

  if (!label || !description) {
    return null;
  }

  return { label, description };
}

export function parseAcpRequestUserInputQuestion(
  value: unknown,
): AcpRequestUserInputQuestion | null {
  const record = asRecordOrNull(value);
  const id = asStringOrNull(record?.id);
  const header = asStringOrNull(record?.header);
  const question = asStringOrNull(record?.question);

  if (!id || !header || !question) {
    return null;
  }

  const options = Array.isArray(record?.options)
    ? record.options
        .map((option) => parseAcpRequestUserInputQuestionOption(option))
        .filter(
          (option): option is AcpRequestUserInputQuestionOption =>
            option !== null,
        )
    : undefined;

  return {
    id,
    header,
    question,
    isOther: record?.isOther === true,
    isSecret: record?.isSecret === true,
    ...(options ? { options } : {}),
    ...(record?.multiple === true ? { multiple: true } : {}),
  };
}

export function parseAcpRequestUserInputAnswers(
  value: unknown,
): AcpRequestUserInputAnswers | null {
  const record = asRecordOrNull(value);

  if (!record) {
    return null;
  }

  const answers = Object.entries(record).reduce<AcpRequestUserInputAnswers>(
    (result, [questionId, answerValue]) => {
      const answerRecord = asRecordOrNull(answerValue);
      const answerItems = Array.isArray(answerRecord?.answers)
        ? answerRecord.answers.filter(
            (item): item is string => typeof item === 'string',
          )
        : null;

      if (!answerItems) {
        return result;
      }

      result[questionId] = { answers: answerItems };
      return result;
    },
    {},
  );

  return answers;
}

export function parseAcpRequestUserInputRequestParams(
  payload: Record<string, unknown> | null,
): AcpRequestUserInputRequestParams | null {
  if (!payload) {
    return null;
  }

  const sessionId = asStringOrNull(payload.sessionId);
  const turnId = asStringOrNull(payload.turnId);
  const callId = asStringOrNull(payload.callId);
  const questions = Array.isArray(payload.questions)
    ? payload.questions
        .map((question) => parseAcpRequestUserInputQuestion(question))
        .filter(
          (question): question is AcpRequestUserInputQuestion =>
            question !== null,
        )
    : null;

  if (!sessionId || !turnId || !callId || !questions) {
    return null;
  }

  return { sessionId, turnId, callId, questions };
}

export function parseAcpRequestUserInputPayload(
  payload: Record<string, unknown> | null,
): AcpRequestUserInputPayload | null {
  const requestId = asStringOrNull(payload?.requestId);
  const request = parseAcpRequestUserInputRequestParams(payload);
  const preset =
    payload?.preset === 'setup_starter_tasks' ? payload.preset : undefined;

  if (!requestId || !request) {
    return null;
  }

  return {
    requestId,
    ...request,
    status: 'pending',
    ...(preset ? { preset } : {}),
  };
}

export function parseAcpRequestUserInputResponsePayload(
  payload: Record<string, unknown> | null,
): AcpRequestUserInputResponsePayload | null {
  const requestId = asStringOrNull(payload?.requestId);
  const sessionId = asStringOrNull(payload?.sessionId);
  const turnId = asStringOrNull(payload?.turnId);
  const callId = asStringOrNull(payload?.callId);
  const answers = parseAcpRequestUserInputAnswers(payload?.answers);
  const resolution =
    payload?.resolution === 'submitted' || payload?.resolution === 'cancelled'
      ? payload.resolution
      : null;

  if (
    !requestId ||
    !sessionId ||
    !turnId ||
    !callId ||
    !answers ||
    !resolution
  ) {
    return null;
  }

  return {
    requestId,
    sessionId,
    turnId,
    callId,
    answers,
    resolution,
  };
}

function normalizeAcpRequestUserInputOptionLabel(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function stripAcpRequestUserInputNumberPrefix(value: string): string {
  return value.replace(/^\s*#?\d+[).\]:\-\s]+/, '').trim();
}

interface ResolvedAcpRequestUserInputAnswer {
  answer: string;
  viaOtherFallback: boolean;
}

function resolveAcpRequestUserInputAnswerDetailed(
  question: AcpRequestUserInputQuestion,
  rawAnswer: string,
): ResolvedAcpRequestUserInputAnswer | null {
  const answer = rawAnswer.trim();

  if (answer.length === 0) {
    return null;
  }

  if (!question.options || question.options.length === 0) {
    return { answer, viaOtherFallback: false };
  }

  const numberMatch = answer.match(/^#?\s*(\d+)$/);

  if (numberMatch) {
    const optionIndex = Number.parseInt(numberMatch[1] ?? '', 10) - 1;

    if (optionIndex >= 0 && optionIndex < question.options.length) {
      return {
        answer: question.options[optionIndex]!.label,
        viaOtherFallback: false,
      };
    }
  }

  const normalizedAnswer = normalizeAcpRequestUserInputOptionLabel(answer);
  const exactMatch = question.options.find(
    (option) =>
      normalizeAcpRequestUserInputOptionLabel(option.label) ===
      normalizedAnswer,
  );

  if (exactMatch) {
    return { answer: exactMatch.label, viaOtherFallback: false };
  }

  const partialMatches = question.options.filter((option) =>
    normalizeAcpRequestUserInputOptionLabel(option.label).includes(
      normalizedAnswer,
    ),
  );

  if (partialMatches.length === 1) {
    return { answer: partialMatches[0]!.label, viaOtherFallback: false };
  }

  if (question.isOther) {
    return { answer, viaOtherFallback: true };
  }

  return null;
}

export function resolveAcpRequestUserInputAnswer(
  question: AcpRequestUserInputQuestion,
  rawAnswer: string,
): string | null {
  return (
    resolveAcpRequestUserInputAnswerDetailed(question, rawAnswer)?.answer ??
    null
  );
}

interface ParsedRequestUserInputAnswers {
  answers: AcpRequestUserInputAnswers;
  usedFreeTextOptionFallback: boolean;
}

function parseSingleQuestionRequestUserInputReply(
  question: AcpRequestUserInputQuestion,
  responseText: string,
): ParsedRequestUserInputAnswers | null {
  const resolved = resolveAcpRequestUserInputAnswerDetailed(
    question,
    responseText,
  );

  if (!resolved) {
    return null;
  }

  return {
    answers: {
      [question.id]: {
        answers: [resolved.answer],
      },
    },
    usedFreeTextOptionFallback: resolved.viaOtherFallback,
  };
}

function parseNumberedAnswerLine(
  line: string,
): { questionIndex: number; answer: string } | null {
  let index = 0;
  if (line[index] === '#') {
    index += 1;
  }
  while (index < line.length && (line[index] === ' ' || line[index] === '\t')) {
    index += 1;
  }

  const numberStart = index;
  while (index < line.length && line[index]! >= '0' && line[index]! <= '9') {
    index += 1;
  }
  if (index === numberStart) {
    return null;
  }

  const questionNumber = Number.parseInt(line.slice(numberStart, index), 10);
  let hadSeparator = false;
  while (index < line.length) {
    const ch = line[index]!;
    if (
      ch === ')' ||
      ch === '.' ||
      ch === ']' ||
      ch === ':' ||
      ch === '-' ||
      ch === ' ' ||
      ch === '\t'
    ) {
      hadSeparator = true;
      index += 1;
      continue;
    }
    break;
  }
  if (!hadSeparator || index >= line.length) {
    return null;
  }

  const answer = line.slice(index).trim();
  if (!answer || Number.isNaN(questionNumber)) {
    return null;
  }

  return {
    questionIndex: questionNumber - 1,
    answer,
  };
}

function parseMultiQuestionRequestUserInputReply(
  questions: AcpRequestUserInputQuestion[],
  responseText: string,
): ParsedRequestUserInputAnswers | null {
  const lines = responseText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return null;
  }

  const numberedAnswers = new Map<number, string>();

  for (const line of lines) {
    const numberedMatch = parseNumberedAnswerLine(line);

    if (!numberedMatch) {
      numberedAnswers.clear();
      break;
    }

    const questionIndex = numberedMatch.questionIndex;
    const answer = numberedMatch.answer;

    if (
      questionIndex < 0 ||
      questionIndex >= questions.length ||
      answer.length === 0
    ) {
      return null;
    }

    numberedAnswers.set(questionIndex, answer);
  }

  const usedNumberedFormat = numberedAnswers.size === questions.length;
  const orderedAnswers = usedNumberedFormat
    ? questions.map((_, index) => numberedAnswers.get(index) ?? '')
    : lines.length === questions.length
      ? lines.map((line) => stripAcpRequestUserInputNumberPrefix(line))
      : null;

  if (!orderedAnswers || orderedAnswers.length !== questions.length) {
    return null;
  }

  // An explicitly numbered "1: ..." reply is strong evidence the user is
  // answering the questions, so free-text entries in it are deliberate custom
  // answers, not conversational interjections.
  let usedFreeTextOptionFallback = false;
  const answers = questions.reduce<AcpRequestUserInputAnswers>(
    (result, question, index) => {
      const resolved = resolveAcpRequestUserInputAnswerDetailed(
        question,
        orderedAnswers[index] ?? '',
      );

      if (!resolved) {
        return result;
      }

      usedFreeTextOptionFallback ||=
        !usedNumberedFormat && resolved.viaOtherFallback;
      result[question.id] = {
        answers: [resolved.answer],
      };
      return result;
    },
    {},
  );

  return Object.keys(answers).length === questions.length
    ? { answers, usedFreeTextOptionFallback }
    : null;
}

export function parseAcpRequestUserInputReply(
  payload: Pick<AcpRequestUserInputPayload, 'questions'>,
  responseText: string,
): ParsedAcpRequestUserInputReply | null {
  const trimmedResponse = responseText.trim();

  if (trimmedResponse.length === 0) {
    return null;
  }

  if (trimmedResponse.toLocaleLowerCase() === 'cancel') {
    return {
      answers: {},
      resolution: 'cancelled',
    };
  }

  const parsed =
    payload.questions.length === 1
      ? parseSingleQuestionRequestUserInputReply(
          payload.questions[0]!,
          trimmedResponse,
        )
      : parseMultiQuestionRequestUserInputReply(
          payload.questions,
          trimmedResponse,
        );

  if (!parsed) {
    return null;
  }

  return {
    answers: parsed.answers,
    resolution: 'submitted',
    usedFreeTextOptionFallback: parsed.usedFreeTextOptionFallback,
  };
}

/**
 * Parse a reply as an answer to pending questions. When a question allows an
 * `isOther` answer, any non-empty free text is the custom answer; callers must
 * not guess intent from its wording and leave the elicitation pending.
 */
export function parseAcpRequestUserInputAnswerReply(
  questions: AcpRequestUserInputQuestion[],
  responseText: string,
): ParsedAcpRequestUserInputReply | null {
  if (questions.length === 0) {
    return null;
  }

  const parsed = parseAcpRequestUserInputReply({ questions }, responseText);

  if (!parsed) {
    return null;
  }

  return parsed;
}

export type AcpMessageKind =
  | 'text'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'plan'
  | 'task_cancelled'
  | 'unknown';

export function inferAcpMessageKind(
  eventType: AcpEventType | TaskMessageEventType,
): AcpMessageKind {
  switch (eventType) {
    case ACP_ENVELOPE_EVENT_TYPES.UserPrompt:
    case ACP_ENVELOPE_EVENT_TYPES.AssistantMessage:
    case ACP_ENVELOPE_EVENT_TYPES.AssistantMessageChunk:
      return 'text';
    case ACP_ENVELOPE_EVENT_TYPES.AssistantThought:
    case ACP_ENVELOPE_EVENT_TYPES.AssistantThoughtChunk:
      return 'reasoning';
    case ACP_ENVELOPE_EVENT_TYPES.Plan:
      return 'plan';
    case ACP_ENVELOPE_EVENT_TYPES.ToolCall:
      return 'tool_call';
    case ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate:
    case ACP_ENVELOPE_EVENT_TYPES.ToolResult:
      return 'tool_result';
    case ACP_ENVELOPE_EVENT_TYPES.TaskCancelled:
      return 'task_cancelled';
    default:
      return 'unknown';
  }
}

/**
 * Extract display text from a Roomote runtime message, trying contentBlocks first,
 * then falling back to payload.content.text or payload.prompt blocks.
 */
export function extractAcpMessageText(
  contentBlocks: TaskMessageContentBlock[],
  payload: Record<string, unknown> | null,
): string | undefined {
  const fromBlocks = getTextFromContentBlocks(contentBlocks);

  if (fromBlocks) {
    return fromBlocks;
  }

  if (!payload) {
    return undefined;
  }

  const content = payload.content;

  if (
    typeof content === 'object' &&
    content !== null &&
    'text' in content &&
    typeof (content as { text: unknown }).text === 'string'
  ) {
    const text = (content as { text: string }).text;

    if (text.length > 0) {
      return text;
    }
  }

  const promptBlocks = Array.isArray(payload.prompt) ? payload.prompt : null;

  if (promptBlocks) {
    const parts = promptBlocks
      .filter(
        (block): block is { type: string; text: string } =>
          typeof block === 'object' &&
          block !== null &&
          block.type === 'text' &&
          typeof block.text === 'string',
      )
      .map((block) => block.text);

    if (parts.length > 0) {
      return parts.join('\n');
    }
  }

  return undefined;
}

function stripXmlBlocksByTagName(text: string, tagName: string): string {
  const open = `<${tagName}>`;
  const close = `</${tagName}>`;
  let result = text;

  for (;;) {
    const start = result.indexOf(open);
    if (start === -1) {
      break;
    }
    const end = result.indexOf(close, start + open.length);
    if (end === -1) {
      break;
    }
    result = result.slice(0, start) + result.slice(end + close.length);
  }

  return result;
}

/**
 * Detect prompt text that includes wrapper blocks injected by Roomote.
 */
export function isSystemInjectedAcpPromptText(text: string): boolean {
  return (
    text.includes('<environment-instructions>') || text.includes('<workflow>')
  );
}

/**
 * Strip Roomote-injected wrapper blocks while preserving the user's
 * request text for downstream consumers such as task-title generation.
 */
export function extractVisibleAcpPromptText(text: string): string {
  return stripXmlBlocksByTagName(
    stripXmlBlocksByTagName(text, 'environment-instructions'),
    'workflow',
  )
    .replaceAll('<request>', '')
    .replaceAll('</request>', '')
    .trim();
}

/**
 * Resolve transcript visibility for Roomote runtime envelopes.
 *
 * Newer envelopes rely on an explicit metadata flag written by the server.
 * Older persisted prompts predate that flag, so keep a narrow compatibility
 * fallback for Roomote-injected wrapper prompts until those rows age out.
 */
export function resolveAcpTranscriptVisibility(input: {
  eventType: TaskMessageEventType;
  contentBlocks?: TaskMessageContentBlock[] | null;
  metadata?: Record<string, unknown> | null;
  payload?: Record<string, unknown> | null;
}): boolean {
  const explicitVisibility = asBoolean(
    input.metadata?.[TRANSCRIPT_VISIBILITY_METADATA_KEY],
  );

  if (explicitVisibility !== undefined) {
    return explicitVisibility;
  }

  if (input.eventType !== ACP_ENVELOPE_EVENT_TYPES.UserPrompt) {
    return isVisibleInTranscript(input.metadata);
  }

  const text = extractAcpMessageText(
    input.contentBlocks ?? [],
    input.payload ?? null,
  );
  const normalizedText = text
    ? decodeWrappedMessageEntities(text).replace(/\r\n?/g, '\n').trim()
    : undefined;

  if (normalizedText && isSystemInjectedAcpPromptText(normalizedText)) {
    return false;
  }

  if (normalizedText && isSlackThreadActivityOnlyBlock(normalizedText)) {
    return false;
  }

  return true;
}

export type AcpToolCallPayloadKind =
  | 'execute'
  | 'read'
  | 'search'
  | 'subagent'
  | string
  | null;

/** Stable machine-level tool facts. User-facing labels and icons belong to UI clients. */
export const ACP_TOOL_KINDS = {
  execute: 'execute',
  read: 'read',
  search: 'search',
  list: 'list',
  edit: 'edit',
  subagent: 'subagent',
  task: 'task',
  communication: 'communication',
  memory: 'memory',
  artifact: 'artifact',
  widget: 'widget',
  mcp: 'mcp',
  tool: 'tool',
} as const;

export type KnownAcpToolKind =
  (typeof ACP_TOOL_KINDS)[keyof typeof ACP_TOOL_KINDS];

export interface AcpSessionUpdate extends Record<string, unknown> {
  sessionUpdate: string;
}

export interface AcpMcpInvocation {
  mcpServerName: string | null;
  mcpToolName: string | null;
}

export interface ExtractAcpMcpInvocationOptions {
  flattenedServerNames?: readonly string[];
  includeLegacyFlattenedServerNames?: boolean;
}

export interface AcpProviderUsagePayload {
  provider: string;
  providerResponseId: string;
  workflowPhase: string | null;
  model: string | null;
  serviceTier: string | null;
  method: string | null;
  path: string | null;
  upstreamStatus: number | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cumulativeInputTokens: number | null;
  cumulativeCachedInputTokens: number | null;
  cumulativeOutputTokens: number | null;
  cumulativeReasoningTokens: number | null;
  cumulativeTotalTokens: number | null;
}

export function parseAcpProviderUsagePayload(
  payload: Record<string, unknown> | null,
): AcpProviderUsagePayload | null {
  const provider = asStringOrNull(payload?.provider);
  const providerResponseId = asStringOrNull(payload?.providerResponseId);

  if (!provider || !providerResponseId) {
    return null;
  }

  const inputTokens = asFiniteNumber(payload?.inputTokens);
  const cachedInputTokens = asFiniteNumber(payload?.cachedInputTokens);
  const outputTokens = asFiniteNumber(payload?.outputTokens);
  const reasoningTokens = asFiniteNumber(payload?.reasoningTokens);
  const totalTokens = asFiniteNumber(payload?.totalTokens);

  if (
    inputTokens === undefined ||
    cachedInputTokens === undefined ||
    outputTokens === undefined ||
    reasoningTokens === undefined ||
    totalTokens === undefined
  ) {
    return null;
  }

  return {
    provider,
    providerResponseId,
    workflowPhase: normalizeProviderUsageWorkflowPhase(
      asStringOrNull(payload?.workflowPhase),
    ),
    model: asStringOrNull(payload?.model),
    serviceTier: asStringOrNull(payload?.serviceTier),
    method: asStringOrNull(payload?.method),
    path: asStringOrNull(payload?.path),
    upstreamStatus: asFiniteNumber(payload?.upstreamStatus) ?? null,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    cumulativeInputTokens:
      asFiniteNumber(payload?.cumulativeInputTokens) ?? null,
    cumulativeCachedInputTokens:
      asFiniteNumber(payload?.cumulativeCachedInputTokens) ?? null,
    cumulativeOutputTokens:
      asFiniteNumber(payload?.cumulativeOutputTokens) ?? null,
    cumulativeReasoningTokens:
      asFiniteNumber(payload?.cumulativeReasoningTokens) ?? null,
    cumulativeTotalTokens:
      asFiniteNumber(payload?.cumulativeTotalTokens) ?? null,
  };
}

export interface AcpToolCallPayload {
  toolCallId: string | null;
  title: string | null;
  kind: AcpToolCallPayloadKind;
  status: 'in_progress' | 'completed' | 'failed' | null;
  isExecute: boolean;
  isRead: boolean;
  isMcp: boolean;
  /** Trusted Roomote-native tool output persisted by the Fast runtime. */
  isRoomoteNativeTool?: boolean;
  mcpServerName: string | null;
  mcpToolName: string | null;
  command: string | null;
  /** Alias for `mcpServerName` (UI convenience). */
  serverName?: string | null;
  /** Alias for `mcpToolName` (UI convenience). */
  toolName?: string | null;
  isSubagentSpawn?: boolean;
  senderThreadId?: string | null;
  receiverThreadIds?: string[] | null;
  agentsStates?: Record<string, unknown> | null;
  prompt?: string | null;
  agentType?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  flattenedServerNames?: string[] | null;
}

export interface AcpToolResultPayload {
  toolCallId: string | null;
  kind: AcpToolCallPayloadKind;
  title: string | null;
  isExecute: boolean;
  isRead?: boolean;
  isMcp: boolean;
  /** Trusted Roomote-native tool output persisted by the Fast runtime. */
  isRoomoteNativeTool?: boolean;
  mcpServerName: string | null;
  mcpToolName: string | null;
  command: string | null;
  exitCode: number | null;
  output: string;
  status: 'in_progress' | 'completed' | 'failed' | null;
  /** Alias for `mcpServerName` (UI convenience). */
  serverName?: string | null;
  /** Alias for `mcpToolName` (UI convenience). */
  toolName?: string | null;
  isSubagentSpawn?: boolean;
  senderThreadId?: string | null;
  receiverThreadIds?: string[] | null;
  agentsStates?: Record<string, unknown> | null;
  prompt?: string | null;
  agentType?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  flattenedServerNames?: string[] | null;
}

export interface ShowWidgetFallbackDelivery {
  toolCallId: string;
  title: string | null;
  textFallback: string;
  widgetUrl: string;
}

export type AcpPlanEntryStatus = 'pending' | 'in_progress' | 'completed';

export interface AcpPlanEntry {
  content: string;
  status: AcpPlanEntryStatus;
  priority?: string;
}

export type AcpPlanTodo = AcpPlanEntry & { id: string };

export interface AcpPlanPayload {
  entries: AcpPlanEntry[];
}

export interface AcpOutputEvent {
  protocol: typeof ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL;
  sessionId: string;
  sequence: number;
  receivedAt: number;
  updateType: string;
  update: AcpSessionUpdate;
}

export interface AcpTurnCompletedEvent {
  protocol: typeof ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL;
  sessionId: string;
  ts: number;
  text: string;
}

export interface AcpPersistedEnvelope {
  ts: number;
  eventType: AcpEnvelopeEventType;
  role: TaskMessageRole;
  protocol: typeof ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL;
  contentBlocks: TaskMessageContentBlock[];
  metadata: Record<string, unknown> | null;
  payload: Record<string, unknown>;
  logicalEventId?: string;
  visibleInTranscript?: boolean;
}

/**
 * Unified message shape used for both live streaming events and persisted
 * envelopes loaded from the database. Matches the `task_messages` table
 * columns so DB records can be used directly without conversion.
 */
export interface AcpMessage {
  id: string;
  ts: number;
  eventType: AcpEventType;
  role: TaskMessageRole;
  kind: AcpMessageKind;
  contentBlocks: TaskMessageContentBlock[];
  metadata: Record<string, unknown> | null;
  payload: Record<string, unknown>;
  logicalEventId?: string;
  visibleInTranscript?: boolean;
  text?: string;
  userId?: string | null;
  userName?: string | null;
  userImageUrl?: string | null;
}

/**
 * Normalize a plan payload, handling the legacy `todos` → `entries` rename
 * for backwards compatibility with old persisted envelopes.
 */
export function normalizePlanPayload(
  data: Record<string, unknown>,
): AcpPlanPayload {
  const entries = Array.isArray(data.entries)
    ? (data.entries as AcpPlanEntry[])
    : Array.isArray(data.todos)
      ? (data.todos as AcpPlanEntry[])
      : [];
  return { entries };
}

export function extractAcpMcpInvocation(
  update: Record<string, unknown>,
  options: ExtractAcpMcpInvocationOptions = {},
): AcpMcpInvocation | null {
  const kind = asStringOrNull(update.kind);
  const mcpServerName = asStringOrNull(update.mcpServerName);
  const mcpToolName = asStringOrNull(update.mcpToolName);

  if (mcpServerName || mcpToolName) {
    return {
      mcpServerName: mcpServerName ?? null,
      mcpToolName: mcpToolName ?? null,
    };
  }

  const rawInput = asRecordOrNull(update.rawInput);

  const rawServerName =
    asStringOrNull(rawInput?.server) ?? asStringOrNull(rawInput?.serverName);

  const rawToolName =
    asStringOrNull(rawInput?.tool) ?? asStringOrNull(rawInput?.toolName);

  if (rawServerName || rawToolName) {
    return {
      mcpServerName: rawServerName ?? null,
      mcpToolName: rawToolName ?? null,
    };
  }

  const meta = asRecordOrNull(update._meta);

  const claudeCodeMeta = asRecordOrNull(meta?.claudeCode);

  const encodedToolName =
    asStringOrNull(claudeCodeMeta?.toolName) ?? asStringOrNull(update.title);

  const claudeInvocation = parseAcpClaudeMcpToolName(encodedToolName);

  if (claudeInvocation) {
    return claudeInvocation;
  }

  const flattenedInvocation = parseAcpFlattenedMcpToolName(encodedToolName, [
    ...(options.includeLegacyFlattenedServerNames === false
      ? []
      : LEGACY_FLATTENED_MCP_SERVER_NAMES),
    ...collectAcpFlattenedServerNames(update),
    ...(options.flattenedServerNames ?? []),
  ]);

  if (flattenedInvocation) {
    return flattenedInvocation;
  }

  if (kind !== 'mcp') {
    return null;
  }

  return parseAcpSlashDelimitedMcpToolName(asStringOrNull(update.title));
}

export function collectAcpFlattenedServerNames(
  ...updates: Array<Record<string, unknown> | null | undefined>
): string[] {
  const names = updates.flatMap((update) => {
    const flattened = Array.isArray(update?.flattenedServerNames)
      ? update.flattenedServerNames
      : [];
    const mcpServerNames = Array.isArray(update?.mcpServerNames)
      ? update.mcpServerNames
      : [];

    return [...flattened, ...mcpServerNames]
      .map((value) => asStringOrNull(value))
      .filter((value): value is string => Boolean(value));
  });

  return Array.from(new Set(names));
}

function parseAcpClaudeMcpToolName(
  value: string | null | undefined,
): AcpMcpInvocation | null {
  if (!value?.startsWith('mcp__')) {
    return null;
  }

  const rest = value.slice('mcp__'.length);
  if (!rest || rest[0] === '_') {
    return null;
  }

  const separatorIndex = rest.indexOf('__');
  if (separatorIndex <= 0) {
    return null;
  }

  const mcpServerName = rest.slice(0, separatorIndex);
  const mcpToolName = rest.slice(separatorIndex + 2);
  if (!mcpServerName || !mcpToolName) {
    return null;
  }

  return {
    mcpServerName,
    mcpToolName,
  };
}

function parseAcpSlashDelimitedMcpToolName(
  value: string | null | undefined,
): AcpMcpInvocation | null {
  if (!value || value.includes(' ')) {
    return null;
  }

  const separatorIndex = value.indexOf('/');

  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return null;
  }

  return {
    mcpServerName: value.slice(0, separatorIndex),
    mcpToolName: value.slice(separatorIndex + 1),
  };
}

export function parseAcpFlattenedMcpToolName(
  value: string | null | undefined,
  serverNames: readonly string[],
): AcpMcpInvocation | null {
  if (!value || value.includes(' ')) {
    return null;
  }

  const orderedServerNames = [...serverNames]
    .map((serverName) => serverName.trim())
    .filter((serverName) => serverName.length > 0)
    .sort((left, right) => right.length - left.length);

  for (const serverName of orderedServerNames) {
    const prefix = `${serverName}_`;

    if (!value.startsWith(prefix) || value.length <= prefix.length) {
      continue;
    }

    return {
      mcpServerName: serverName,
      mcpToolName: value.slice(prefix.length),
    };
  }

  return null;
}

const LEGACY_FLATTENED_MCP_SERVER_NAMES = ['browser-mcp', 'roomote'] as const;

function skipAsciiWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (
      code !== 32 &&
      code !== 9 &&
      code !== 10 &&
      code !== 11 &&
      code !== 12 &&
      code !== 13
    ) {
      break;
    }
    i += 1;
  }
  return i;
}

function matchOpenTag(
  text: string,
  index: number,
  tagName: string,
  allowAttributes: boolean,
): number | null {
  const openPrefix = `<${tagName}`;
  if (!text.startsWith(openPrefix, index)) {
    return null;
  }

  const i = index + openPrefix.length;
  if (i >= text.length) {
    return null;
  }

  if (text[i] === '>') {
    return i + 1;
  }

  if (!allowAttributes) {
    return null;
  }

  const code = text.charCodeAt(i);
  if (
    code !== 32 &&
    code !== 9 &&
    code !== 10 &&
    code !== 11 &&
    code !== 12 &&
    code !== 13
  ) {
    return null;
  }

  const close = text.indexOf('>', i + 1);
  if (close === -1) {
    return null;
  }

  return close + 1;
}

function findStructuralClose(
  text: string,
  searchFrom: number,
  closeMarker: string,
  accept: (closeIndex: number, afterClose: number) => boolean,
): { closeIndex: number; afterClose: number } | null {
  let from = searchFrom;
  while (from <= text.length) {
    const closeIndex = text.indexOf(closeMarker, from);
    if (closeIndex === -1) {
      return null;
    }

    const afterClose = skipAsciiWhitespace(
      text,
      closeIndex + closeMarker.length,
    );
    if (accept(closeIndex, afterClose)) {
      return { closeIndex, afterClose };
    }

    from = closeIndex + 1;
  }

  return null;
}

function matchesThreadActivityOnlyFrom(text: string, index: number): boolean {
  const openTag = '<thread_activity>';
  const closeTag = '</thread_activity>';

  // Iterative DFS with explicit close backtracking so long sequences of valid
  // thread_activity blocks cannot overflow the call stack.
  const alternateCloseFrom: number[] = [];
  let pos = index;

  while (true) {
    if (pos === text.length) {
      return true;
    }

    if (!text.startsWith(openTag, pos)) {
      if (!advanceToNextCloseAlternate()) {
        return false;
      }
      continue;
    }

    const closeIndex = text.indexOf(closeTag, pos + openTag.length);
    if (closeIndex === -1) {
      if (!advanceToNextCloseAlternate()) {
        return false;
      }
      continue;
    }

    alternateCloseFrom.push(closeIndex + 1);
    pos = skipAsciiWhitespace(text, closeIndex + closeTag.length);
  }

  function advanceToNextCloseAlternate(): boolean {
    while (alternateCloseFrom.length > 0) {
      const nextFrom = alternateCloseFrom[alternateCloseFrom.length - 1]!;
      const closeIndex = text.indexOf(closeTag, nextFrom);
      if (closeIndex === -1) {
        alternateCloseFrom.pop();
        continue;
      }

      alternateCloseFrom[alternateCloseFrom.length - 1] = closeIndex + 1;
      pos = skipAsciiWhitespace(text, closeIndex + closeTag.length);
      return true;
    }

    return false;
  }
}

function isSlackThreadActivityOnlyBlock(text: string): boolean {
  return text.length > 0 && matchesThreadActivityOnlyFrom(text, 0);
}

/**
 * Extract slack_message content from:
 *   thread_activity* thread_context? thread_activity*
 *   replying_to? slack_turn_policy? slack_message_context? slack_message
 *
 * Implemented as the original recursive descent with per-(pos, phase) memoization,
 * executed on an explicit heap stack so thousands of sequential activity blocks
 * neither overflow the call stack nor O(n^2) re-scan.
 */
function extractSlackTranscriptMessageContent(text: string): string | null {
  return parseSlackTranscriptFrom(text, 0);
}

function extractSlackMessageAt(text: string, index: number): string | null {
  const afterOpen = matchOpenTag(text, index, 'slack_message', true);
  if (afterOpen === null) {
    return null;
  }

  let contentStart = afterOpen;
  if (text[contentStart] === '\n') {
    contentStart += 1;
  }

  const closeTag = '</slack_message>';
  const found = findStructuralClose(
    text,
    contentStart,
    closeTag,
    (_close, afterClose) => afterClose === text.length,
  );
  if (found === null) {
    return null;
  }

  let contentEnd = found.closeIndex;
  if (contentEnd > contentStart && text[contentEnd - 1] === '\n') {
    contentEnd -= 1;
  }

  return text.slice(contentStart, contentEnd);
}

function parseSlackRestFrom(text: string, index: number): string | null {
  const afterReplyingOpen = matchOpenTag(text, index, 'replying_to', true);
  if (afterReplyingOpen !== null && text[afterReplyingOpen] === '\n') {
    const closeMarker = '\n</replying_to>';
    const found = findStructuralClose(
      text,
      afterReplyingOpen + 1,
      closeMarker,
      (_close, afterClose) => parseSlackRestAfterReplying(afterClose) !== null,
    );
    if (found !== null) {
      return parseSlackRestAfterReplying(found.afterClose);
    }
  }

  return parseSlackRestAfterReplying(index);

  function parseSlackRestAfterReplying(at: number): string | null {
    const afterPolicyOpen = matchOpenTag(text, at, 'slack_turn_policy', true);
    if (afterPolicyOpen !== null && text[afterPolicyOpen] === '\n') {
      const closeMarker = '\n</slack_turn_policy>';
      const found = findStructuralClose(
        text,
        afterPolicyOpen + 1,
        closeMarker,
        (_close, afterClose) =>
          extractSlackMessageAfterOptionalContext(text, afterClose) !== null,
      );
      if (found !== null) {
        return extractSlackMessageAfterOptionalContext(text, found.afterClose);
      }
    }

    return extractSlackMessageAfterOptionalContext(text, at);
  }
}

function extractSlackMessageAfterOptionalContext(
  text: string,
  index: number,
): string | null {
  const afterContextOpen = matchOpenTag(
    text,
    index,
    'slack_message_context',
    false,
  );
  if (afterContextOpen !== null && text[afterContextOpen] === '\n') {
    const closeMarker = '\n</slack_message_context>';
    const found = findStructuralClose(
      text,
      afterContextOpen + 1,
      closeMarker,
      (_close, afterClose) => extractSlackMessageAt(text, afterClose) !== null,
    );
    if (found !== null) {
      return extractSlackMessageAt(text, found.afterClose);
    }
  }

  return extractSlackMessageAt(text, index);
}

function parseSlackTranscriptFrom(text: string, start: number): string | null {
  // phase: 0 = pre-context (leading activities), 1 = post-context (trailing + rest)
  type Frame = {
    pos: number;
    phase: 0 | 1;
    /** 0 init/activity; 1 scanning activity closes; 2 after child (activity or post); 3 scanning context closes; 4 rest */
    mode: 0 | 1 | 2 | 3 | 4;
    scanFrom: number;
    childPos: number;
    childPhase: 0 | 1;
  };

  const stride = text.length + 1;
  const memo = new Map<number, string | null>();
  const keyOf = (pos: number, phase: 0 | 1) => phase * stride + pos;

  const stack: Frame[] = [
    {
      pos: start,
      phase: 0,
      mode: 0,
      scanFrom: 0,
      childPos: 0,
      childPhase: 0,
    },
  ];
  let lastResult: string | null = null;

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const key = keyOf(frame.pos, frame.phase);

    if (frame.mode === 0) {
      if (memo.has(key)) {
        lastResult = memo.get(key)!;
        stack.pop();
        continue;
      }

      // Prefer one thread_activity whose remainder solves in the same phase.
      const afterOpen = matchOpenTag(text, frame.pos, 'thread_activity', false);
      if (afterOpen !== null && text[afterOpen] === '\n') {
        frame.scanFrom = afterOpen + 1;
        frame.mode = 1;
        continue;
      }

      // No activity open at this pos.
      if (frame.phase === 0) {
        // Optional thread_context, else post phase at same pos.
        const ctxOpen = matchOpenTag(text, frame.pos, 'thread_context', false);
        if (ctxOpen !== null && text[ctxOpen] === '\n') {
          frame.scanFrom = ctxOpen + 1;
          frame.mode = 3;
          continue;
        }
        frame.childPos = frame.pos;
        frame.childPhase = 1;
        frame.mode = 2;
        const childKey = keyOf(frame.childPos, 1);
        if (memo.has(childKey)) {
          lastResult = memo.get(childKey)!;
        } else {
          stack.push({
            pos: frame.childPos,
            phase: 1,
            mode: 0,
            scanFrom: 0,
            childPos: 0,
            childPhase: 0,
          });
        }
        continue;
      }

      // phase post: fall through to rest.
      frame.mode = 4;
      continue;
    }

    if (frame.mode === 1) {
      const closeMarker = '\n</thread_activity>';
      const closeIndex = text.indexOf(closeMarker, frame.scanFrom);
      if (closeIndex === -1) {
        // No more activity closes — fall through like mode 0 without activity.
        if (frame.phase === 0) {
          const ctxOpen = matchOpenTag(
            text,
            frame.pos,
            'thread_context',
            false,
          );
          if (ctxOpen !== null && text[ctxOpen] === '\n') {
            frame.scanFrom = ctxOpen + 1;
            frame.mode = 3;
            continue;
          }
          frame.childPos = frame.pos;
          frame.childPhase = 1;
          frame.mode = 2;
          const childKey = keyOf(frame.childPos, 1);
          if (memo.has(childKey)) {
            lastResult = memo.get(childKey)!;
          } else {
            stack.push({
              pos: frame.childPos,
              phase: 1,
              mode: 0,
              scanFrom: 0,
              childPos: 0,
              childPhase: 0,
            });
          }
          continue;
        }
        frame.mode = 4;
        continue;
      }

      frame.childPos = skipAsciiWhitespace(
        text,
        closeIndex + closeMarker.length,
      );
      frame.childPhase = frame.phase;
      frame.scanFrom = closeIndex + 1;
      frame.mode = 2;

      const childKey = keyOf(frame.childPos, frame.childPhase);
      if (memo.has(childKey)) {
        lastResult = memo.get(childKey)!;
      } else {
        stack.push({
          pos: frame.childPos,
          phase: frame.childPhase,
          mode: 0,
          scanFrom: 0,
          childPos: 0,
          childPhase: 0,
        });
      }
      continue;
    }

    if (frame.mode === 2) {
      // Child finished in lastResult.
      if (lastResult !== null) {
        memo.set(key, lastResult);
        stack.pop();
        continue;
      }

      // Child failed. If we were probing activity closes, try next close;
      // if we were probing context, try next context close; if post-at-pos failed, done.
      // Distinguish via childPhase and whether scan is activity vs context:
      // activity probe uses childPhase === frame.phase and scan on activity closes.
      // We need a flag: use mode transitions carefully.

      // Heuristic: if scanFrom was activity (mode came from 1), resume mode 1.
      // If from context (mode 3), resume mode 3.
      // If from post-at-pos fallback (childPos === pos && childPhase === 1 && phase === 0), fail.
      if (
        frame.phase === 0 &&
        frame.childPhase === 1 &&
        frame.childPos === frame.pos
      ) {
        memo.set(key, null);
        lastResult = null;
        stack.pop();
        continue;
      }

      if (frame.childPhase === frame.phase) {
        // activity child failed — next activity close
        frame.mode = 1;
        continue;
      }

      // context child failed — next context close
      frame.mode = 3;
      continue;
    }

    if (frame.mode === 3) {
      const closeMarker = '\n</thread_context>';
      const closeIndex = text.indexOf(closeMarker, frame.scanFrom);
      if (closeIndex === -1) {
        // No more context — post at same position.
        frame.childPos = frame.pos;
        frame.childPhase = 1;
        frame.mode = 2;
        const childKey = keyOf(frame.childPos, 1);
        if (memo.has(childKey)) {
          lastResult = memo.get(childKey)!;
        } else {
          stack.push({
            pos: frame.childPos,
            phase: 1,
            mode: 0,
            scanFrom: 0,
            childPos: 0,
            childPhase: 0,
          });
        }
        continue;
      }

      frame.childPos = skipAsciiWhitespace(
        text,
        closeIndex + closeMarker.length,
      );
      frame.childPhase = 1;
      frame.scanFrom = closeIndex + 1;
      frame.mode = 2;

      const childKey = keyOf(frame.childPos, 1);
      if (memo.has(childKey)) {
        lastResult = memo.get(childKey)!;
      } else {
        stack.push({
          pos: frame.childPos,
          phase: 1,
          mode: 0,
          scanFrom: 0,
          childPos: 0,
          childPhase: 0,
        });
      }
      continue;
    }

    // mode 4: rest
    {
      const result = parseSlackRestFrom(text, frame.pos);
      memo.set(key, result);
      lastResult = result;
      stack.pop();
    }
  }

  return memo.get(keyOf(start, 0)) ?? null;
}

/**
 * Non-Slack providers may prefix the user turn with Slack-parity blocks before
 * the communication_message wrapper:
 *   thread_context? replying_to? {provider}_turn_policy? communication_message
 *
 * Only the communication_message body is user-visible in the transcript.
 */
const COMMUNICATION_TURN_POLICY_TAGS = [
  'discord_turn_policy',
  'teams_turn_policy',
  'telegram_turn_policy',
] as const;

function extractCommunicationMessageAt(
  text: string,
  index: number,
): string | null {
  const afterOpen = matchOpenTag(text, index, 'communication_message', true);
  if (afterOpen === null) {
    return null;
  }

  let contentStart = afterOpen;
  if (text[contentStart] === '\n') {
    contentStart += 1;
  }

  const closeTag = '</communication_message>';
  const found = findStructuralClose(
    text,
    contentStart,
    closeTag,
    (_close, afterClose) => afterClose === text.length,
  );
  if (found === null) {
    return null;
  }

  let contentEnd = found.closeIndex;
  if (contentEnd > contentStart && text[contentEnd - 1] === '\n') {
    contentEnd -= 1;
  }

  return text.slice(contentStart, contentEnd);
}

function parseCommunicationRestAfterReplying(
  text: string,
  at: number,
): string | null {
  for (const tag of COMMUNICATION_TURN_POLICY_TAGS) {
    const afterPolicyOpen = matchOpenTag(text, at, tag, true);
    if (afterPolicyOpen !== null && text[afterPolicyOpen] === '\n') {
      const closeMarker = `\n</${tag}>`;
      const found = findStructuralClose(
        text,
        afterPolicyOpen + 1,
        closeMarker,
        (_close, afterClose) =>
          extractCommunicationMessageAt(text, afterClose) !== null,
      );
      if (found !== null) {
        return extractCommunicationMessageAt(text, found.afterClose);
      }
    }
  }

  return extractCommunicationMessageAt(text, at);
}

function parseCommunicationRestFrom(
  text: string,
  index: number,
): string | null {
  const afterReplyingOpen = matchOpenTag(text, index, 'replying_to', true);
  if (afterReplyingOpen !== null && text[afterReplyingOpen] === '\n') {
    const closeMarker = '\n</replying_to>';
    const found = findStructuralClose(
      text,
      afterReplyingOpen + 1,
      closeMarker,
      (_close, afterClose) =>
        parseCommunicationRestAfterReplying(text, afterClose) !== null,
    );
    if (found !== null) {
      return parseCommunicationRestAfterReplying(text, found.afterClose);
    }
  }

  return parseCommunicationRestAfterReplying(text, index);
}

function extractCommunicationTranscriptMessage(text: string): string | null {
  const afterContextOpen = matchOpenTag(text, 0, 'thread_context', false);
  if (afterContextOpen !== null && text[afterContextOpen] === '\n') {
    const closeMarker = '\n</thread_context>';
    const found = findStructuralClose(
      text,
      afterContextOpen + 1,
      closeMarker,
      (_close, afterClose) =>
        parseCommunicationRestFrom(text, afterClose) !== null,
    );
    if (found !== null) {
      return parseCommunicationRestFrom(text, found.afterClose);
    }
  }

  return parseCommunicationRestFrom(text, 0);
}

function extractGithubFollowUpTranscriptMessage(text: string): string | null {
  const openTag = '<github-pr-follow-up>';
  const closeTag = '</github-pr-follow-up>';
  if (!text.startsWith(openTag)) {
    return null;
  }

  const closeIndex = text.indexOf(closeTag, openTag.length);
  if (closeIndex === -1) {
    return null;
  }

  const body = text.slice(openTag.length, closeIndex);
  const remainder = text.slice(closeIndex + closeTag.length).trim();
  if (remainder.length > 0) {
    const instructionsOpen = '<github_message_instructions>';
    const instructionsClose = '</github_message_instructions>';
    if (
      !remainder.startsWith(instructionsOpen) ||
      !remainder.endsWith(instructionsClose)
    ) {
      return null;
    }
  }

  for (const tag of ['requested-follow-up', 'requested_follow_up'] as const) {
    const requestOpen = `<${tag}>`;
    const requestClose = `</${tag}>`;
    const requestStart = body.indexOf(requestOpen);
    if (requestStart === -1) {
      continue;
    }
    let contentStart = requestStart + requestOpen.length;
    if (body[contentStart] === '\n') {
      contentStart += 1;
    }
    const requestEnd = body.indexOf(requestClose, contentStart);
    if (requestEnd === -1) {
      continue;
    }
    let contentEnd = requestEnd;
    if (contentEnd > contentStart && body[contentEnd - 1] === '\n') {
      contentEnd -= 1;
    }
    return body.slice(contentStart, contentEnd);
  }

  return null;
}

export function decodeWrappedMessageEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt);/g, (entity) => {
    switch (entity.slice(1, -1)) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      default:
        return entity;
    }
  });
}

function stripQuotedCommunicationPrefix(value: string): string {
  let index = 0;
  while (
    index < value.length &&
    (value[index] === ' ' ||
      value[index] === '\t' ||
      value[index] === '\n' ||
      value[index] === '\r')
  ) {
    index += 1;
  }
  const open = '<quoted';
  if (!value.toLowerCase().startsWith(open, index)) {
    return value;
  }

  // Match the previous pattern: <quoted(?:\s+[^>]*)?\/>
  // The tag itself must end with "/>" — no bare ">" is allowed earlier.
  let cursor = index + open.length;
  const afterTagName = value[cursor];
  if (afterTagName === '/') {
    if (value[cursor + 1] !== '>') {
      return value;
    }
    cursor += 2;
  } else if (
    afterTagName === ' ' ||
    afterTagName === '\t' ||
    afterTagName === '\n' ||
    afterTagName === '\r'
  ) {
    const closeIndex = value.indexOf('/>', cursor);
    if (closeIndex === -1) {
      return value;
    }
    const bareClose = value.indexOf('>', cursor);
    if (bareClose !== -1 && bareClose < closeIndex + 1) {
      // bareClose == closeIndex + 1 is the ">" of "/>"; anything earlier rejects.
      if (bareClose < closeIndex) {
        return value;
      }
    }
    cursor = closeIndex + 2;
  } else {
    return value;
  }

  while (
    cursor < value.length &&
    (value[cursor] === ' ' ||
      value[cursor] === '\t' ||
      value[cursor] === '\n' ||
      value[cursor] === '\r')
  ) {
    cursor += 1;
  }
  return value.slice(cursor);
}

function normalizeCommunicationTranscriptContent(value: string): string {
  return stripQuotedCommunicationPrefix(decodeWrappedMessageEntities(value));
}

/**
 * Leading block prepended to a web-sent prompt to re-surface out-of-band
 * messages (e.g. PR review-feedback or PR status-change notifications) that
 * were persisted to task history without entering the harness session.
 * Stripped from user-visible transcript text by
 * {@link normalizeTranscriptUserText}.
 */
function stripLeadingOutOfBandContextBlock(text: string): string {
  let index = 0;
  while (
    index < text.length &&
    (text[index] === ' ' ||
      text[index] === '\t' ||
      text[index] === '\n' ||
      text[index] === '\r')
  ) {
    index += 1;
  }
  const open = '<out_of_band_context>\n';
  const close = '\n</out_of_band_context>';
  if (!text.startsWith(open, index)) {
    return text;
  }
  const closeIndex = text.indexOf(close, index + open.length);
  if (closeIndex === -1) {
    return text;
  }
  let end = closeIndex + close.length;
  while (
    end < text.length &&
    (text[end] === ' ' ||
      text[end] === '\t' ||
      text[end] === '\n' ||
      text[end] === '\r')
  ) {
    end += 1;
  }
  // Drop any leading whitespace that only preceded the OOB block so the
  // remaining user prompt stays at offset 0 for downstream wrapper parsers.
  return text.slice(end);
}

function escapeOutOfBandMessageContent(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * Wraps out-of-band messages into the context block that gets prepended to
 * the user's next prompt. Returns undefined when there is nothing to wrap.
 */
export function wrapOutOfBandContext(
  messages: Array<{ sentAtMs?: number | null; text: string }>,
): string | undefined {
  const formattedMessages = messages
    .map(({ sentAtMs, text }) => {
      const normalizedText = text.trim();

      if (!normalizedText) {
        return null;
      }

      const sentAtAttribute =
        typeof sentAtMs === 'number' && Number.isFinite(sentAtMs)
          ? ` sent_at="${new Date(sentAtMs).toISOString()}"`
          : '';

      return `<out_of_band_message${sentAtAttribute}>\n${escapeOutOfBandMessageContent(normalizedText)}\n</out_of_band_message>`;
    })
    .filter((entry): entry is string => entry !== null);

  if (formattedMessages.length === 0) {
    return undefined;
  }

  return `<out_of_band_context>\nWhile this session was idle, the following message(s) were sent to the user on your behalf. They are not part of your conversation history, and the user's message below may be replying to them.\n\n${formattedMessages.join('\n\n')}\n</out_of_band_context>`;
}

/**
 * Strips a leading out-of-band context block from a delivered prompt so only
 * the user's own message remains.
 */
export function stripLeadingOutOfBandContext(text: string): string {
  return stripLeadingOutOfBandContextBlock(text);
}

function matchLinkedReviewResults(text: string): { body: string } | null {
  const trimmed = text.trim();
  for (const tag of ['review_result', 'code-review-results'] as const) {
    const openPrefix = `<${tag}`;
    if (!trimmed.startsWith(openPrefix)) {
      continue;
    }
    const afterTag = trimmed[openPrefix.length];
    if (
      afterTag !== undefined &&
      afterTag !== '>' &&
      afterTag !== ' ' &&
      afterTag !== '\t' &&
      afterTag !== '\n' &&
      afterTag !== '\r'
    ) {
      continue;
    }
    const openEnd = trimmed.indexOf('>');
    if (openEnd === -1) {
      continue;
    }
    const close = `</${tag}>`;
    if (!trimmed.endsWith(close)) {
      continue;
    }
    const body = trimmed
      .slice(openEnd + 1, trimmed.length - close.length)
      .trim();
    return { body };
  }
  return null;
}

export function isLinkedReviewResultsMessage(
  text: string | null | undefined,
): boolean {
  return !!text && matchLinkedReviewResults(text) !== null;
}

export interface ParsedLinkedReviewResults {
  raw: string;
  reviewKind: 'initial' | 'sync' | null;
  outcome: string | null;
  title: string | null;
  summary: string;
  findingCount: number | null;
  repository: string | null;
  pullRequestNumber: number | null;
  currentHeadSha: string | null;
  approvalStatus: 'approved' | 'skipped' | null;
}

function getWrappedTagValue(body: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = body.indexOf(open);
  if (start === -1) {
    return null;
  }
  const contentStart = start + open.length;
  const end = body.indexOf(close, contentStart);
  if (end === -1) {
    return null;
  }
  return body.slice(contentStart, end).trim() || null;
}

function stripInlineXmlTags(value: string): string {
  let result = value;
  let previous: string;
  do {
    previous = result;
    result = result.replace(/<[^>]*>/g, ' ');
  } while (result !== previous);
  return result.replace(/\s+/g, ' ').trim();
}

function parseOptionalIntegerTag(body: string, tag: string): number | null {
  const value = getWrappedTagValue(body, tag);

  if (value === null) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isNaN(parsed) ? null : parsed;
}

export function parseLinkedReviewResults(
  text: string | null | undefined,
): ParsedLinkedReviewResults | null {
  if (!text) {
    return null;
  }

  const wrapped = matchLinkedReviewResults(text);

  if (!wrapped) {
    return null;
  }

  const raw = wrapped.body;
  const reviewKindTag = getWrappedTagValue(raw, 'review_kind');
  const approvalStatusTag = getWrappedTagValue(raw, 'approval_status');
  const summary =
    getWrappedTagValue(raw, 'summary') ??
    getWrappedTagValue(raw, 'status_line') ??
    stripInlineXmlTags(raw);
  const findingCountTag =
    getWrappedTagValue(raw, 'finding_count') ??
    getWrappedTagValue(raw, 'actionable_findings_count');
  const parsedFindingCount =
    findingCountTag === null ? null : Number.parseInt(findingCountTag, 10);

  return {
    raw,
    reviewKind:
      reviewKindTag === 'initial' || reviewKindTag === 'sync'
        ? reviewKindTag
        : null,
    outcome: getWrappedTagValue(raw, 'outcome'),
    title: getWrappedTagValue(raw, 'title'),
    summary,
    findingCount: Number.isNaN(parsedFindingCount) ? null : parsedFindingCount,
    repository: getWrappedTagValue(raw, 'repository'),
    pullRequestNumber: parseOptionalIntegerTag(raw, 'pull_request_number'),
    currentHeadSha: getWrappedTagValue(raw, 'current_head_sha'),
    approvalStatus:
      approvalStatusTag === 'approved' || approvalStatusTag === 'skipped'
        ? approvalStatusTag
        : null,
  };
}

/**
 * Strip Roomote communication wrappers and decode HTML entities for
 * user-visible transcript text. When an `eventType` is provided, only
 * UserPrompt events are processed; all other event types pass through unchanged.
 */
export function normalizeTranscriptUserText(
  text: string | null | undefined,
  eventType?: AcpEventType | string,
): string | undefined {
  if (!text) {
    return undefined;
  }

  if (
    eventType !== undefined &&
    eventType !== ACP_ENVELOPE_EVENT_TYPES.UserPrompt
  ) {
    return text;
  }

  text = stripLeadingOutOfBandContext(text);

  const wrapped = extractSlackTranscriptMessageContent(text);

  if (wrapped !== null) {
    return decodeWrappedMessageEntities(wrapped);
  }

  const githubWrapped = extractGithubFollowUpTranscriptMessage(text);

  if (githubWrapped !== null) {
    return decodeWrappedMessageEntities(githubWrapped);
  }

  const communicationWrapped = extractCommunicationTranscriptMessage(text);

  if (communicationWrapped !== null) {
    return normalizeCommunicationTranscriptContent(communicationWrapped);
  }

  const decodedText = decodeWrappedMessageEntities(text);

  if (decodedText !== text) {
    const decodedWrapped = extractSlackTranscriptMessageContent(decodedText);

    if (decodedWrapped !== null) {
      return decodeWrappedMessageEntities(decodedWrapped);
    }

    const decodedGithubWrapped =
      extractGithubFollowUpTranscriptMessage(decodedText);

    if (decodedGithubWrapped !== null) {
      return decodeWrappedMessageEntities(decodedGithubWrapped);
    }

    const decodedCommunicationWrapped =
      extractCommunicationTranscriptMessage(decodedText);

    if (decodedCommunicationWrapped !== null) {
      return normalizeCommunicationTranscriptContent(
        decodedCommunicationWrapped,
      );
    }
  }

  return text;
}

// ---------------------------------------------------------------------------
// Request-user-input display helpers
// ---------------------------------------------------------------------------

export function getAnswerDisplayValue(
  question: AcpRequestUserInputQuestion | null,
  answers: string[],
): string {
  if (question?.isSecret) {
    return '[hidden]';
  }

  const joined = answers
    .map((answer) => answer.trim())
    .filter(Boolean)
    .join(', ');

  return joined.length > 0 ? joined : '[no response]';
}

export function getAnswerDisplayLabel(
  question: AcpRequestUserInputQuestion | null,
  questionId: string,
): string {
  return question?.header?.trim() || question?.question?.trim() || questionId;
}

export function formatRequestUserInputResponseText(
  request: AcpRequestUserInputPayload | null,
  response:
    | AcpRequestUserInputResponsePayload
    | Pick<AcpRequestUserInputResponsePayload, 'resolution' | 'answers'>,
): string {
  if (response.resolution === 'cancelled') {
    return 'Cancelled input request';
  }

  const questionById = new Map(
    (request?.questions ?? []).map((question) => [question.id, question]),
  );
  const orderedQuestionIds =
    request?.questions.map((question) => question.id) ??
    Object.keys(response.answers);

  const seenQuestionIds = new Set<string>();
  const entries: Array<{ label: string; value: string }> = [];

  for (const questionId of orderedQuestionIds) {
    seenQuestionIds.add(questionId);
    const answerGroup = response.answers[questionId];

    if (!answerGroup || answerGroup.answers.length === 0) {
      continue;
    }

    const question = questionById.get(questionId) ?? null;
    entries.push({
      label: getAnswerDisplayLabel(question, questionId),
      value: getAnswerDisplayValue(question, answerGroup.answers),
    });
  }

  for (const [questionId, answerGroup] of Object.entries(response.answers)) {
    if (seenQuestionIds.has(questionId) || answerGroup.answers.length === 0) {
      continue;
    }

    entries.push({
      label: getAnswerDisplayLabel(null, questionId),
      value: getAnswerDisplayValue(null, answerGroup.answers),
    });
  }

  if (entries.length === 0) {
    return 'Submitted input response';
  }

  if (entries.length === 1) {
    return entries[0]!.value;
  }

  return entries.map((entry) => `${entry.label}: ${entry.value}`).join('\n');
}

// ---------------------------------------------------------------------------
// Snapshot-resume visible prompt field restoration
// ---------------------------------------------------------------------------

const SNAPSHOT_RESUME_VISIBLE_PROMPT_STRING_KEYS = [
  'description',
  'text',
  'commentBody',
] as const;

export function restoreSnapshotResumeVisiblePromptFields(
  payload: Record<string, unknown>,
  sourcePayload: unknown,
): void {
  if (!sourcePayload || typeof sourcePayload !== 'object') {
    return;
  }

  const source = sourcePayload as Record<string, unknown>;

  for (const key of SNAPSHOT_RESUME_VISIBLE_PROMPT_STRING_KEYS) {
    if (typeof payload[key] === 'string' && payload[key].length > 0) {
      continue;
    }

    if (typeof source[key] === 'string' && source[key].length > 0) {
      payload[key] = source[key];
    }
  }

  if (
    !Array.isArray(payload.images) &&
    Array.isArray(source.images) &&
    source.images.every((image) => typeof image === 'string')
  ) {
    payload.images = source.images;
  }

  if (
    typeof payload.visibleInTranscript !== 'boolean' &&
    typeof source.visibleInTranscript === 'boolean'
  ) {
    payload.visibleInTranscript = source.visibleInTranscript;
  }

  if (
    typeof payload.reasoningEffort !== 'string' &&
    isReasoningEffort(source.reasoningEffort)
  ) {
    payload.reasoningEffort = source.reasoningEffort;
  }
}

// ── Constants ────────────────────────────────────────────────────────────

/** Maximum chars for tool output served over the API (DB read boundary). */
export const ACP_API_TOOL_OUTPUT_MAX_CHARS = 32_000;

/** Maximum chars for tool output rendered in the sandbox UI. */
export const ACP_UI_TOOL_OUTPUT_MAX_CHARS = 20_000;

// ── Types ────────────────────────────────────────────────────────────────

export interface AcpOutputTruncation {
  originalChars: number;
  keptChars: number;
  strategy: 'head_tail';
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Extract a human-readable command string from runtime tool `rawInput`.
 *
 * Prefers `parsed_cmd` (array of `{ cmd }` objects) over the raw `command`
 * array. Returns `undefined` when no command can be extracted.
 */
export function extractCommandFromRawInput(
  rawInput: unknown,
): string | undefined {
  const record = asRecord(rawInput);
  if (!record) {
    return undefined;
  }

  if (Array.isArray(record.parsed_cmd)) {
    const parts = (record.parsed_cmd as unknown[])
      .map((entry) => asString(asRecord(entry)?.cmd))
      .filter(Boolean);

    if (parts.length > 0) {
      return parts.join(' && ');
    }
  }

  return asString(record.command) ?? undefined;
}

// ── Core truncation ──────────────────────────────────────────────────────

/**
 * Truncate text using a head/tail strategy that preserves the beginning and
 * end of the output (where the most useful context usually lives).
 */
export function truncateAcpOutputText(
  text: string,
  maxChars: number,
): { text: string; truncation: AcpOutputTruncation | null } {
  if (text.length <= maxChars) {
    return { text, truncation: null };
  }

  const headChars = Math.ceil(maxChars / 2);
  const tailChars = Math.floor(maxChars / 2);
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  const marker = `\n... [output truncated: kept ${maxChars} of ${text.length} chars] ...\n`;

  return {
    text: `${head}${marker}${tail}`,
    truncation: {
      originalChars: text.length,
      keptChars: maxChars,
      strategy: 'head_tail',
    },
  };
}

// ── Output text extraction ───────────────────────────────────────────────

export function textFromContentBlock(
  block: Record<string, unknown>,
): string | undefined {
  const type = asStringOrNull(block.type);

  if (type === 'text') {
    return asStringOrNull(block.text) ?? undefined;
  }

  if (type === 'resource_link') {
    return asStringOrNull(block.uri) ?? asStringOrNull(block.name) ?? undefined;
  }

  if (type === 'image') {
    return asStringOrNull(block.uri) ?? undefined;
  }

  if (type === 'resource') {
    const resource = asRecordOrNull(block.resource);

    return (
      asStringOrNull(resource?.uri) ??
      asStringOrNull(resource?.text) ??
      undefined
    );
  }

  return undefined;
}

export function textFromContentArray(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }

  const parts: string[] = [];

  for (const item of content) {
    const record = asRecordOrNull(item);

    if (!record) {
      continue;
    }

    const block =
      asStringOrNull(record.type) === 'content'
        ? asRecordOrNull(record.content)
        : record;

    const text = block ? textFromContentBlock(block) : undefined;

    if (text) {
      parts.push(text);
    }
  }

  return parts.join('\n');
}

const RAW_OUTPUT_STRING_FIELDS = [
  'formatted_output',
  'aggregated_output',
  'stdout',
  'stderr',
  'output',
  'text',
  'message',
] as const;

/**
 * Extract display text from a tool's raw output, which may be a string,
 * an object with well-known fields, or a content block array.
 */
export function extractOutputText(rawOutput: unknown): string | undefined {
  if (typeof rawOutput === 'string' && rawOutput.trim().length > 0) {
    return rawOutput;
  }

  const record = asRecordOrNull(rawOutput);

  if (record) {
    for (const field of RAW_OUTPUT_STRING_FIELDS) {
      const value = asStringOrNull(record[field]);

      if (value && value.trim().length > 0) {
        return value;
      }
    }
  }

  const fromContent = textFromContentArray(rawOutput);

  return fromContent.length > 0 ? fromContent : undefined;
}

// ── Tool call update sanitization ────────────────────────────────────────

/**
 * Sanitize a `tool_call_update` for presentation.
 *
 * Normalizes output from the various source fields (`rawOutput`, `content`,
 * `output`) into a single `output` string and truncates it. The original
 * `rawOutput` and `content` fields are removed to avoid sending redundant
 * (potentially huge) data over the wire.
 */
export function sanitizeAcpToolCallUpdate(
  update: Record<string, unknown>,
  options?: { maxOutputChars?: number },
): {
  update: Record<string, unknown>;
  truncation: AcpOutputTruncation | null;
} {
  const maxChars = options?.maxOutputChars ?? ACP_API_TOOL_OUTPUT_MAX_CHARS;

  const existingOutput = asStringOrNull(update.output);

  const outputText =
    (existingOutput && existingOutput.trim().length > 0
      ? existingOutput
      : undefined) ??
    extractOutputText(update.rawOutput) ??
    textFromContentArray(update.content);

  const { text: boundedOutput, truncation } = outputText
    ? truncateAcpOutputText(outputText, maxChars)
    : { text: undefined, truncation: null };

  const rawOutputRecord = asRecordOrNull(update.rawOutput);
  const rawInputRecord = asRecordOrNull(update.rawInput);

  const rawExitCode =
    asFiniteNumber(rawOutputRecord?.exitCode) ??
    asFiniteNumber(rawOutputRecord?.code);

  const rawCommand = extractCommandFromRawInput(rawInputRecord);

  // Preserve all fields except the redundant source fields.
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(update)) {
    if (key === 'rawOutput' || key === 'content' || key === 'output') {
      continue;
    }

    sanitized[key] = value;
  }

  if (boundedOutput) {
    sanitized.output = boundedOutput;
  }

  if (sanitized.exitCode === undefined && rawExitCode !== undefined) {
    sanitized.exitCode = rawExitCode;
  }

  if (sanitized.command === undefined && rawCommand) {
    sanitized.command = rawCommand;
  }

  return { update: sanitized, truncation };
}

// ── Tool result payload sanitization ─────────────────────────────────────

/**
 * Sanitize a `tool_result` payload for presentation.
 *
 * Truncates the `output` string field if it exceeds the limit.
 */
export function sanitizeAcpToolResultPayload(
  payload: Record<string, unknown>,
  options?: { maxOutputChars?: number },
): {
  payload: Record<string, unknown>;
  truncation: AcpOutputTruncation | null;
} {
  const output = asStringOrNull(payload.output);

  if (!output) {
    return { payload, truncation: null };
  }

  const { text, truncation } = truncateAcpOutputText(
    output,
    options?.maxOutputChars ?? ACP_API_TOOL_OUTPUT_MAX_CHARS,
  );

  if (!truncation) {
    return { payload, truncation: null };
  }

  return { payload: { ...payload, output: text }, truncation };
}

// ── Envelope-level sanitization ──────────────────────────────────────────

interface SanitizedEnvelopeFields {
  contentBlocks: TaskMessageContentBlock[];
  metadata: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
}

/**
 * Sanitize an envelope's mutable fields (contentBlocks, metadata, payload)
 * for a given output char limit.
 *
 * This is the single entry point used at read/emit boundaries. It inspects
 * the `eventType` to determine which sanitization strategy to apply.
 */
export function sanitizeEnvelopeFields(
  eventType: string,
  contentBlocks: TaskMessageContentBlock[],
  metadata: Record<string, unknown> | null,
  payload: Record<string, unknown> | null,
  options?: { maxOutputChars?: number },
): SanitizedEnvelopeFields {
  if (!payload) {
    return { contentBlocks, metadata, payload };
  }

  if (eventType.startsWith('roomote_runtime.output.tool_call_update.')) {
    const update = asRecordOrNull(payload.update);

    if (!update) {
      return { contentBlocks, metadata, payload };
    }

    const result = sanitizeAcpToolCallUpdate(update, options);

    return {
      contentBlocks,
      metadata: withTruncationMeta(metadata, result.truncation),
      payload: { ...payload, update: result.update },
    };
  }

  if (eventType === ACP_ENVELOPE_EVENT_TYPES.ToolResult) {
    const result = sanitizeAcpToolResultPayload(payload, options);

    if (!result.truncation) {
      return { contentBlocks, metadata, payload };
    }

    const output = asStringOrNull(result.payload.output) ?? '';

    return {
      contentBlocks:
        output.trim().length > 0
          ? [{ type: 'text', text: output }]
          : contentBlocks,
      metadata: withTruncationMeta(metadata, result.truncation),
      payload: result.payload,
    };
  }

  return { contentBlocks, metadata, payload };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function withTruncationMeta(
  metadata: Record<string, unknown> | null,
  truncation: AcpOutputTruncation | null,
): Record<string, unknown> | null {
  if (!truncation) return metadata;

  return {
    ...(metadata ?? {}),
    truncation,
  };
}
