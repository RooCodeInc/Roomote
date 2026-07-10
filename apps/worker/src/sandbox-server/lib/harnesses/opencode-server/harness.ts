import EventEmitter from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  asBoolean,
  asFiniteNumber,
  asRecord,
  asString,
  buildAcpRequestUserInputRequestId,
  formatRequestUserInputResponseText,
  parseAcpFlattenedMcpToolName,
  OPENCODE_ARCHITECT_AGENT,
  OPENCODE_BUILD_AGENT,
} from '@roomote/types';
import type {
  AcpMessage,
  AcpPersistedEnvelope,
  AcpPlanTodo,
  AcpRequestUserInputAnswers,
  AcpRequestUserInputQuestion,
  AcpRequestUserInputResponsePayload,
  AcpTurnCompletedEvent,
  TaskEvent,
} from '@roomote/types';

import type {
  AnswerUserInputRequestCommand,
  CancelTaskCommand,
  Harness,
  HarnessCommandError,
  HarnessEvents,
  HarnessInferenceUsageEvent,
  HarnessPendingUserInputRequest,
  HarnessQueuedMessage,
  QueuedPromptMessageSnapshot,
  SendMessageCommand,
  StartNewTaskCommand,
  TaskCommand,
} from '../../harness';
import {
  TaskCommandName,
  extractQueuedMessageId,
  extractQueuedMessageMove,
} from '../../harness';
import { RuntimePromptQueue } from '../runtime-prompt-queue';

import { OpenCodeRuntimeEventEmitter } from './runtime-event-emitter';
import { OpenCodeServerClient, createOpenCodePromptParts } from './client';
import {
  PLAN_WORKFLOW_SKILL,
  resolveWorkflowSkillTransition,
} from './workflow-skill-transition';
import type {
  OpenCodeEventPayload,
  OpenCodeGlobalEvent,
  OpenCodeMessageInfo,
  OpenCodePart,
  OpenCodeSessionMessage,
  OpenCodeSubtaskPart,
  OpenCodeToolPart,
} from './types';
import {
  type OpenCodeModelSelection,
  resolveOpenCodeModelSelection,
} from '../../../../run-task/opencode-model';

interface OpenCodeServerHarnessOptions {
  client: OpenCodeServerClient;
  workspacePath: string;
  logger: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
  commandEnv?: Record<string, string>;
  initialSessionId?: string;
  model?: string;
  eventStreamReadyTimeoutMs?: number;
  executeToolProgressInitialDelayMs?: number;
  executeToolProgressIntervalMs?: number;
  stopHookReminderStallTimeoutMs?: number;
  queuedPromptRetryDelayMs?: number;
  mcpServerNames?: string[];
  beforeQueuedPrompt?: (input: { userId?: string }) => Promise<void | {
    shouldReconnect: boolean;
    shouldBlockPrompt?: boolean;
    shouldSkipPrompt?: boolean;
    reason?: string;
  }>;
}

const SLACK_STOP_HOOK_PROCESS_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'NODE_OPTIONS',
  'NODE_PATH',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

export function buildOpenCodeSlackStopHookEnv(
  commandEnv: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of SLACK_STOP_HOOK_PROCESS_ENV_KEYS) {
    const value = process.env[key];

    if (value !== undefined) {
      env[key] = value;
    }
  }

  return {
    ...env,
    ...(commandEnv ?? {}),
  };
}

interface PromptInput {
  text?: string;
  images?: string[];
  workflowPhase?: string;
  visibleInTranscript?: boolean;
  source?: string;
  userId?: string;
  userName?: string;
  userImageUrl?: string;
  clientMessageId?: string;
}

interface FinalizedAssistantTurn {
  messageId: string;
  text: string;
  tokenUsage: Record<string, unknown>;
}

interface OpenCodeSlackStopHookDecision {
  blocked: boolean;
  reason?: string;
}

type AcpToolStatus = 'in_progress' | 'completed' | 'failed';
type OpenCodeRawToolStatus = NonNullable<OpenCodeToolPart['state']>['status'];

interface OpenCodeNormalizedToolPart {
  toolCallId: string;
  toolName: string;
  title: string;
  rawStatus: OpenCodeRawToolStatus;
  status: AcpToolStatus;
  contentText: string;
  callPayload: Record<string, unknown>;
  updatePayload: Record<string, unknown>;
  resultPayload: Record<string, unknown>;
  output: string;
  error: string | undefined;
}

interface OpenCodeNormalizedSubtaskPart {
  toolCallId: string;
  title: string;
  status: AcpToolStatus;
  contentText: string;
  callPayload: Record<string, unknown>;
}

interface ActiveOpenCodeExecuteToolProgress {
  sessionId: string;
  messageId?: string;
  toolCallId: string;
  toolName: string;
  title: string;
  command: string | null | undefined;
  payload: Record<string, unknown>;
  startedAtMs: number;
  timer: ReturnType<typeof setTimeout>;
}

// Tracks a live subagent spawn. Subagent runs are not time-bounded: the only
// terminal signals are the task tool part settling, the child session going
// idle (background launches), or parent-turn teardown. This tracker exists to
// route child-session events — live activity folded into the spawn row,
// inference-usage attribution, and the background idle disarm.
interface ActiveOpenCodeSubagentWatchdog {
  sessionId: string;
  /** Background launches outlive the parent turn; turn finish must not disarm them. */
  background: boolean;
  messageId: string | undefined;
  toolCallId: string;
  title: string;
  agentType: string | null;
  childSessionId: string | null;
  startedAtMs: number;
  updatePayload: Record<string, unknown>;
  activitySeenChildToolCallIds: Set<string>;
  activityLastAction: string | null;
  activityLastEmitAtMs: number;
}

const OPEN_CODE_EXECUTE_TOOLS = new Set(['bash', 'shell']);
const OPEN_CODE_READ_TOOLS = new Set(['read']);
const OPEN_CODE_SEARCH_TOOLS = new Set(['grep', 'glob', 'find', 'list', 'ls']);
const MAX_OPENCODE_STOP_HOOK_REMINDERS = 3;
// Fail-safe for a wedged stop-hook reminder cycle. After a turn finishes
// without the required Slack closeout, we resubmit a reminder prompt and then
// wait for a fresh turn (a future session.idle re-enters finishCurrentTurn).
// If OpenCode never produces that turn — the session wedged, e.g. after a mass
// subagent abort — nothing else bounds the wait and the job hangs "running"
// indefinitely while the sandbox keeps heart-beating. This deadline force-
// completes the turn so the job reaches a terminal state instead. Any normal
// turn re-entry (or teardown) clears it first via clearAllExecuteToolProgress,
// so it only ever fires on a genuine silence.
const OPENCODE_STOP_HOOK_REMINDER_STALL_TIMEOUT_MS = 10 * 60_000;
const EXPECTED_REPLAY_ABORT_SUPPRESSION_MS = 10_000;
const DEFAULT_EXECUTE_TOOL_PROGRESS_INITIAL_DELAY_MS = 15_000;
const DEFAULT_EXECUTE_TOOL_PROGRESS_INTERVAL_MS = 30_000;
const DEFAULT_QUEUED_PROMPT_RETRY_DELAY_MS = 1_000;
const MAX_PROGRESS_COMMAND_CHARS = 240;
const FALLBACK_OPENCODE_STOP_HOOK_REMINDER =
  'Before finalizing, post a terminal Slack-visible reply for the current turn.';
const ROOMOTE_OPENCODE_VISUAL_AGENT_NAME = 'visual';
// OpenCode's built-in tool for loading skills into the session.
const OPENCODE_SKILL_TOOL = 'skill';
// Hidden continuation submitted automatically after a turn that exited plan
// mode by loading a different packaged workflow skill. It drains through the
// normal prompt queue once the read-only plan-mode turn ends and submits on
// the writable `build` agent.
const PLAN_EXIT_CONTINUATION_PROMPT =
  'The read-only planning restriction has been lifted. Continue immediately with the implementation the user requested; earlier edit denials no longer apply.';
const VISUAL_ATTACHMENT_MIME_EXTENSIONS: Record<string, string> = {
  'image/gif': 'gif',
  'image/jpg': 'jpg',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
type OpenCodeMessageRole = OpenCodeMessageInfo['role'];

let lastOpenCodeMessageIdTimestamp = 0;
let openCodeMessageIdCounter = 0;

function createOpenCodeMessageId(): string {
  const currentTimestamp = Date.now();

  if (currentTimestamp !== lastOpenCodeMessageIdTimestamp) {
    lastOpenCodeMessageIdTimestamp = currentTimestamp;
    openCodeMessageIdCounter = 0;
  }

  openCodeMessageIdCounter += 1;

  let sortable = BigInt(currentTimestamp) * BigInt(0x1000);
  sortable += BigInt(openCodeMessageIdCounter);

  const timeBytes = Buffer.alloc(6);

  for (let index = 0; index < 6; index += 1) {
    timeBytes[index] = Number(
      (sortable >> BigInt(40 - 8 * index)) & BigInt(0xff),
    );
  }

  // OpenCode compares message IDs lexicographically to decide whether an
  // assistant answered after the latest user prompt.
  return `msg_${timeBytes.toString('hex')}${'0'.repeat(14)}`;
}

function visibleQueuedMessages(
  queue: QueuedPromptMessageSnapshot[],
): HarnessQueuedMessage[] {
  return queue
    .filter(
      (message) => !message.queueOnly && message.visibleInTranscript !== false,
    )
    .map((message) => ({
      id: message.id,
      text: message.text,
      ...(message.images ? { images: [...message.images] } : {}),
      ...(message.userName ? { userName: message.userName } : {}),
      ...(message.userImageUrl ? { userImageUrl: message.userImageUrl } : {}),
      ...(message.clientMessageId
        ? { clientMessageId: message.clientMessageId }
        : {}),
      timestamp: message.timestamp,
    }));
}

function hasVisualAgentConfigured(
  commandEnv: Record<string, string> | undefined,
): boolean {
  const configContent = commandEnv?.OPENCODE_CONFIG_CONTENT;

  if (!configContent) {
    return false;
  }

  try {
    const config = asRecord(JSON.parse(configContent) as unknown) ?? {};
    const agent = asRecord(config.agent) ?? {};

    return Object.prototype.hasOwnProperty.call(
      agent,
      ROOMOTE_OPENCODE_VISUAL_AGENT_NAME,
    );
  } catch {
    return false;
  }
}

function extensionForImageMime(mime: string | undefined): string {
  return VISUAL_ATTACHMENT_MIME_EXTENSIONS[mime ?? ''] ?? 'png';
}

function parseDataUrlImage(image: string):
  | {
      mime: string;
      bytes: Buffer;
    }
  | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/isu.exec(image);

  if (!match?.[1] || !match[2]) {
    return undefined;
  }

  return {
    mime: match[1].toLowerCase(),
    bytes: Buffer.from(match[2], 'base64'),
  };
}

function parseRawBase64Image(image: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(image) || image.length < 16) {
    return undefined;
  }

  return Buffer.from(image, 'base64');
}

async function materializeVisualPromptImage(input: {
  image: string;
  directory: string;
  index: number;
}): Promise<string> {
  const trimmed = input.image.trim();
  const dataUrl = parseDataUrlImage(trimmed);

  if (dataUrl) {
    if (!VISUAL_ATTACHMENT_MIME_EXTENSIONS[dataUrl.mime]) {
      throw new Error(
        `Unsupported inline image MIME for visual model handoff: ${dataUrl.mime}`,
      );
    }

    const filePath = path.join(
      input.directory,
      `image-${input.index}.${extensionForImageMime(dataUrl.mime)}`,
    );

    await fs.writeFile(filePath, dataUrl.bytes);
    return filePath;
  }

  const rawBase64 = parseRawBase64Image(trimmed);

  if (rawBase64) {
    const filePath = path.join(input.directory, `image-${input.index}.png`);

    await fs.writeFile(filePath, rawBase64);
    return filePath;
  }

  throw new Error(
    'Only inline data URL or raw base64 images can be materialized for visual model handoff.',
  );
}

interface MaterializedVisualPromptImages {
  directory: string;
  imagePaths: string[];
}

async function materializeVisualPromptImages(input: {
  images: string[];
  sessionId: string;
  messageId: string;
}): Promise<MaterializedVisualPromptImages> {
  const directory = path.join(
    os.tmpdir(),
    'roomote-opencode-visual-attachments',
    input.sessionId,
    input.messageId,
  );

  await fs.mkdir(directory, { recursive: true });

  try {
    const imagePaths = await Promise.all(
      input.images.map((image, index) =>
        materializeVisualPromptImage({
          image,
          directory,
          index: index + 1,
        }),
      ),
    );

    return { directory, imagePaths };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function withVisualDelegationReminder(
  text: string | undefined,
  imagePaths: string[],
): string {
  const trimmedText = text?.trim();
  const pathList =
    imagePaths.length > 0
      ? [
          'Pass these exact OpenCode file references in the Task prompt:',
          ...imagePaths.map((imagePath) => `- @${imagePath}`),
        ].join('\n')
      : undefined;
  const visualTarget =
    imagePaths.length > 0 ? 'image file reference(s)' : 'image attachment(s)';
  const reminder = [
    'This prompt includes image attachment(s). A hidden `visual` subagent is available for image inspection.',
    pathList,
    `Do not say you cannot view images. Use the Task tool with agent "${ROOMOTE_OPENCODE_VISUAL_AGENT_NAME}" to inspect the ${visualTarget}, extract the visual facts needed for the user request, and then continue from those observations.`,
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');

  return trimmedText ? `${trimmedText}\n\n${reminder}` : reminder;
}

function unwrapOpenCodeEvent(rawEvent: OpenCodeGlobalEvent): {
  directory?: string;
  payload: OpenCodeEventPayload;
} | null {
  if (rawEvent.payload?.type) {
    return {
      directory: rawEvent.directory,
      payload: rawEvent.payload,
    };
  }

  if (rawEvent.type) {
    return {
      directory: rawEvent.directory,
      payload: {
        type: rawEvent.type,
        properties: rawEvent.properties,
      },
    };
  }

  return null;
}

function extractPartText(part: OpenCodePart): string {
  const text = asString(asRecord(part)?.text);
  return text ?? '';
}

function extractAssistantText(message: OpenCodeSessionMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map(extractPartText)
    .filter((text) => text.length > 0)
    .join('\n');
}

function extractAssistantReasoning(message: OpenCodeSessionMessage): string {
  return message.parts
    .filter((part) => part.type === 'reasoning')
    .map(extractPartText)
    .filter((text) => text.length > 0)
    .join('\n');
}

function parseOpenCodeMessageRole(value: unknown): OpenCodeMessageRole | null {
  return value === 'user' || value === 'assistant' ? value : null;
}

function extractOpenCodeMessageRoleFromRecord(
  source: unknown,
  messageId: string | undefined,
): OpenCodeMessageRole | null {
  const record = asRecord(source);

  if (!record) {
    return null;
  }

  const info = asRecord(record.info) ?? record;
  const role = parseOpenCodeMessageRole(info.role);

  if (!role) {
    return null;
  }

  const infoId = asString(info.id);

  if (messageId && infoId && infoId !== messageId) {
    return null;
  }

  return role;
}

function extractOpenCodePartMessageRole(
  properties: Record<string, unknown> | null | undefined,
  part: OpenCodePart,
  messageId: string | undefined,
): OpenCodeMessageRole | null {
  return (
    extractOpenCodeMessageRoleFromRecord(part, messageId) ??
    extractOpenCodeMessageRoleFromRecord(properties?.info, messageId) ??
    extractOpenCodeMessageRoleFromRecord(properties?.message, messageId) ??
    extractOpenCodeMessageRoleFromRecord(properties?.messageInfo, messageId) ??
    extractOpenCodeMessageRoleFromRecord(properties, messageId)
  );
}

function openCodeTimestampToDate(value: unknown): Date | undefined {
  const timestamp = asFiniteNumber(value);

  if (timestamp === undefined) {
    return undefined;
  }

  const date = new Date(timestamp);

  return Number.isNaN(date.getTime()) ? undefined : date;
}

function asFiniteDecimal(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function createTokenUsage(info: OpenCodeMessageInfo): Record<string, unknown> {
  const inputTokens = asFiniteNumber(info.tokens?.input) ?? 0;
  const outputTokens = asFiniteNumber(info.tokens?.output) ?? 0;
  const reasoningTokens = asFiniteNumber(info.tokens?.reasoning) ?? 0;
  const cachedInputTokens = asFiniteNumber(info.tokens?.cache?.read) ?? 0;
  const cacheWriteTokens = asFiniteNumber(info.tokens?.cache?.write) ?? 0;
  const costUsd = asFiniteDecimal(info.cost);
  const costMicroUsd =
    costUsd === undefined ? 0 : Math.max(0, Math.round(costUsd * 1_000_000));

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedInputTokens,
    cacheWriteTokens,
    totalTokens:
      inputTokens +
      outputTokens +
      reasoningTokens +
      cachedInputTokens +
      cacheWriteTokens,
    contextTokens: inputTokens + cachedInputTokens,
    costUsd: costUsd ?? 0,
    costMicroUsd,
    costSource: costUsd === undefined ? 'missing' : 'opencode_message',
    providerId: info.providerID,
    modelId: info.modelID,
  };
}

function extractOpenCodeMessageAgent(
  info: OpenCodeMessageInfo,
): string | undefined {
  const agent = asString(info.agent) ?? asString(info.mode);
  const trimmed = agent?.trim();

  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function createInferenceUsageEvent(
  info: OpenCodeMessageInfo,
  tokenUsage: Record<string, unknown>,
  fallbackAgent?: string,
): HarnessInferenceUsageEvent {
  const messageCreatedAt = openCodeTimestampToDate(info.time?.created);
  const messageCompletedAt = openCodeTimestampToDate(info.time?.completed);
  const agent = extractOpenCodeMessageAgent(info) ?? fallbackAgent;

  return {
    sessionId: info.sessionID,
    messageId: info.id,
    ...(typeof info.providerID === 'string'
      ? { providerId: info.providerID }
      : {}),
    ...(typeof info.modelID === 'string' ? { modelId: info.modelID } : {}),
    ...(agent ? { agent } : {}),
    inputTokens: Number(tokenUsage.inputTokens ?? 0),
    outputTokens: Number(tokenUsage.outputTokens ?? 0),
    reasoningTokens: Number(tokenUsage.reasoningTokens ?? 0),
    cacheReadTokens: Number(tokenUsage.cachedInputTokens ?? 0),
    cacheWriteTokens: Number(tokenUsage.cacheWriteTokens ?? 0),
    totalTokens: Number(tokenUsage.totalTokens ?? 0),
    contextTokens: Number(tokenUsage.contextTokens ?? 0),
    costMicroUsd: Number(tokenUsage.costMicroUsd ?? 0),
    costSource:
      tokenUsage.costSource === 'opencode_message'
        ? 'opencode_message'
        : 'missing',
    ...(messageCreatedAt ? { messageCreatedAt } : {}),
    ...(messageCompletedAt ? { messageCompletedAt } : {}),
  };
}

function normalizePathForCompare(value: string): string {
  return path.resolve(value);
}

function eventSessionId(payload: OpenCodeEventPayload): string | undefined {
  const properties = asRecord(payload.properties);
  return (
    asString(properties?.sessionID) ??
    asString(properties?.sessionId) ??
    asString(asRecord(properties?.info)?.sessionID) ??
    asString(asRecord(properties?.part)?.sessionID)
  );
}

function stringifyOpenCodeValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (value === undefined || value === null) {
    return undefined;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = asString(value);

    if (text && text.length > 0) {
      return text;
    }
  }

  return null;
}

function optionalRecordEntries(
  key: string,
  value: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return value && Object.keys(value).length > 0 ? { [key]: value } : {};
}

function extractOpenCodeCommand(
  input: Record<string, unknown> | undefined,
  metadata: Record<string, unknown>,
): string | null {
  return firstString(
    input?.command,
    input?.cmd,
    input?.script,
    metadata.command,
    metadata.cmd,
    metadata.script,
  );
}

function extractOpenCodeExitCode(
  output: unknown,
  metadata: Record<string, unknown>,
): number | null {
  const outputRecord = asRecord(output);

  return (
    asFiniteNumber(metadata.exitCode) ??
    asFiniteNumber(metadata.code) ??
    asFiniteNumber(outputRecord?.exitCode) ??
    asFiniteNumber(outputRecord?.code) ??
    null
  );
}

function extractOpenCodeMcpInvocation(
  toolName: string,
  metadata: Record<string, unknown>,
  knownMcpServerNames: readonly string[] = [],
): {
  isMcp: boolean;
  mcpServerName: string | null;
  mcpToolName: string | null;
} {
  const metadataServerName = firstString(
    metadata.mcpServerName,
    metadata.serverName,
    metadata.server,
    metadata.mcpServer,
  );
  const metadataToolName = firstString(
    metadata.mcpToolName,
    metadata.toolName,
    metadata.tool,
    metadata.mcpTool,
  );

  if (metadataServerName || metadataToolName) {
    return {
      isMcp: true,
      mcpServerName: metadataServerName,
      mcpToolName: metadataToolName,
    };
  }

  const mcpPrefixName = toolName.startsWith('mcp:')
    ? toolName.slice('mcp:'.length)
    : toolName;
  const slashIndex = mcpPrefixName.indexOf('/');

  if (slashIndex > 0 && slashIndex < mcpPrefixName.length - 1) {
    return {
      isMcp: true,
      mcpServerName: mcpPrefixName.slice(0, slashIndex),
      mcpToolName: mcpPrefixName.slice(slashIndex + 1),
    };
  }

  const doubleUnderscoreMatch = /^mcp__(.+)__([^_].*)$/.exec(toolName);

  if (doubleUnderscoreMatch) {
    return {
      isMcp: true,
      mcpServerName: doubleUnderscoreMatch[1] ?? null,
      mcpToolName: doubleUnderscoreMatch[2] ?? null,
    };
  }

  const flattenedInvocation = parseAcpFlattenedMcpToolName(
    toolName,
    knownMcpServerNames,
  );

  if (flattenedInvocation) {
    return {
      isMcp: true,
      mcpServerName: flattenedInvocation.mcpServerName,
      mcpToolName: flattenedInvocation.mcpToolName,
    };
  }

  return {
    isMcp: false,
    mcpServerName: null,
    mcpToolName: null,
  };
}

function isOpenCodeQuestionTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase();

  return (
    normalized === 'question' ||
    normalized.endsWith('/question') ||
    normalized.endsWith('.question') ||
    normalized.endsWith('__question')
  );
}

function normalizeQuestionOptions(
  value: unknown,
): AcpRequestUserInputQuestion['options'] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((option) => {
    const record = asRecord(option);
    const label = asString(record?.label) ?? asString(record?.value);

    if (!label) {
      return [];
    }

    return [
      {
        label,
        description: asString(record?.description) ?? '',
      },
    ];
  });
}

function normalizeOpenCodeQuestion(
  value: unknown,
  index: number,
): AcpRequestUserInputQuestion | null {
  const record = asRecord(value);

  if (!record) {
    const text = asString(value);

    if (!text) {
      return null;
    }

    return {
      id: `question-${index + 1}`,
      header: `Question ${index + 1}`,
      question: text,
      isOther: true,
      isSecret: false,
      options: [],
    };
  }

  const question =
    asString(record.question) ??
    asString(record.prompt) ??
    asString(record.message) ??
    asString(record.description);

  if (!question) {
    return null;
  }

  const id =
    asString(record.id) ??
    asString(record.name) ??
    asString(record.key) ??
    `question-${index + 1}`;

  return {
    id,
    header:
      asString(record.header) ??
      asString(record.title) ??
      asString(record.label) ??
      id,
    question,
    // OpenCode's question schema calls this `custom` and defaults it to true
    // ("Allow typing a custom answer"); the question tool's parameters cannot
    // even disable it. Default to allowing free-form answers so Slack and
    // other surfaces match OpenCode's native behavior.
    isOther:
      asBoolean(record.isOther) ??
      asBoolean(record.other) ??
      asBoolean(record.custom) ??
      true,
    isSecret: asBoolean(record.isSecret) ?? asBoolean(record.secret) ?? false,
    options: normalizeQuestionOptions(record.options),
  };
}

function extractOpenCodeQuestionToolRequest(
  toolPart: OpenCodeToolPart,
  context: {
    sessionId: string;
    messageId?: string;
    partId: string;
  },
): Omit<HarnessPendingUserInputRequest, 'ts'> | null {
  if (!isOpenCodeQuestionTool(toolPart.tool ?? '')) {
    return null;
  }

  const input = asRecord(toolPart.state?.input) ?? {};
  const rawQuestions = Array.isArray(input.questions)
    ? input.questions
    : Array.isArray(input.prompts)
      ? input.prompts
      : null;
  const questions = (
    rawQuestions ?? [
      {
        id: 'response',
        header: asString(input.header) ?? asString(input.title) ?? 'Response',
        question:
          asString(input.question) ??
          asString(input.prompt) ??
          asString(input.message) ??
          asString(toolPart.state?.title) ??
          'Provide the requested input.',
        isOther: true,
        isSecret: asBoolean(input.isSecret) ?? asBoolean(input.secret) ?? false,
      },
    ]
  )
    .map(normalizeOpenCodeQuestion)
    .filter(
      (question): question is AcpRequestUserInputQuestion => question !== null,
    );

  if (questions.length === 0) {
    return null;
  }

  const turnId = context.messageId ?? 'message';
  const callId = toolPart.callID ?? context.partId;

  return {
    requestId: buildAcpRequestUserInputRequestId({
      sessionId: context.sessionId,
      turnId,
      callId,
    }),
    sessionId: context.sessionId,
    turnId,
    callId,
    questions,
    status: 'pending',
  };
}

function areOpenCodeQuestionRequestsEqual(
  left: Omit<HarnessPendingUserInputRequest, 'ts'>,
  right: Omit<HarnessPendingUserInputRequest, 'ts'>,
): boolean {
  return (
    left.requestId === right.requestId &&
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.callId === right.callId &&
    left.status === right.status &&
    JSON.stringify(left.questions) === JSON.stringify(right.questions)
  );
}

function getRequestUserInputResponseResolution(
  answers: AcpRequestUserInputAnswers,
): AcpRequestUserInputResponsePayload['resolution'] {
  return Object.values(answers).some((answerGroup) =>
    answerGroup.answers.some((answer) => answer.trim().length > 0),
  )
    ? 'submitted'
    : 'cancelled';
}

function isOpenCodeMessageAbortedError(error: unknown): boolean {
  const record = asRecord(error);
  const name = asString(record?.name);
  const message =
    asString(record?.message) ?? asString(asRecord(record?.data)?.message);

  return name === 'MessageAbortedError' || message === 'Aborted';
}

const SESSION_ERROR_FALLBACK_MAX_CHARS = 600;

const MAX_RESOLVED_USER_INPUT_REQUEST_IDS = 256;

/**
 * Session errors used to be dumped into the transcript as the raw
 * `JSON.stringify(error)` blob (status codes, response headers, provider
 * metadata). Surface the human-readable provider message instead; the full
 * payload still goes to the harness log for debugging.
 */
function formatOpenCodeSessionErrorText(error: unknown): string {
  const record = asRecord(error);
  const name = asString(record?.name);
  const message =
    asString(asRecord(record?.data)?.message) ?? asString(record?.message);

  if (message) {
    return name && name !== 'APIError'
      ? `The provider returned an error (${name}): ${message}`
      : `The provider returned an error: ${message}`;
  }

  if (name) {
    return `The session ended with an error: ${name}`;
  }

  const serialized = JSON.stringify(error ?? {});

  return `The session ended with an error: ${
    serialized.length > SESSION_ERROR_FALLBACK_MAX_CHARS
      ? `${serialized.slice(0, SESSION_ERROR_FALLBACK_MAX_CHARS)}…`
      : serialized
  }`;
}

function formatOpenCodeUserInputResponsePrompt(options: {
  request: HarnessPendingUserInputRequest;
  answers: AcpRequestUserInputAnswers;
  resolution: AcpRequestUserInputResponsePayload['resolution'];
}): string {
  return [
    `The user responded to structured input request ${options.request.requestId}. Continue using these answers:`,
    formatRequestUserInputResponseText(options.request, {
      resolution: options.resolution,
      answers: options.answers,
    }),
  ].join('\n\n');
}

function normalizeOpenCodeToolStatus(
  status: string | undefined,
): AcpToolStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'error':
    case 'failed':
    case 'cancelled':
    case 'canceled':
      return 'failed';
    default:
      return 'in_progress';
  }
}

function parseOpenCodeTodoStatus(status: unknown): AcpPlanTodo['status'] {
  const value = asString(status)?.toLowerCase();

  if (
    value === 'in_progress' ||
    value === 'in-progress' ||
    value === 'running'
  ) {
    return 'in_progress';
  }

  if (value === 'completed' || value === 'complete' || value === 'done') {
    return 'completed';
  }

  return 'pending';
}

function parseOpenCodeTodoEntries(value: unknown): AcpPlanTodo[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const entries = value
    .map((entry, index) => {
      const record = asRecord(entry);

      if (!record) {
        return null;
      }

      const content =
        asString(record.content) ??
        asString(record.text) ??
        asString(record.title);

      if (!content) {
        return null;
      }

      const priority = asString(record.priority);

      return {
        id: asString(record.id) ?? String(index + 1),
        content,
        status: parseOpenCodeTodoStatus(record.status),
        ...(priority ? { priority } : {}),
      } satisfies AcpPlanTodo;
    })
    .filter((entry): entry is AcpPlanTodo => entry !== null);

  return value.length === 0 || entries.length > 0 ? entries : null;
}

function parseOpenCodeJsonValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractOpenCodeTodoEntries(
  tool: OpenCodeNormalizedToolPart,
): AcpPlanTodo[] | null {
  const rawInput = asRecord(tool.callPayload.rawInput);
  const rawInputEntries = parseOpenCodeTodoEntries(rawInput?.todos);

  if (rawInputEntries) {
    return rawInputEntries;
  }

  if (tool.output.trim().length === 0) {
    return null;
  }

  const parsedOutput = parseOpenCodeJsonValue(tool.output);
  const parsedOutputEntries =
    parseOpenCodeTodoEntries(parsedOutput) ??
    parseOpenCodeTodoEntries(asRecord(parsedOutput)?.todos);

  return parsedOutputEntries;
}

function isOpenCodeTodoWriteTool(toolName: string): boolean {
  return toolName.toLowerCase() === 'todowrite';
}

// Real OpenCode subagent spawns surface on the parent session as a `task`
// tool part whose state carries input.subagent_type and, once the child
// session exists, metadata.sessionId pointing at it. (`subtask` parts are a
// separate command-driven surface that never reports a status.)
const OPEN_CODE_SUBAGENT_TASK_TOOL_NAME = 'task';

const SUBAGENT_ACTIVITY_EMIT_INTERVAL_MS = 5_000;

function isOpenCodeSubagentTaskTool(toolName: string): boolean {
  return toolName.toLowerCase() === OPEN_CODE_SUBAGENT_TASK_TOOL_NAME;
}

function extractOpenCodeTaskToolChildSessionId(
  toolPart: OpenCodeToolPart,
): string | null {
  const metadata = asRecord(toolPart.state?.metadata);

  // Background task launches report the child session id as `jobId`.
  return asString(metadata?.sessionId) ?? asString(metadata?.jobId) ?? null;
}

function isOpenCodeBackgroundTaskToolPart(toolPart: OpenCodeToolPart): boolean {
  return (
    asBoolean(asRecord(toolPart.state?.input)?.background) === true ||
    asBoolean(asRecord(toolPart.state?.metadata)?.background) === true
  );
}

function extractOpenCodeTaskToolAgentType(
  toolPart: OpenCodeToolPart,
): string | null {
  return asString(asRecord(toolPart.state?.input)?.subagent_type) ?? null;
}

function isTerminalOpenCodeToolStatus(status: AcpToolStatus): boolean {
  return status === 'completed' || status === 'failed';
}

function truncateProgressCommand(command: string): string {
  if (command.length <= MAX_PROGRESS_COMMAND_CHARS) {
    return command;
  }

  return `${command.slice(0, MAX_PROGRESS_COMMAND_CHARS - 3)}...`;
}

function formatProgressElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(1, Math.round(elapsedMs / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatExecuteToolProgressOutput(
  progress: ActiveOpenCodeExecuteToolProgress,
  nowMs: number,
): string {
  const lines = [
    `Command still running for about ${formatProgressElapsed(
      nowMs - progress.startedAtMs,
    )}.`,
  ];

  if (progress.command) {
    lines.push(`Command: ${truncateProgressCommand(progress.command)}`);
  }

  lines.push('No command output has been reported yet.');

  return lines.join('\n');
}

function hasMeaningfulOpenCodeToolCallDetails(
  tool: OpenCodeNormalizedToolPart,
): boolean {
  const rawInput = asRecord(tool.callPayload.rawInput);
  const isGenericTitle =
    tool.title === tool.toolName && tool.contentText === tool.toolName;

  return (
    isTerminalOpenCodeToolStatus(tool.status) ||
    Boolean(rawInput && Object.keys(rawInput).length > 0) ||
    !isGenericTitle ||
    tool.callPayload.isMcp === true
  );
}

function buildOpenCodeToolEventKey(input: {
  sessionId: string;
  messageId?: string;
  toolCallId: string;
}): string {
  return `${input.sessionId}:${input.messageId ?? 'message'}:${input.toolCallId}`;
}

function normalizeOpenCodeToolPart(
  toolPart: OpenCodeToolPart,
  context: {
    sessionId: string;
    messageId?: string;
    partId: string;
  },
  knownMcpServerNames: readonly string[] = [],
): OpenCodeNormalizedToolPart {
  const state = toolPart.state;
  const toolName = toolPart.tool ?? 'tool';
  const toolCallId = toolPart.callID ?? context.partId;
  const input = state?.input;
  const metadata = {
    ...(asRecord(toolPart.metadata) ?? {}),
    ...(state?.metadata ?? {}),
  };
  const command = extractOpenCodeCommand(input, metadata);
  const mcpInvocation = extractOpenCodeMcpInvocation(
    toolName,
    metadata,
    knownMcpServerNames,
  );
  const normalizedToolName = toolName.toLowerCase();
  const isExecute =
    !mcpInvocation.isMcp && OPEN_CODE_EXECUTE_TOOLS.has(normalizedToolName);
  const isRead =
    !mcpInvocation.isMcp && OPEN_CODE_READ_TOOLS.has(normalizedToolName);
  const isSearch =
    !mcpInvocation.isMcp && OPEN_CODE_SEARCH_TOOLS.has(normalizedToolName);
  const isSubagentSpawn =
    !mcpInvocation.isMcp && isOpenCodeSubagentTaskTool(normalizedToolName);
  const kind = mcpInvocation.isMcp
    ? 'mcp'
    : isSubagentSpawn
      ? 'subagent'
      : isExecute
        ? 'execute'
        : isRead
          ? 'read'
          : isSearch
            ? 'search'
            : toolName;
  const title =
    state?.title ??
    (isExecute && command
      ? command
      : mcpInvocation.isMcp
        ? [mcpInvocation.mcpServerName, mcpInvocation.mcpToolName ?? toolName]
            .filter((part): part is string => Boolean(part))
            .join('/')
        : toolName);
  const rawStatus = state?.status;
  const status = normalizeOpenCodeToolStatus(rawStatus);
  const output = stringifyOpenCodeValue(state?.output) ?? '';
  const error = stringifyOpenCodeValue(state?.error);
  const exitCode = extractOpenCodeExitCode(state?.output, metadata);
  const basePayload = {
    sessionId: context.sessionId,
    ...(context.messageId ? { turnId: context.messageId } : {}),
    toolCallId,
    kind,
    title,
    status,
    isExecute,
    isRead,
    isMcp: mcpInvocation.isMcp,
    mcpServerName: mcpInvocation.mcpServerName,
    mcpToolName: mcpInvocation.mcpToolName,
    command,
    ...(isSubagentSpawn
      ? {
          isSubagentSpawn: true,
          agentType: asString(asRecord(input)?.subagent_type) ?? null,
        }
      : {}),
    ...(mcpInvocation.isMcp
      ? {
          serverName: mcpInvocation.mcpServerName,
          toolName: mcpInvocation.mcpToolName,
        }
      : {}),
    ...(knownMcpServerNames.length > 0
      ? { flattenedServerNames: [...knownMcpServerNames] }
      : {}),
    ...optionalRecordEntries('rawInput', input),
  };
  const updatePayload = {
    ...basePayload,
    exitCode,
    ...(output.length > 0 ? { output } : {}),
    ...(error ? { error } : {}),
  };
  const resultOutput = output.length > 0 ? output : (error ?? '');

  return {
    toolCallId,
    toolName,
    title,
    rawStatus,
    status,
    contentText: command ?? title,
    callPayload: basePayload,
    updatePayload,
    resultPayload: {
      ...basePayload,
      exitCode,
      output: resultOutput,
    },
    output: resultOutput,
    error,
  };
}

function normalizeOpenCodeSubtaskPart(
  subtaskPart: OpenCodeSubtaskPart,
  context: {
    sessionId: string;
    messageId?: string;
    partId: string;
  },
): OpenCodeNormalizedSubtaskPart {
  const title =
    subtaskPart.description.length > 0
      ? subtaskPart.description
      : `${subtaskPart.agent} subtask`;
  const model = subtaskPart.model
    ? `${subtaskPart.model.providerID}/${subtaskPart.model.modelID}`
    : null;
  const rawInput = {
    prompt: subtaskPart.prompt,
    description: subtaskPart.description,
    agent: subtaskPart.agent,
    ...(subtaskPart.command ? { command: subtaskPart.command } : {}),
    ...(subtaskPart.model ? { model: subtaskPart.model } : {}),
  };

  return {
    toolCallId: context.partId,
    title,
    status: 'in_progress',
    contentText: title,
    callPayload: {
      sessionId: context.sessionId,
      ...(context.messageId ? { turnId: context.messageId } : {}),
      toolCallId: context.partId,
      kind: 'subagent',
      title,
      status: 'in_progress',
      isExecute: false,
      isRead: false,
      isMcp: false,
      mcpServerName: null,
      mcpToolName: null,
      command: null,
      isSubagentSpawn: true,
      senderThreadId: null,
      receiverThreadIds: null,
      agentsStates: null,
      prompt: subtaskPart.prompt,
      agentType: subtaskPart.agent,
      model,
      reasoningEffort: null,
      rawInput,
    },
  };
}

export class OpenCodeServerHarness
  extends EventEmitter<HarnessEvents>
  implements Harness
{
  private readonly client: OpenCodeServerClient;
  private readonly workspacePath: string;
  private readonly normalizedWorkspacePath: string;
  private readonly logger: OpenCodeServerHarnessOptions['logger'];
  private readonly model: OpenCodeModelSelection | undefined;
  private readonly beforeQueuedPrompt:
    | OpenCodeServerHarnessOptions['beforeQueuedPrompt']
    | undefined;
  private readonly eventAbortController = new AbortController();
  private readonly runtimeEvents: OpenCodeRuntimeEventEmitter;
  private readonly prompts: RuntimePromptQueue;
  private readonly eventStreamReadyTimeoutMs: number;
  private readonly executeToolProgressInitialDelayMs: number;
  private readonly executeToolProgressIntervalMs: number;
  private readonly stopHookReminderStallTimeoutMs: number;
  private readonly queuedPromptRetryDelayMs: number;
  private readonly streamedPartText = new Map<string, string>();
  private readonly streamedMessageIds = new Set<string>();
  private readonly streamedReasoningMessageIds = new Set<string>();
  private readonly persistedMessageIds = new Set<string>();
  private readonly recordedChildUsageMessageIds = new Set<string>();
  private readonly emittedToolCallKeys = new Set<string>();
  private readonly persistedToolResultKeys = new Set<string>();
  private readonly activeExecuteToolProgress = new Map<
    string,
    ActiveOpenCodeExecuteToolProgress
  >();
  private readonly childSessionWatchdogKeys = new Map<string, string>();

  private readonly activeSubagentWatchdogs = new Map<
    string,
    ActiveOpenCodeSubagentWatchdog
  >();
  private readonly emittedTodoPlanKeys = new Set<string>();
  private readonly submittedUserMessageIds = new Set<string>();
  private readonly messageRoleById = new Map<string, OpenCodeMessageRole>();
  private readonly pendingUserInputRequests = new Map<
    string,
    HarnessPendingUserInputRequest
  >();
  // Request ids that have already been answered or abandoned. A late answer
  // (e.g. a web POST opened before a steer abandoned the question) for one
  // of these must be rejected rather than fabricated into the replayed turn.
  // Bounded, oldest-evicted, since ids are per-turn and only need to outlive
  // in-flight answer round-trips.
  private readonly resolvedUserInputRequestIds = new Set<string>();
  private readonly knownMcpServerNames: string[];
  private readonly visualAttachmentDirectories = new Set<string>();

  private connected = false;
  private disposed = false;
  private sessionId: string | undefined;
  private resumedSessionPendingValidation = false;
  private inFlight = false;
  private queuedPromptRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private currentWorkflowPhase: string | null = null;
  // Most recent packaged workflow skill loaded by the primary session's agent
  // via the OpenCode skill tool. Drives per-prompt agent selection so plan-mode
  // turns can run on the built-in read-only `plan` agent.
  private activeWorkflowSkill: string | null = null;
  private commandEnv: Record<string, string> | undefined;
  private stopHookReminderCount = 0;
  private stopHookReminderStallTimer: ReturnType<typeof setTimeout> | null =
    null;
  private resolveEventStreamReady: (() => void) | undefined;
  private rejectEventStreamReady: ((error: unknown) => void) | undefined;
  private finalizedAssistantTurn: FinalizedAssistantTurn | null = null;
  private suppressNextReplayAbortError = false;
  private replayAbortErrorSuppressionTimeout:
    | ReturnType<typeof setTimeout>
    | undefined;
  // After a cancel, OpenCode still finalizes the aborted assistant message
  // and stray part events can trail in; the partial output is flushed at
  // cancel time instead, and everything after is dropped so nothing lands
  // below the cancel point. Cleared when the next prompt goes out.
  private suppressAssistantOutputUntilNextPrompt = false;

  constructor(options: OpenCodeServerHarnessOptions) {
    super();
    this.client = options.client;
    this.workspacePath = options.workspacePath;
    this.normalizedWorkspacePath = normalizePathForCompare(
      options.workspacePath,
    );
    this.logger = options.logger;
    this.sessionId = options.initialSessionId;
    // An id supplied at construction is a resumed session too — validate it on
    // first use rather than trusting it blindly.
    this.resumedSessionPendingValidation =
      options.initialSessionId !== undefined;
    this.model = options.model
      ? resolveOpenCodeModelSelection(options.model)
      : undefined;
    this.commandEnv = options.commandEnv
      ? { ...options.commandEnv }
      : undefined;
    this.eventStreamReadyTimeoutMs = options.eventStreamReadyTimeoutMs ?? 5_000;
    this.executeToolProgressInitialDelayMs =
      options.executeToolProgressInitialDelayMs ??
      DEFAULT_EXECUTE_TOOL_PROGRESS_INITIAL_DELAY_MS;
    this.executeToolProgressIntervalMs =
      options.executeToolProgressIntervalMs ??
      DEFAULT_EXECUTE_TOOL_PROGRESS_INTERVAL_MS;
    this.stopHookReminderStallTimeoutMs =
      options.stopHookReminderStallTimeoutMs ??
      OPENCODE_STOP_HOOK_REMINDER_STALL_TIMEOUT_MS;
    this.queuedPromptRetryDelayMs =
      options.queuedPromptRetryDelayMs ?? DEFAULT_QUEUED_PROMPT_RETRY_DELAY_MS;
    this.knownMcpServerNames = [
      ...new Set(
        (options.mcpServerNames ?? [])
          .map((serverName) => serverName.trim())
          .filter((serverName) => serverName.length > 0),
      ),
    ].sort((left, right) => right.length - left.length);
    this.beforeQueuedPrompt = options.beforeQueuedPrompt;
    this.runtimeEvents = new OpenCodeRuntimeEventEmitter({
      taskEvent: (event) => this.emit('taskEvent', event),
      runtimeOutput: (event) => this.emit('runtimeOutput', event),
      runtimePersistedEnvelope: (envelope) =>
        this.emit('runtimePersistedEnvelope', envelope),
      runtimeTurnCompleted: (event) => this.emit('runtimeTurnCompleted', event),
    });
    this.prompts = new RuntimePromptQueue({
      getSessionId: () => this.sessionId,
      getNextSequence: () => this.runtimeEvents.nextTs(),
      emitRuntimeOutput: (event) => this.emit('runtimeOutput', event),
    });
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    await this.client.health(this.eventAbortController.signal);
    const eventStreamReady = this.waitForEventStreamReady();
    this.startEventStream();
    await eventStreamReady;
    this.connected = true;
    this.emit('connected');
  }

  subscribe(listener: (event: TaskEvent) => void): () => void {
    this.on('taskEvent', listener);
    return () => this.off('taskEvent', listener);
  }

  subscribeRuntimeOutput(listener: (event: AcpMessage) => void): () => void {
    this.on('runtimeOutput', listener);
    return () => this.off('runtimeOutput', listener);
  }

  subscribeRuntimePersistedEnvelope(
    listener: (envelope: AcpPersistedEnvelope) => void,
  ): () => void {
    this.on('runtimePersistedEnvelope', listener);
    return () => this.off('runtimePersistedEnvelope', listener);
  }

  subscribeRuntimeTurnCompleted(
    listener: (event: AcpTurnCompletedEvent) => void,
  ): () => void {
    this.on('runtimeTurnCompleted', listener);
    return () => this.off('runtimeTurnCompleted', listener);
  }

  subscribeRuntimeInferenceUsage(
    listener: (event: HarnessInferenceUsageEvent) => void,
  ): () => void {
    this.on('runtimeInferenceUsage', listener);
    return () => this.off('runtimeInferenceUsage', listener);
  }

  subscribeCommandError(
    listener: (error: HarnessCommandError) => void,
  ): () => void {
    this.on('commandError', listener);
    return () => this.off('commandError', listener);
  }

  sendCommand(command: TaskCommand): boolean {
    if (this.disposed || !this.connected) {
      return false;
    }

    void this.handleCommand(command).catch((error: unknown) => {
      this.logger.error(
        `OpenCode command failed command=${command.commandName} error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.emit('commandError', { command, error });
    });
    return true;
  }

  get isConnected(): boolean {
    return this.connected && !this.disposed;
  }

  get supportsNativeTurnSteering(): boolean {
    // OpenCode steers an active turn via abort-and-replay
    // (interruptForQueuedReplay), which suppresses the resulting
    // MessageAbortedError instead of surfacing a terminal abort. Advertising
    // native turn steering routes steers through that suppressed path; leaving
    // it false makes steerTask fall back to cancelTaskAndWaitForTurnExit, which
    // unconditionally emits TaskAborted and leaks the abort error into the
    // transcript.
    return true;
  }

  getQueuedMessages(): HarnessQueuedMessage[] {
    return visibleQueuedMessages(this.prompts.snapshot());
  }

  getPendingUserInputRequests(): HarnessPendingUserInputRequest[] {
    return [...this.pendingUserInputRequests.values()];
  }

  getQueuedMessageSnapshots(): QueuedPromptMessageSnapshot[] {
    return this.prompts.snapshot().map((message) => ({
      ...message,
      ...(message.images ? { images: [...message.images] } : {}),
    }));
  }

  getCurrentWorkflowPhase(): string | null {
    return this.currentWorkflowPhase;
  }

  setCommandEnv(env: Record<string, string>): void {
    this.commandEnv = { ...env };
  }

  getCommandEnv(): Record<string, string> {
    return { ...(this.commandEnv ?? {}) };
  }

  dispose(): void {
    this.disposed = true;
    this.connected = false;
    this.clearReplayAbortErrorSuppression();
    this.clearQueuedPromptRetryTimer();
    this.clearAllExecuteToolProgress();
    void this.cleanupVisualAttachmentDirectories();
    this.rejectEventStreamReady?.(
      new Error('OpenCode harness disposed before event stream connected.'),
    );
    this.eventAbortController.abort();
    this.emit('disconnected');
  }

  private async cleanupVisualAttachmentDirectories(): Promise<void> {
    const directories = [...this.visualAttachmentDirectories];
    this.visualAttachmentDirectories.clear();

    await Promise.all(
      directories.map(async (directory) => {
        try {
          await fs.rm(directory, { recursive: true, force: true });
        } catch (error) {
          this.logger.warn(
            `Failed to clean up OpenCode visual prompt attachments directory ${directory}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }),
    );
  }

  private evaluateSlackStopHook(
    sessionId: string,
  ): OpenCodeSlackStopHookDecision {
    const stateFilePath =
      this.commandEnv?.ROOMOTE_SLACK_REPLY_SATISFACTION_STATE_FILE;
    const stopHookScriptPath =
      this.commandEnv?.ROOMOTE_OPENCODE_SLACK_STOP_HOOK_SCRIPT;

    if (!stateFilePath || !stopHookScriptPath) {
      return { blocked: false };
    }

    const result = spawnSync(process.execPath, [stopHookScriptPath], {
      encoding: 'utf8',
      input: JSON.stringify({ threadId: sessionId }),
      env: buildOpenCodeSlackStopHookEnv(this.commandEnv),
    });

    if (result.error) {
      this.logger.error(
        `OpenCode Slack stop hook failed error=${result.error.message}`,
      );
      return {
        blocked: true,
        reason: FALLBACK_OPENCODE_STOP_HOOK_REMINDER,
      };
    }

    if (result.status !== 0) {
      this.logger.error(
        `OpenCode Slack stop hook exited status=${result.status} stderr=${result.stderr}`,
      );
      return {
        blocked: true,
        reason: FALLBACK_OPENCODE_STOP_HOOK_REMINDER,
      };
    }

    const stdout = result.stdout.trim();

    if (stdout.length === 0) {
      return { blocked: false };
    }

    let payload: Record<string, unknown> | undefined;

    try {
      payload = asRecord(JSON.parse(stdout));
    } catch {
      this.logger.error(
        `OpenCode Slack stop hook returned invalid JSON stdout=${stdout}`,
      );
      return {
        blocked: true,
        reason: FALLBACK_OPENCODE_STOP_HOOK_REMINDER,
      };
    }

    if (!payload) {
      return { blocked: false };
    }

    const blocked =
      payload?.decision === 'block' ||
      payload?.continue === false ||
      typeof payload?.stopReason === 'string';

    if (!blocked) {
      return { blocked: false };
    }

    return {
      blocked: true,
      reason:
        asString(payload.reason) ??
        asString(payload.stopReason) ??
        asString(asRecord(payload.hookSpecificOutput)?.additionalContext) ??
        FALLBACK_OPENCODE_STOP_HOOK_REMINDER,
    };
  }

  private waitForEventStreamReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const finish = (error?: unknown) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        this.eventAbortController.signal.removeEventListener(
          'abort',
          handleAbort,
        );
        this.resolveEventStreamReady = undefined;
        this.rejectEventStreamReady = undefined;

        if (error) {
          reject(error);
          return;
        }

        resolve();
      };

      const handleAbort = () => {
        finish(
          new Error(
            'OpenCode event stream aborted before server.connected was received.',
          ),
        );
      };

      const timer = setTimeout(() => {
        finish(
          new Error(
            'Timed out waiting for OpenCode event stream server.connected event.',
          ),
        );
      }, this.eventStreamReadyTimeoutMs);

      this.eventAbortController.signal.addEventListener('abort', handleAbort, {
        once: true,
      });
      this.resolveEventStreamReady = () => finish();
      this.rejectEventStreamReady = (error) => finish(error);
    });
  }

  private startEventStream(): void {
    void this.client
      .streamEvents({
        signal: this.eventAbortController.signal,
        onEvent: async (event) => await this.handleEvent(event),
      })
      .catch((error: unknown) => {
        this.rejectEventStreamReady?.(error);

        if (this.disposed || this.eventAbortController.signal.aborted) {
          return;
        }

        this.connected = false;
        this.logger.warn(
          `OpenCode event stream disconnected: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        this.emit('disconnected');
      });
  }

  private async handleCommand(command: TaskCommand): Promise<void> {
    switch (command.commandName) {
      case TaskCommandName.StartNewTask:
        await this.handleStartNewTask(command);
        return;
      case TaskCommandName.SendMessage:
        await this.handleSendMessage(command);
        return;
      case TaskCommandName.CancelTask:
        await this.handleCancelTask(command);
        return;
      case TaskCommandName.CloseTask:
        this.currentWorkflowPhase = null;
        this.activeWorkflowSkill = null;
        this.inFlight = false;
        this.prompts.clear();
        this.clearQueuedPromptRetryTimer();
        this.clearAllExecuteToolProgress();
        return;
      case TaskCommandName.ResumeTask:
        // Defer server-side validation to the first session use
        // (ensureSession) — the single chokepoint before any prompt — so a
        // closely-following prompt can't race resume into creating a duplicate
        // session.
        this.sessionId = command.data;
        this.resumedSessionPendingValidation = true;
        this.runtimeEvents.taskStarted(command.data);
        return;
      case TaskCommandName.RestoreQueuedMessages:
        this.prompts.restore(command.data.queuedMessages, {
          emitUpdate: true,
        });
        return;
      case TaskCommandName.DeleteQueuedMessage: {
        const id = extractQueuedMessageId(command);
        if (id) {
          this.prompts.deleteById(id);
        }
        return;
      }
      case TaskCommandName.PrioritizeQueuedMessage: {
        const id = extractQueuedMessageId(command);
        if (id) {
          this.prompts.prioritize(id);
        }
        return;
      }
      case TaskCommandName.ReorderQueuedMessage: {
        const move = extractQueuedMessageMove(command);
        if (move) {
          this.prompts.move(move.id, move.targetId, move.position);
        }
        return;
      }
      case TaskCommandName.AnswerUserInputRequest:
        await this.handleAnswerUserInputRequest(command);
        return;
    }
  }

  private async handleStartNewTask(
    command: StartNewTaskCommand,
  ): Promise<void> {
    this.prompts.clear();
    this.clearAllExecuteToolProgress();
    this.stopHookReminderCount = 0;
    this.currentWorkflowPhase = command.data.workflowPhase ?? null;
    this.activeWorkflowSkill = null;

    const sessionId = await this.ensureSession(command.data.text);
    this.runtimeEvents.taskStarted(sessionId);
    this.runtimeEvents.userPrompt({
      sessionId,
      ...command.data,
    });
    await this.submitPrompt(command.data);
  }

  private async handleSendMessage(command: SendMessageCommand): Promise<void> {
    const text = command.data.text ?? '';
    this.stopHookReminderCount = 0;

    if (command.data.workflowPhase) {
      this.currentWorkflowPhase = command.data.workflowPhase;
    }

    if (command.data.queueOnly || this.inFlight) {
      // True native steering: OpenCode accepts prompt_async on a session with
      // an active turn and the loop picks the message up between steps — no
      // abort, so in-flight work (tools, subagents, delivery) survives the
      // steer. Falls back to queue + abort-and-replay if injection fails.
      // Not usable while a question tool call is pending: the turn is blocked
      // inside that tool's deferred, never reaches the next step, and a
      // natively injected prompt would sit unseen forever. Abort-and-replay
      // instead so the agent actually receives the message.
      if (
        this.inFlight &&
        command.data.autoSteerWhenQueued &&
        !command.data.queueOnly &&
        this.sessionId &&
        this.pendingUserInputRequests.size === 0
      ) {
        const steerSessionId = this.sessionId;

        try {
          await this.submitPrompt({ ...command.data, text });
          this.runtimeEvents.userPrompt({
            sessionId: steerSessionId,
            ...command.data,
            text,
          });
          return;
        } catch (error) {
          this.logger.warn(
            `Native mid-turn steer injection failed; falling back to queued replay. ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      const queuedId = this.prompts.enqueue({
        text,
        images: command.data.images,
        queueOnly: command.data.queueOnly,
        visibleInTranscript: command.data.visibleInTranscript,
        userId: command.data.userId,
        userName: command.data.userName,
        userImageUrl: command.data.userImageUrl,
        clientMessageId: command.data.clientMessageId,
      });

      if (command.data.autoSteerWhenQueued) {
        this.prompts.prioritize(queuedId);
        await this.interruptForQueuedReplay();
      }

      return;
    }

    const sessionId = await this.ensureSession(text);
    this.runtimeEvents.userPrompt({
      sessionId,
      ...command.data,
      text,
    });
    await this.submitPrompt({ ...command.data, text });
  }

  private async handleCancelTask(command?: CancelTaskCommand): Promise<void> {
    const sessionId = this.sessionId;

    if (!sessionId) {
      this.inFlight = false;
      this.prompts.clear();
      this.clearQueuedPromptRetryTimer();
      this.pendingUserInputRequests.clear();
      this.clearAllExecuteToolProgress();
      return;
    }

    const cancelledBy = command?.data?.cancelledBy;
    const hadActiveTurn =
      this.inFlight || this.pendingUserInputRequests.size > 0;

    // Aborting an in-flight turn makes OpenCode emit a MessageAbortedError on the
    // session.error event. For an explicit cancel that's expected, not a failure
    // (the cancel is already surfaced via runtimeEvents.taskAborted), so suppress it the
    // same way interruptForQueuedReplay does — otherwise it shows up in the UI as
    // "OpenCode session error: MessageAbortedError".
    this.armReplayAbortErrorSuppression();
    await this.client.abort({
      sessionId,
      signal: this.eventAbortController.signal,
    });
    // Flush whatever the aborted turn had produced so it persists at the
    // cancel point, then drop the trailing finalize/part events OpenCode
    // emits for the aborted message — without this, that content re-emerges
    // in the transcript after the cancel.
    if (hadActiveTurn) {
      await this.flushAssistantMessageForCancel(sessionId);
    }
    this.suppressAssistantOutputUntilNextPrompt = true;
    this.inFlight = false;
    this.finalizedAssistantTurn = null;
    this.prompts.clear();
    this.clearQueuedPromptRetryTimer();
    // Abandoned questions get an explicit cancelled response so surfaces
    // that clear pending state on request_user_input_response (Slack,
    // Linear, the web store) drop them, and late answers are rejected via
    // the resolved-id set instead of being injected into a dead turn.
    if (this.pendingUserInputRequests.size > 0) {
      for (const pending of this.pendingUserInputRequests.values()) {
        this.runtimeEvents.requestUserInputResponse({
          request: pending,
          answers: {},
          resolution: 'cancelled',
        });
        this.recordResolvedUserInputRequest(pending.requestId);
      }
      this.pendingUserInputRequests.clear();
    }
    this.clearAllExecuteToolProgress();

    // Only an explicit user stop that actually interrupted something leaves
    // a visible marker; internal cancels (steer replay, env-var resumable
    // stop, task replacement) and idle stops stay silent.
    if (cancelledBy && hadActiveTurn) {
      this.runtimeEvents.taskCancelled({
        sessionId,
        cancelledByName: cancelledBy.name,
        source: cancelledBy.source,
      });
    }

    this.runtimeEvents.taskAborted(sessionId);
  }

  /**
   * Persist the in-flight assistant message as it stood at cancel time so the
   * transcript keeps the partial output the user saw, ordered before the
   * cancel marker. Marking it persisted also makes the post-abort
   * `message.updated` finalize a no-op.
   */
  private async flushAssistantMessageForCancel(
    sessionId: string,
  ): Promise<void> {
    try {
      const messages = await this.client.messages({
        sessionId,
        limit: 20,
        signal: this.eventAbortController.signal,
      });
      const latestAssistantMessage = [...messages]
        .reverse()
        .find(
          (message) =>
            message.info.role === 'assistant' &&
            !this.persistedMessageIds.has(message.info.id),
        );

      if (!latestAssistantMessage) {
        return;
      }

      this.persistAssistantMessage(latestAssistantMessage);
    } catch (error) {
      this.logger.warn(
        `OpenCode cancel could not flush the aborted assistant message sessionId=${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private armReplayAbortErrorSuppression(): void {
    this.clearReplayAbortErrorSuppression();
    this.suppressNextReplayAbortError = true;
    this.replayAbortErrorSuppressionTimeout = setTimeout(() => {
      this.suppressNextReplayAbortError = false;
      this.replayAbortErrorSuppressionTimeout = undefined;
    }, EXPECTED_REPLAY_ABORT_SUPPRESSION_MS);
    this.replayAbortErrorSuppressionTimeout.unref?.();
  }

  private clearReplayAbortErrorSuppression(): void {
    if (this.replayAbortErrorSuppressionTimeout) {
      clearTimeout(this.replayAbortErrorSuppressionTimeout);
      this.replayAbortErrorSuppressionTimeout = undefined;
    }

    this.suppressNextReplayAbortError = false;
  }

  private scheduleExecuteToolProgress(
    eventKey: string,
    delayMs: number,
  ): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.emitExecuteToolProgress(eventKey);
    }, delayMs);
    timer.unref?.();
    return timer;
  }

  private emitExecuteToolProgress(eventKey: string): void {
    const progress = this.activeExecuteToolProgress.get(eventKey);

    if (!progress) {
      return;
    }

    const nowMs = Date.now();
    const output = formatExecuteToolProgressOutput(progress, nowMs);

    this.runtimeEvents.toolUpdate({
      sessionId: progress.sessionId,
      messageId: progress.messageId,
      toolCallId: progress.toolCallId,
      toolName: progress.toolName,
      status: 'in_progress',
      output,
      payload: {
        ...progress.payload,
        status: 'in_progress',
        running: true,
        progressKind: 'execute_tool_heartbeat',
        progressStartedAtMs: progress.startedAtMs,
        progressElapsedMs: nowMs - progress.startedAtMs,
      },
    });

    progress.timer = this.scheduleExecuteToolProgress(
      eventKey,
      this.executeToolProgressIntervalMs,
    );
  }

  private stopExecuteToolProgress(eventKey: string): void {
    const progress = this.activeExecuteToolProgress.get(eventKey);

    if (!progress) {
      return;
    }

    clearTimeout(progress.timer);
    this.activeExecuteToolProgress.delete(eventKey);
  }

  private clearAllExecuteToolProgress(options?: {
    keepBackgroundWatchdogs?: boolean;
  }): void {
    for (const progress of this.activeExecuteToolProgress.values()) {
      clearTimeout(progress.timer);
    }

    this.activeExecuteToolProgress.clear();
    // The stop-hook reminder fail-safe shares this teardown lifecycle: every
    // point that clears execute-tool heartbeats (turn finish, cancel, session
    // error, queued replay, dispose) also means the awaited reminder response
    // either arrived or is moot, so disarm the pending fail-safe.
    this.clearStopHookReminderStall();
    // Subagent run tracking shares the same lifecycle: every teardown point
    // that clears execute-tool heartbeats (turn finish, cancel, session error,
    // queued replay, dispose) must also drop pending subagent trackers.
    // Exception: background launches outlive the parent turn by design, so
    // turn finish keeps their trackers until the child session goes idle.
    this.clearAllSubagentWatchdogs(options);
  }

  private startSubagentWatchdog(
    eventKey: string,
    input: {
      sessionId: string;
      messageId: string | undefined;
      toolCallId: string;
      title: string;
      agentType: string | null;
      childSessionId: string | null;
      background: boolean;
      updatePayload: Record<string, unknown>;
    },
  ): void {
    const existing = this.activeSubagentWatchdogs.get(eventKey);

    if (existing) {
      // Pick up details (like the child session id or the background flag)
      // that only appear on later part updates.
      existing.background = existing.background || input.background;
      existing.childSessionId = input.childSessionId ?? existing.childSessionId;
      existing.agentType = input.agentType ?? existing.agentType;
      existing.title = input.title;
      existing.updatePayload = input.updatePayload;
      if (existing.childSessionId) {
        this.childSessionWatchdogKeys.set(existing.childSessionId, eventKey);
      }
      return;
    }

    const watchdog: ActiveOpenCodeSubagentWatchdog = {
      sessionId: input.sessionId,
      background: input.background,
      messageId: input.messageId,
      toolCallId: input.toolCallId,
      title: input.title,
      agentType: input.agentType,
      childSessionId: input.childSessionId,
      startedAtMs: Date.now(),
      updatePayload: input.updatePayload,
      activitySeenChildToolCallIds: new Set(),
      activityLastAction: null,
      activityLastEmitAtMs: 0,
    };
    this.activeSubagentWatchdogs.set(eventKey, watchdog);
    if (input.childSessionId) {
      this.childSessionWatchdogKeys.set(input.childSessionId, eventKey);
    }
    this.logger.info(
      `Tracking OpenCode subagent run toolCallId=${input.toolCallId} agentType=${
        input.agentType ?? 'unknown'
      } childSessionId=${input.childSessionId ?? 'pending'}`,
    );
  }

  private updateSubagentWatchdogForToolPart(
    eventKey: string,
    toolPart: OpenCodeToolPart,
    normalized: OpenCodeNormalizedToolPart,
    context: { sessionId: string; messageId?: string },
  ): void {
    if (!isOpenCodeSubagentTaskTool(toolPart.tool ?? '')) {
      return;
    }

    if (isTerminalOpenCodeToolStatus(normalized.status)) {
      // A background launch's tool call completes immediately while the child
      // session keeps working, so a completed background part must keep the
      // run tracked (keyed to the child session) until the child session
      // goes idle.
      if (
        normalized.status === 'completed' &&
        isOpenCodeBackgroundTaskToolPart(toolPart)
      ) {
        this.startSubagentWatchdog(eventKey, {
          sessionId: context.sessionId,
          messageId: context.messageId,
          toolCallId: normalized.toolCallId,
          title: normalized.title,
          agentType: extractOpenCodeTaskToolAgentType(toolPart),
          childSessionId: extractOpenCodeTaskToolChildSessionId(toolPart),
          background: true,
          updatePayload: normalized.updatePayload,
        });
        return;
      }

      this.stopSubagentWatchdog(eventKey);
      return;
    }

    this.startSubagentWatchdog(eventKey, {
      sessionId: context.sessionId,
      messageId: context.messageId,
      toolCallId: normalized.toolCallId,
      title: normalized.title,
      agentType: extractOpenCodeTaskToolAgentType(toolPart),
      childSessionId: extractOpenCodeTaskToolChildSessionId(toolPart),
      background: isOpenCodeBackgroundTaskToolPart(toolPart),
      updatePayload: normalized.updatePayload,
    });
  }

  private captureTerminalSubagentActivity(
    eventKey: string,
    toolPart: OpenCodeToolPart,
    normalized: OpenCodeNormalizedToolPart,
  ): Record<string, unknown> | null {
    if (
      !isOpenCodeSubagentTaskTool(toolPart.tool ?? '') ||
      !isTerminalOpenCodeToolStatus(normalized.status)
    ) {
      return null;
    }

    const watchdog = this.activeSubagentWatchdogs.get(eventKey);

    if (!watchdog) {
      return null;
    }

    return {
      agentType: watchdog.agentType,
      lastAction: watchdog.activityLastAction,
      toolCallCount: watchdog.activitySeenChildToolCallIds.size,
      startedAtMs: watchdog.startedAtMs,
      elapsedMs: Date.now() - watchdog.startedAtMs,
      terminal: true,
    };
  }

  private stopSubagentWatchdog(eventKey: string): void {
    const watchdog = this.activeSubagentWatchdogs.get(eventKey);

    if (!watchdog) {
      return;
    }

    if (watchdog.childSessionId) {
      this.childSessionWatchdogKeys.delete(watchdog.childSessionId);
    }
    this.activeSubagentWatchdogs.delete(eventKey);
  }

  private clearAllSubagentWatchdogs(options?: {
    keepBackgroundWatchdogs?: boolean;
  }): void {
    for (const [eventKey, watchdog] of this.activeSubagentWatchdogs) {
      if (options?.keepBackgroundWatchdogs && watchdog.background) {
        continue;
      }

      this.activeSubagentWatchdogs.delete(eventKey);
      if (watchdog.childSessionId) {
        this.childSessionWatchdogKeys.delete(watchdog.childSessionId);
      }
    }
  }

  /**
   * Live activity for the inline subagent row: child-session tool events are
   * folded into throttled toolUpdate emissions on the parent spawn tool call,
   * mirroring the execute_tool_heartbeat pattern (same logical row, so
   * persistence upserts instead of appending transcript messages).
   */
  private handleChildSessionToolActivity(
    childSessionId: string,
    payload: OpenCodeEventPayload,
  ): void {
    const eventKey = this.childSessionWatchdogKeys.get(childSessionId);
    const watchdog = eventKey
      ? this.activeSubagentWatchdogs.get(eventKey)
      : undefined;

    if (!watchdog || payload.type !== 'message.part.updated') {
      return;
    }

    const part = asRecord(asRecord(payload.properties)?.part);

    if (!part || asString(part.type) !== 'tool') {
      return;
    }

    const childToolCallId = asString(part.callID) ?? asString(part.id);

    if (childToolCallId) {
      watchdog.activitySeenChildToolCallIds.add(childToolCallId);
    }

    const state = asRecord(part.state);
    const input = asRecord(state?.input);
    const action = [
      asString(part.tool),
      asString(input?.command) ??
        asString(input?.description) ??
        asString(state?.title) ??
        asString(input?.pattern) ??
        asString(input?.filePath),
    ]
      .filter(Boolean)
      .join(' ')
      .slice(0, 120);

    if (action) {
      watchdog.activityLastAction = action;
    }

    const nowMs = Date.now();

    if (
      nowMs - watchdog.activityLastEmitAtMs <
      SUBAGENT_ACTIVITY_EMIT_INTERVAL_MS
    ) {
      return;
    }

    watchdog.activityLastEmitAtMs = nowMs;
    this.runtimeEvents.toolUpdate({
      sessionId: watchdog.sessionId,
      messageId: watchdog.messageId,
      toolCallId: watchdog.toolCallId,
      toolName: OPEN_CODE_SUBAGENT_TASK_TOOL_NAME,
      status: 'in_progress',
      payload: {
        ...watchdog.updatePayload,
        status: 'in_progress',
        running: true,
        progressKind: 'subagent_activity',
        subagentActivity: {
          agentType: watchdog.agentType,
          lastAction: watchdog.activityLastAction,
          toolCallCount: watchdog.activitySeenChildToolCallIds.size,
          startedAtMs: watchdog.startedAtMs,
          elapsedMs: nowMs - watchdog.startedAtMs,
        },
      },
    });
  }

  /**
   * Hidden accounting for subagent (child-session) turns: completed assistant
   * messages on child sessions never reach the main-session finalize path, so
   * emit their inference usage directly from the event payload. The agent name
   * comes from the message itself, with the parent spawn watchdog's agentType
   * as a fallback.
   */
  private handleChildSessionMessageUpdated(
    childSessionId: string,
    payload: OpenCodeEventPayload,
  ): void {
    if (payload.type !== 'message.updated') {
      return;
    }

    const info = asRecord(asRecord(payload.properties)?.info) as
      | (OpenCodeMessageInfo & Record<string, unknown>)
      | null;

    if (!info || !info.id || info.sessionID !== childSessionId) {
      return;
    }

    if (parseOpenCodeMessageRole(info.role) !== 'assistant') {
      return;
    }

    if (!info.time?.completed) {
      return;
    }

    if (this.recordedChildUsageMessageIds.has(info.id)) {
      return;
    }

    this.recordedChildUsageMessageIds.add(info.id);
    this.emit(
      'runtimeInferenceUsage',
      createInferenceUsageEvent(
        info,
        createTokenUsage(info),
        this.resolveChildSessionAgentType(childSessionId),
      ),
    );
  }

  private resolveChildSessionAgentType(
    childSessionId: string,
  ): string | undefined {
    const eventKey = this.childSessionWatchdogKeys.get(childSessionId);
    const watchdog = eventKey
      ? this.activeSubagentWatchdogs.get(eventKey)
      : undefined;

    return watchdog?.agentType ?? undefined;
  }

  private updateExecuteToolProgress(
    eventKey: string,
    normalized: OpenCodeNormalizedToolPart,
    context: {
      sessionId: string;
      messageId?: string;
    },
  ): void {
    if (normalized.callPayload.isExecute !== true) {
      this.stopExecuteToolProgress(eventKey);
      return;
    }

    if (
      isTerminalOpenCodeToolStatus(normalized.status) ||
      normalized.output.length > 0 ||
      normalized.error
    ) {
      this.stopExecuteToolProgress(eventKey);
      return;
    }

    if (normalized.rawStatus !== 'running') {
      return;
    }

    const existing = this.activeExecuteToolProgress.get(eventKey);

    if (existing) {
      existing.title = normalized.title;
      existing.command = asString(normalized.callPayload.command);
      existing.payload = normalized.updatePayload;
      return;
    }

    this.activeExecuteToolProgress.set(eventKey, {
      sessionId: context.sessionId,
      messageId: context.messageId,
      toolCallId: normalized.toolCallId,
      toolName: normalized.toolName,
      title: normalized.title,
      command: asString(normalized.callPayload.command),
      payload: normalized.updatePayload,
      startedAtMs: Date.now(),
      timer: this.scheduleExecuteToolProgress(
        eventKey,
        this.executeToolProgressInitialDelayMs,
      ),
    });
  }

  private async interruptForQueuedReplay(): Promise<void> {
    // The in-flight turn (and any question it was blocked on) is being
    // superseded by a prioritized queued/steered prompt. Abandon pending
    // questions so the replayed turn starts clean and downstream state
    // (harness manager phase, UI) does not stay stuck on an obsolete
    // request. Emit a cancelled response for each so consumers that only
    // clear pending state on request_user_input_response (Slack, Linear,
    // the web store) drop it too — otherwise a late answer to the dead
    // question could still be accepted and injected into the replayed turn.
    // The answer path deletes its own request and emits its response before
    // reaching here, so this only sweeps questions the replay abandons.
    if (this.pendingUserInputRequests.size > 0) {
      for (const pending of this.pendingUserInputRequests.values()) {
        this.runtimeEvents.requestUserInputResponse({
          request: pending,
          answers: {},
          resolution: 'cancelled',
        });
        this.recordResolvedUserInputRequest(pending.requestId);
      }
      this.pendingUserInputRequests.clear();
    }

    const sessionId = this.sessionId;

    if (!sessionId) {
      this.inFlight = false;
      this.clearAllExecuteToolProgress();
      await this.drainQueuedPrompts();
      return;
    }

    this.armReplayAbortErrorSuppression();
    await this.client.abort({
      sessionId,
      signal: this.eventAbortController.signal,
    });
    this.inFlight = false;
    this.finalizedAssistantTurn = null;
    this.clearAllExecuteToolProgress();
    await this.drainQueuedPrompts();
  }

  private async handleAnswerUserInputRequest(
    command: AnswerUserInputRequestCommand,
  ): Promise<void> {
    // Reject answers for questions that were already answered or abandoned
    // (e.g. a steer replayed the turn after a web answer POST was opened).
    // The fallback below exists for the legit race where an answer arrives
    // before the harness registered the request; a resolved id is not that.
    if (
      !this.pendingUserInputRequests.has(command.data.requestId) &&
      this.resolvedUserInputRequestIds.has(command.data.requestId)
    ) {
      this.logger.warn(
        `OpenCode harness ignoring AnswerUserInputRequest for already-resolved requestId=${command.data.requestId}`,
      );
      return;
    }

    const pending =
      this.pendingUserInputRequests.get(command.data.requestId) ??
      this.createFallbackUserInputRequest(command.data.requestId);

    if (!pending) {
      this.logger.warn(
        `OpenCode harness received AnswerUserInputRequest for unknown requestId=${command.data.requestId}`,
      );
      return;
    }

    this.pendingUserInputRequests.delete(command.data.requestId);
    this.recordResolvedUserInputRequest(command.data.requestId);
    const resolution = getRequestUserInputResponseResolution(
      command.data.answers,
    );
    this.runtimeEvents.requestUserInputResponse({
      request: pending,
      answers: command.data.answers,
      resolution,
    });

    const responseText = formatOpenCodeUserInputResponsePrompt({
      request: pending,
      answers: command.data.answers,
      resolution,
    });

    if (this.inFlight) {
      const queuedId = this.prompts.enqueue({
        text: responseText,
        visibleInTranscript: false,
        userId: command.data.userId,
      });
      this.prompts.prioritize(queuedId);
      await this.interruptForQueuedReplay();
      return;
    }

    const sessionId = await this.ensureSession(responseText);
    this.runtimeEvents.userPrompt({
      sessionId,
      text: responseText,
      visibleInTranscript: false,
      source: 'request_user_input_response',
      userId: command.data.userId,
    });
    await this.submitPrompt({
      text: responseText,
      visibleInTranscript: false,
      source: 'request_user_input_response',
      userId: command.data.userId,
    });
  }

  private recordResolvedUserInputRequest(requestId: string): void {
    // Re-insert to move to the end (most-recently-resolved) for eviction.
    this.resolvedUserInputRequestIds.delete(requestId);
    this.resolvedUserInputRequestIds.add(requestId);

    while (
      this.resolvedUserInputRequestIds.size >
      MAX_RESOLVED_USER_INPUT_REQUEST_IDS
    ) {
      const oldest = this.resolvedUserInputRequestIds.values().next().value;

      if (oldest === undefined) {
        break;
      }

      this.resolvedUserInputRequestIds.delete(oldest);
    }
  }

  private createFallbackUserInputRequest(
    requestId: string,
  ): HarnessPendingUserInputRequest | null {
    const sessionId = this.sessionId;

    if (!sessionId) {
      return null;
    }

    const parts = requestId.split(':');
    const parsedSessionId =
      parts[0] === 'rui' && parts[1] ? parts[1] : sessionId;
    const turnId = parts[0] === 'rui' && parts[2] ? parts[2] : 'message';
    const callId = parts[0] === 'rui' && parts[3] ? parts[3] : requestId;

    return {
      requestId,
      sessionId: parsedSessionId,
      turnId,
      callId,
      questions: [],
      status: 'pending',
      ts: this.runtimeEvents.nextTs(),
    };
  }

  private async ensureSession(title?: string): Promise<string> {
    // A resumed session id is validated server-side before its first reuse.
    // Codex validates and resets on resume; without this an invalid id is
    // silently retained and only surfaces when the first prompt fails (or a
    // brand-new session is spawned behind the user's back). If validation
    // fails we drop the id so a fresh session is created deliberately.
    if (this.sessionId && this.resumedSessionPendingValidation) {
      this.resumedSessionPendingValidation = false;
      const validated = await this.validateResumedSession(this.sessionId);
      if (!validated) {
        this.sessionId = undefined;
      }
    }

    if (this.sessionId) {
      return this.sessionId;
    }

    const session = await this.client.createSession({
      title: title?.slice(0, 80),
      signal: this.eventAbortController.signal,
    });
    this.sessionId = session.id;
    return session.id;
  }

  private async validateResumedSession(sessionId: string): Promise<boolean> {
    try {
      await this.client.messages({
        sessionId,
        limit: 1,
        signal: this.eventAbortController.signal,
      });
      return true;
    } catch (error) {
      this.logger.warn(
        `OpenCode resume could not validate prior session sessionId=${sessionId}; a new session will be created. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /**
   * Track the most recent packaged workflow skill loaded by the primary
   * session so per-prompt agent selection can follow the active workflow.
   * Child (subagent) sessions never change the primary session's agent.
   *
   * When a mid-turn skill load exits the plan workflow, queue one hidden
   * continuation prompt so the implementation resumes automatically on the
   * writable agent after the current read-only plan-mode turn ends.
   */
  private trackActiveWorkflowSkill(
    toolPart: OpenCodeToolPart,
    sessionId: string,
  ): void {
    if (!this.sessionId || sessionId !== this.sessionId) {
      return;
    }

    if (
      (toolPart.tool ?? '').toLowerCase() !== OPENCODE_SKILL_TOOL ||
      toolPart.state?.status !== 'completed'
    ) {
      return;
    }

    const skillName = asString(asRecord(toolPart.state?.input)?.name)
      ?.trim()
      .toLowerCase();

    if (!skillName) {
      return;
    }

    const transition = resolveWorkflowSkillTransition({
      previousSkill: this.activeWorkflowSkill,
      loadedSkill: skillName,
      inFlight: this.inFlight,
    });

    this.activeWorkflowSkill = transition.nextSkill;

    if (transition.queueContinuation && this.isPlanModeEnabled()) {
      this.enqueuePlanExitContinuation();
    }
  }

  /**
   * Queue the hidden plan-exit continuation, deduped against an already
   * queued continuation so repeated skill-load events for the same flip
   * produce at most one pending continuation.
   *
   * The turn's agent is locked at submit time, so if the in-flight turn was
   * already writable (it started before the plan skill pinned prompts onto
   * the architect agent), the continuation is harmless follow-through rather
   * than a required unlock.
   */
  private enqueuePlanExitContinuation(): void {
    const alreadyQueued = this.prompts
      .snapshot()
      .some((message) => message.text === PLAN_EXIT_CONTINUATION_PROMPT);

    if (alreadyQueued) {
      return;
    }

    this.prompts.enqueue({
      text: PLAN_EXIT_CONTINUATION_PROMPT,
      visibleInTranscript: false,
    });
  }

  private isPlanModeEnabled(): boolean {
    return (
      this.commandEnv?.ROOMOTE_PLAN_MODE === '1' ||
      this.commandEnv?.ROOMOTE_PLAN_MODE === 'true'
    );
  }

  /**
   * Prompts only switch onto Roomote's generated read-mostly `architect`
   * agent when both the planning workflow skill is active and plan mode is
   * enabled for the task runtime. Everything else uses the default `build`
   * agent.
   */
  private resolvePromptAgent(): string {
    return this.isPlanModeEnabled() &&
      this.activeWorkflowSkill === PLAN_WORKFLOW_SKILL
      ? OPENCODE_ARCHITECT_AGENT
      : OPENCODE_BUILD_AGENT;
  }

  private async submitPrompt(prompt: PromptInput): Promise<void> {
    this.suppressAssistantOutputUntilNextPrompt = false;
    const sessionId = await this.ensureSession(prompt.text);
    const messageID = createOpenCodeMessageId();
    const nonEmptyImages = (prompt.images ?? []).filter(
      (image) => image.trim().length > 0,
    );
    const shouldAddVisualDelegationReminder =
      nonEmptyImages.length > 0 && hasVisualAgentConfigured(this.commandEnv);
    let addVisualDelegationReminder = shouldAddVisualDelegationReminder;
    let visualImagePaths: string[] = [];
    let promptImages = prompt.images;

    if (shouldAddVisualDelegationReminder) {
      try {
        const materialized = await materializeVisualPromptImages({
          images: nonEmptyImages,
          sessionId,
          messageId: messageID,
        });
        visualImagePaths = materialized.imagePaths;
        this.visualAttachmentDirectories.add(materialized.directory);
        promptImages = undefined;
      } catch (error) {
        addVisualDelegationReminder = false;
        this.logger.warn(
          `OpenCode visual prompt image materialization failed; falling back to direct image parts. ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const promptText = addVisualDelegationReminder
      ? withVisualDelegationReminder(prompt.text, visualImagePaths)
      : prompt.text;

    this.inFlight = true;
    this.finalizedAssistantTurn = null;
    this.submittedUserMessageIds.add(messageID);
    this.messageRoleById.set(messageID, 'user');
    const agent = this.resolvePromptAgent();
    // Architect-agent prompts omit the request-level model so the agent-level
    // planning model from the generated OpenCode config applies; without a
    // configured planning model OpenCode falls back to the config's top-level
    // model, which already reflects any per-task override.
    const shouldSendRequestModel = Boolean(
      this.model && agent !== OPENCODE_ARCHITECT_AGENT,
    );
    try {
      await this.client.promptAsync({
        sessionId,
        signal: this.eventAbortController.signal,
        request: {
          messageID,
          ...(shouldSendRequestModel && this.model
            ? {
                model: {
                  providerID: this.model.providerID,
                  modelID: this.model.modelID,
                },
              }
            : {}),
          agent,
          parts: createOpenCodePromptParts({
            text: promptText,
            images: promptImages,
          }),
        },
      });
    } catch (error) {
      await this.cleanupVisualAttachmentDirectories();
      this.inFlight = false;
      throw error;
    }
  }

  private async handleEvent(rawEvent: OpenCodeGlobalEvent): Promise<void> {
    const unwrapped = unwrapOpenCodeEvent(rawEvent);

    if (!unwrapped) {
      return;
    }

    if (
      unwrapped.directory &&
      normalizePathForCompare(unwrapped.directory) !==
        this.normalizedWorkspacePath
    ) {
      return;
    }

    const payload = unwrapped.payload;
    const sessionId = eventSessionId(payload);

    if (sessionId && this.sessionId && sessionId !== this.sessionId) {
      // Child-session (subagent) events are otherwise dropped here; fold tool
      // activity into the parent spawn row and record hidden inference usage
      // before returning. A child session going idle or erroring is its
      // terminal signal — it ends run tracking (for background launches this
      // is what ends the tracking that outlived the instant task-tool
      // completion), and a child's idle or error must never finish the
      // parent turn.
      if (payload.type === 'session.idle' || payload.type === 'session.error') {
        const watchdogKey = this.childSessionWatchdogKeys.get(sessionId);

        if (watchdogKey) {
          this.stopSubagentWatchdog(watchdogKey);
        }

        return;
      }

      this.handleChildSessionToolActivity(sessionId, payload);
      this.handleChildSessionMessageUpdated(sessionId, payload);
      return;
    }

    switch (payload.type) {
      case 'server.connected':
        this.resolveEventStreamReady?.();
        return;
      case 'session.status':
        await this.handleSessionStatus(payload);
        return;
      case 'session.idle':
        await this.handleSessionIdle(payload);
        return;
      case 'session.error':
        await this.handleSessionError(payload);
        return;
      case 'message.part.updated':
        this.handleMessagePartUpdated(payload);
        return;
      case 'message.updated':
        await this.handleMessageUpdated(payload);
        return;
    }
  }

  private async handleSessionStatus(
    payload: OpenCodeEventPayload,
  ): Promise<void> {
    const properties = asRecord(payload.properties);
    const status = asRecord(properties?.status);
    const statusType = asString(status?.type);

    if (statusType === 'busy' || statusType === 'retry') {
      this.inFlight = true;
      return;
    }

    if (statusType === 'idle') {
      await this.finishCurrentTurn();
    }
  }

  private async handleSessionIdle(
    payload: OpenCodeEventPayload,
  ): Promise<void> {
    const properties = asRecord(payload.properties);
    const sessionId =
      asString(properties?.sessionID) ?? asString(properties?.sessionId);

    if (sessionId) {
      const watchdogKey = this.childSessionWatchdogKeys.get(sessionId);

      if (watchdogKey) {
        // A subagent child session going idle is its completion signal — for
        // background launches this is what disarms the watchdog. A child
        // session's idle must never finish the parent turn.
        this.stopSubagentWatchdog(watchdogKey);
        return;
      }
    }

    if (sessionId && !this.sessionId) {
      this.sessionId = sessionId;
    }

    await this.finishCurrentTurn();
  }

  private async handleSessionError(
    payload: OpenCodeEventPayload,
  ): Promise<void> {
    const properties = asRecord(payload.properties);
    const sessionId =
      asString(properties?.sessionID) ??
      asString(properties?.sessionId) ??
      this.sessionId;
    const error = properties?.error;

    if (
      isOpenCodeMessageAbortedError(error) &&
      this.suppressNextReplayAbortError
    ) {
      this.clearReplayAbortErrorSuppression();
      this.logger.info(
        `Suppressing expected OpenCode MessageAbortedError after an intentional interrupt (queued replay or task cancel) sessionId=${sessionId ?? 'unknown'}`,
      );
      return;
    }

    if (sessionId) {
      this.logger.error(
        `OpenCode session error sessionId=${sessionId}: ${JSON.stringify(error ?? {})}`,
      );
      this.runtimeEvents.assistantMessage({
        sessionId,
        text: formatOpenCodeSessionErrorText(error),
      });
      this.prompts.clear();
      this.clearQueuedPromptRetryTimer();
      this.pendingUserInputRequests.clear();
      this.clearAllExecuteToolProgress();
      this.runtimeEvents.taskAborted(sessionId);
    }

    await this.cleanupVisualAttachmentDirectories();
    this.inFlight = false;
  }

  private handleMessagePartUpdated(payload: OpenCodeEventPayload): void {
    const properties = asRecord(payload.properties);
    const part = asRecord(properties?.part) as OpenCodePart | null;

    if (!part) {
      return;
    }

    const sessionId = asString(part.sessionID) ?? this.sessionId;
    const messageId = asString(part.messageID);
    const partId = asString(part.id);

    if (!sessionId || !partId) {
      return;
    }

    const explicitRole = extractOpenCodePartMessageRole(
      properties,
      part,
      messageId,
    );

    if (messageId && explicitRole) {
      this.messageRoleById.set(messageId, explicitRole);
    }

    const messageRole =
      explicitRole ?? (messageId ? this.messageRoleById.get(messageId) : null);

    if (
      messageRole === 'user' ||
      (messageId && this.submittedUserMessageIds.has(messageId))
    ) {
      return;
    }

    if (
      this.suppressAssistantOutputUntilNextPrompt &&
      (part.type === 'text' || part.type === 'reasoning')
    ) {
      // Trailing stream parts for a cancelled turn; the flushed message
      // already persisted everything the transcript should keep.
      return;
    }

    if (part.type === 'text') {
      const fullText = extractPartText(part);
      const delta =
        asString(properties?.delta) ??
        fullText.slice(this.streamedPartText.get(partId)?.length ?? 0);

      this.streamedPartText.set(partId, fullText);

      if (messageId) {
        this.streamedMessageIds.add(messageId);
      }

      this.runtimeEvents.assistantMessageChunk({
        sessionId,
        messageId,
        text: delta,
      });
      return;
    }

    if (part.type === 'reasoning') {
      const fullText = extractPartText(part);
      const delta =
        asString(properties?.delta) ??
        fullText.slice(this.streamedPartText.get(partId)?.length ?? 0);

      this.streamedPartText.set(partId, fullText);

      if (messageId && delta.length > 0) {
        this.streamedReasoningMessageIds.add(messageId);
      }

      this.runtimeEvents.assistantThoughtChunk({
        sessionId,
        messageId,
        text: delta,
      });
      return;
    }

    if (part.type === 'tool') {
      const toolPart = part as OpenCodeToolPart;
      this.handleToolPartUpdated(toolPart, { sessionId, messageId, partId });
      return;
    }

    if (part.type === 'subtask') {
      const subtaskPart = part as OpenCodeSubtaskPart;
      this.handleSubtaskPartUpdated(subtaskPart, {
        sessionId,
        messageId,
        partId,
      });
    }
  }

  private handleToolPartUpdated(
    toolPart: OpenCodeToolPart,
    context: {
      sessionId: string;
      messageId?: string;
      partId: string;
    },
  ): void {
    const normalized = normalizeOpenCodeToolPart(
      toolPart,
      context,
      this.knownMcpServerNames,
    );

    this.trackActiveWorkflowSkill(toolPart, context.sessionId);

    if (isOpenCodeQuestionTool(normalized.toolName)) {
      this.registerQuestionToolRequest(toolPart, context, normalized.status);
      return;
    }

    const eventKey = buildOpenCodeToolEventKey({
      sessionId: context.sessionId,
      messageId: context.messageId,
      toolCallId: normalized.toolCallId,
    });

    // Capture the final activity summary before the terminal status disarms
    // the watchdog, so the settled spawn row keeps its receipt.
    const terminalSubagentActivity = this.captureTerminalSubagentActivity(
      eventKey,
      toolPart,
      normalized,
    );

    this.updateSubagentWatchdogForToolPart(eventKey, toolPart, normalized, {
      sessionId: context.sessionId,
      messageId: context.messageId,
    });

    if (isOpenCodeTodoWriteTool(normalized.toolName)) {
      this.stopExecuteToolProgress(eventKey);
      const entries = extractOpenCodeTodoEntries(normalized);

      if (entries !== null) {
        const planKey = `${eventKey}:${JSON.stringify(entries)}`;

        if (!this.emittedTodoPlanKeys.has(planKey)) {
          this.emittedTodoPlanKeys.add(planKey);
          this.runtimeEvents.plan({
            sessionId: context.sessionId,
            messageId: context.messageId,
            toolCallId: normalized.toolCallId,
            entries,
          });
        }
      }

      return;
    }

    if (
      !this.emittedToolCallKeys.has(eventKey) &&
      hasMeaningfulOpenCodeToolCallDetails(normalized)
    ) {
      this.emittedToolCallKeys.add(eventKey);
      this.runtimeEvents.toolCall({
        sessionId: context.sessionId,
        messageId: context.messageId,
        toolCallId: normalized.toolCallId,
        title: normalized.title,
        status: normalized.status,
        payload: normalized.callPayload,
        contentText: normalized.contentText,
      });
    }

    this.updateExecuteToolProgress(eventKey, normalized, {
      sessionId: context.sessionId,
      messageId: context.messageId,
    });

    this.runtimeEvents.toolUpdate({
      sessionId: context.sessionId,
      messageId: context.messageId,
      toolCallId: normalized.toolCallId,
      toolName: normalized.toolName,
      status: normalized.status,
      output: normalized.output.length > 0 ? normalized.output : undefined,
      error: normalized.error,
      payload: terminalSubagentActivity
        ? {
            ...normalized.updatePayload,
            subagentActivity: terminalSubagentActivity,
          }
        : normalized.updatePayload,
    });

    if (
      isTerminalOpenCodeToolStatus(normalized.status) &&
      !this.persistedToolResultKeys.has(eventKey)
    ) {
      this.persistedToolResultKeys.add(eventKey);
      this.runtimeEvents.toolResult({
        sessionId: context.sessionId,
        messageId: context.messageId,
        toolCallId: normalized.toolCallId,
        status: normalized.status,
        output: normalized.output,
        // Persist the activity receipt so the settled subagent row survives
        // transcript refetch and page reloads, not just the live socket.
        payload: terminalSubagentActivity
          ? {
              ...normalized.resultPayload,
              subagentActivity: terminalSubagentActivity,
            }
          : normalized.resultPayload,
      });
    }
  }

  private registerQuestionToolRequest(
    toolPart: OpenCodeToolPart,
    context: {
      sessionId: string;
      messageId?: string;
      partId: string;
    },
    status: AcpToolStatus,
  ): void {
    if (isTerminalOpenCodeToolStatus(status)) {
      return;
    }

    const request = extractOpenCodeQuestionToolRequest(toolPart, context);

    if (!request) {
      return;
    }

    const existing = this.pendingUserInputRequests.get(request.requestId);

    if (existing && areOpenCodeQuestionRequestsEqual(existing, request)) {
      return;
    }

    const pendingRequest = {
      ...request,
      ts: this.runtimeEvents.nextTs(),
    };

    this.pendingUserInputRequests.set(request.requestId, pendingRequest);
    this.runtimeEvents.requestUserInput(pendingRequest);
  }

  private handleSubtaskPartUpdated(
    subtaskPart: OpenCodeSubtaskPart,
    context: {
      sessionId: string;
      messageId?: string;
      partId: string;
    },
  ): void {
    const normalized = normalizeOpenCodeSubtaskPart(subtaskPart, context);
    const eventKey = buildOpenCodeToolEventKey({
      sessionId: context.sessionId,
      messageId: context.messageId,
      toolCallId: normalized.toolCallId,
    });

    // Subtask parts do not carry a status today (they stay "in_progress"), but
    // read one defensively so a future terminal update disarms the watchdog.
    const rawSubtaskStatus = asString(
      asRecord(asRecord(subtaskPart)?.state)?.status,
    );

    if (
      isTerminalOpenCodeToolStatus(
        normalizeOpenCodeToolStatus(rawSubtaskStatus),
      )
    ) {
      this.stopSubagentWatchdog(eventKey);
    } else if (normalized.callPayload.isSubagentSpawn === true) {
      this.startSubagentWatchdog(eventKey, {
        sessionId: context.sessionId,
        messageId: context.messageId,
        toolCallId: normalized.toolCallId,
        title: normalized.title,
        agentType: asString(normalized.callPayload.agentType) ?? null,
        childSessionId: null,
        background: false,
        updatePayload: normalized.callPayload,
      });
    }

    if (this.emittedToolCallKeys.has(eventKey)) {
      return;
    }

    this.emittedToolCallKeys.add(eventKey);
    this.runtimeEvents.toolCall({
      sessionId: context.sessionId,
      messageId: context.messageId,
      toolCallId: normalized.toolCallId,
      title: normalized.title,
      status: normalized.status,
      payload: normalized.callPayload,
      contentText: normalized.contentText,
    });
  }

  private async handleMessageUpdated(
    payload: OpenCodeEventPayload,
  ): Promise<void> {
    const info = asRecord(asRecord(payload.properties)?.info) as
      | (OpenCodeMessageInfo & Record<string, unknown>)
      | null;

    if (!info || !info.id) {
      return;
    }

    const role = parseOpenCodeMessageRole(info.role);

    if (role) {
      this.messageRoleById.set(info.id, role);
    }

    if (role !== 'assistant') {
      return;
    }

    if (info.sessionID && !this.sessionId) {
      this.sessionId = info.sessionID;
    }

    if (!info.time?.completed) {
      return;
    }

    if (this.suppressAssistantOutputUntilNextPrompt) {
      // Post-cancel finalize of the aborted message; the cancel flush already
      // persisted its content (and persistedMessageIds makes this a no-op for
      // that id anyway — this also covers messages created after the abort).
      return;
    }

    await this.finalizeAssistantMessage(info.id);
  }

  private async finishCurrentTurn(): Promise<void> {
    if (!this.inFlight && !this.prompts.hasQueuedMessages()) {
      return;
    }

    const finalized =
      (await this.finalizeLatestAssistantMessage()) ??
      this.finalizedAssistantTurn;
    const sessionId = this.sessionId;

    this.inFlight = false;
    this.finalizedAssistantTurn = null;
    this.clearAllExecuteToolProgress({ keepBackgroundWatchdogs: true });

    if (sessionId) {
      const stopDecision = this.evaluateSlackStopHook(sessionId);

      if (stopDecision.blocked) {
        const reason =
          stopDecision.reason ?? FALLBACK_OPENCODE_STOP_HOOK_REMINDER;

        if (this.stopHookReminderCount >= MAX_OPENCODE_STOP_HOOK_REMINDERS) {
          // Give up gracefully: complete the turn without a Slack closeout
          // instead of aborting the task.
          this.logger.warn(
            `OpenCode Slack closeout hook still blocked after ${MAX_OPENCODE_STOP_HOOK_REMINDERS} reminders; completing the turn without a Slack closeout reason=${reason}`,
          );
        } else {
          this.stopHookReminderCount += 1;
          await this.submitPrompt({
            text: reason,
            visibleInTranscript: false,
            source: 'opencode-stop-hook',
          });
          // We now await a fresh turn to re-enter this method. Arm a fail-safe
          // so a session that never produces that turn (wedged after the
          // reminder) still reaches a terminal state instead of hanging.
          this.armStopHookReminderStall(sessionId);
          return;
        }
      }

      this.stopHookReminderCount = 0;

      if (finalized?.text.trim()) {
        this.runtimeEvents.turnCompleted(sessionId, finalized.text);
      }

      this.runtimeEvents.taskCompleted(sessionId, finalized?.tokenUsage);
    }

    await this.drainQueuedPrompts();
  }

  private armStopHookReminderStall(sessionId: string): void {
    this.clearStopHookReminderStall();
    const timer = setTimeout(() => {
      void this.handleStopHookReminderStall(sessionId);
    }, this.stopHookReminderStallTimeoutMs);
    timer.unref?.();
    this.stopHookReminderStallTimer = timer;
  }

  private clearStopHookReminderStall(): void {
    if (this.stopHookReminderStallTimer) {
      clearTimeout(this.stopHookReminderStallTimer);
      this.stopHookReminderStallTimer = null;
    }
  }

  /**
   * Fires when a resubmitted stop-hook reminder produced no follow-up turn
   * within the deadline: the OpenCode session is presumed wedged. Force the
   * turn to a terminal state (mirroring the reminder give-up branch) so the
   * job completes instead of hanging "running" forever while the sandbox keeps
   * heart-beating. Any normal turn re-entry or teardown disarms this first, so
   * reaching here always means a genuine silence.
   */
  private async handleStopHookReminderStall(sessionId: string): Promise<void> {
    this.clearStopHookReminderStall();

    if (this.disposed) {
      return;
    }

    this.logger.warn(
      `OpenCode stop-hook reminder produced no follow-up turn within ${this.stopHookReminderStallTimeoutMs}ms; the session appears wedged. Force-completing the turn so the task reaches a terminal state.`,
    );

    this.inFlight = false;
    this.stopHookReminderCount = 0;
    this.runtimeEvents.taskCompleted(sessionId, undefined);

    await this.drainQueuedPrompts();
  }

  private async finalizeAssistantMessage(
    messageId: string,
  ): Promise<FinalizedAssistantTurn | null> {
    const sessionId = this.sessionId;

    if (!sessionId || this.persistedMessageIds.has(messageId)) {
      return null;
    }

    const message = await this.client.message({
      sessionId,
      messageId,
      signal: this.eventAbortController.signal,
    });

    return this.persistAssistantMessage(message);
  }

  private async finalizeLatestAssistantMessage(): Promise<FinalizedAssistantTurn | null> {
    const sessionId = this.sessionId;

    if (!sessionId) {
      return null;
    }

    const messages = await this.client.messages({
      sessionId,
      limit: 20,
      signal: this.eventAbortController.signal,
    });
    const latestAssistantMessage = [...messages]
      .reverse()
      .find(
        (message) =>
          message.info.role === 'assistant' &&
          Boolean(message.info.time?.completed) &&
          !this.persistedMessageIds.has(message.info.id),
      );

    if (!latestAssistantMessage) {
      return null;
    }

    return this.persistAssistantMessage(latestAssistantMessage);
  }

  private persistAssistantMessage(
    message: OpenCodeSessionMessage,
  ): FinalizedAssistantTurn {
    const text = extractAssistantText(message);
    const tokenUsage = createTokenUsage(message.info);
    const finalized = {
      messageId: message.info.id,
      text,
      tokenUsage,
    };

    this.persistedMessageIds.add(message.info.id);
    // Persist the turn's reasoning as one consolidated thought (before the
    // answer) so the transcript renders a single reasoning block, matching the
    // Codex path. Streamed `assistantThoughtChunk` events stay live-only.
    const reasoning = extractAssistantReasoning(message);
    if (reasoning.length > 0) {
      this.runtimeEvents.assistantThought({
        sessionId: message.info.sessionID,
        messageId: message.info.id,
        text: reasoning,
        hadDelta: this.streamedReasoningMessageIds.has(message.info.id),
      });
    }
    this.runtimeEvents.assistantMessage({
      sessionId: message.info.sessionID,
      messageId: message.info.id,
      text,
      hadDelta: this.streamedMessageIds.has(message.info.id),
    });
    this.runtimeEvents.usageUpdate({
      sessionId: message.info.sessionID,
      messageId: message.info.id,
      used: Number(tokenUsage.totalTokens ?? 0),
      size: 400_000,
    });
    this.emit(
      'runtimeInferenceUsage',
      createInferenceUsageEvent(message.info, tokenUsage),
    );
    this.finalizedAssistantTurn = finalized;

    return finalized;
  }

  private scheduleQueuedPromptRetry(): void {
    if (this.queuedPromptRetryTimer || this.disposed) {
      return;
    }

    this.logger.info(
      `Retrying blocked queued prompt delivery in ${this.queuedPromptRetryDelayMs}ms`,
    );

    this.queuedPromptRetryTimer = setTimeout(() => {
      this.queuedPromptRetryTimer = null;
      void this.drainQueuedPrompts().catch((error: unknown) => {
        this.logger.error(
          `Failed to retry blocked queued prompt delivery: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, this.queuedPromptRetryDelayMs);
  }

  private clearQueuedPromptRetryTimer(): void {
    if (!this.queuedPromptRetryTimer) {
      return;
    }

    clearTimeout(this.queuedPromptRetryTimer);
    this.queuedPromptRetryTimer = null;
  }

  private async drainQueuedPrompts(): Promise<void> {
    if (this.inFlight || this.disposed) {
      return;
    }

    const next = this.prompts.dequeue();

    if (!next) {
      return;
    }

    const shouldDeliver = await this.prepareQueuedPrompt(next);

    if (!shouldDeliver) {
      return;
    }

    const sessionId = await this.ensureSession(next.text);
    this.currentWorkflowPhase = next.workflowPhase ?? this.currentWorkflowPhase;
    this.runtimeEvents.userPrompt({
      sessionId,
      text: next.text,
      images: next.images,
      visibleInTranscript: next.visibleInTranscript,
      userId: next.userId,
      userName: next.userName,
      userImageUrl: next.userImageUrl,
      clientMessageId: next.clientMessageId,
    });
    await this.submitPrompt({
      text: next.text,
      images: next.images,
      workflowPhase: next.workflowPhase,
      visibleInTranscript: next.visibleInTranscript,
      userId: next.userId,
      userName: next.userName,
      userImageUrl: next.userImageUrl,
      clientMessageId: next.clientMessageId,
    });
  }

  private async prepareQueuedPrompt(
    prompt: QueuedPromptMessageSnapshot,
  ): Promise<boolean> {
    if (!this.beforeQueuedPrompt) {
      return true;
    }

    const result = await this.beforeQueuedPrompt({ userId: prompt.userId });

    if (!result) {
      return true;
    }

    if (result.shouldSkipPrompt) {
      // The prompt's sender is not the run's server-side acting user, so its
      // content must not run. Drop it (no restore) and keep draining the
      // rest of the queue; the sender was asked to resend.
      this.logger.warn(
        `OpenCode queued prompt skipped before delivery reason=${
          result.reason ?? 'unknown'
        }`,
      );
      this.scheduleQueuedPromptRetry();
      return false;
    }

    if (result.shouldBlockPrompt) {
      this.prompts.restore([prompt, ...this.prompts.snapshot()], {
        emitUpdate: true,
      });
      this.logger.warn(
        `OpenCode queued prompt blocked before delivery reason=${
          result.reason ?? 'unknown'
        }`,
      );
      // Blocking is usually transient (e.g. the session/MCP is momentarily
      // busy). Schedule a delivery retry so the prompt drains on its own,
      // matching the Codex path instead of waiting for the next user message.
      this.scheduleQueuedPromptRetry();
      return false;
    }

    if (result.shouldReconnect) {
      this.prompts.restore([prompt, ...this.prompts.snapshot()], {
        emitUpdate: true,
      });
      this.emit('restartRequested', {
        reason:
          result.reason ?? 'OpenCode queued prompt requested MCP reconnect',
        sessionId: this.sessionId,
      });
      return false;
    }

    return true;
  }
}
