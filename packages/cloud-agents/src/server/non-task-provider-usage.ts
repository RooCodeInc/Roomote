import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createOpencodeClient,
  type PermissionRuleset,
} from '@opencode-ai/sdk/v2/client';
import {
  recordLlmUsage,
  resolveEffectiveModelRuntimeEnv,
} from '@roomote/db/server';
import {
  toBedrockMantleRuntimeModelId,
  type ReasoningEffort,
} from '@roomote/types';
import type { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import {
  DEFAULT_OPENCODE_SDK_SERVER_START_TIMEOUT_MS,
  leaseOpenCodeSdkServer,
  NON_TASK_TOOL_PERMISSION_DENIALS,
  readOpenCodeDebugConfig,
} from './opencode-runtime';

const DEFAULT_OPENCODE_STRUCTURED_OUTPUT_RETRY_COUNT = 2;
const NON_TASK_SESSION_ABORT_TIMEOUT_MS = 5_000;
const NON_TASK_USAGE_EVENT_BARRIER_TIMEOUT_MS = 1_000;
const NON_TASK_USAGE_RECONCILE_TIMEOUT_MS = 5_000;
type NonTaskModelRuntimeEnv = Partial<Record<string, string | undefined>>;

/**
 * Ordinary non-task sessions produce text or structured output only; no tool
 * may run by default. Fast explicitly opts into its isolated native-tool
 * directory and allowlist through generateTrackedNonTaskTextInOpenCodeSession.
 * The leased servers already deny built-in tools via their config
 * (`withDeniedToolPermissions` in opencode-runtime), and this per-session
 * ruleset keeps a stale or externally configured server
 * (`OPENCODE_SDK_SERVER_URL`) equally locked down.
 *
 * Enumerated per tool rather than a `*` wildcard: a wildcard rule also
 * strips the internal mechanism OpenCode uses for `format: json_schema`
 * structured output, breaking every structured routing call.
 */
const NON_TASK_SESSION_PERMISSIONS: PermissionRuleset = Object.keys(
  NON_TASK_TOOL_PERMISSION_DENIALS,
).map((permission) => ({ permission, pattern: '*', action: 'deny' }));

export const FAST_AGENT_SESSION_PERMISSIONS: PermissionRuleset = Object.keys(
  NON_TASK_TOOL_PERMISSION_DENIALS,
).map((permission) => ({
  permission,
  pattern: '*',
  action: permission === 'task' ? 'ask' : 'deny',
}));

/**
 * Default per-prompt tool filter: disable every registered tool — including MCP or
 * plugin tools an externally configured server (`OPENCODE_SDK_SERVER_URL`)
 * may define, which the enumerated permission denials cannot name — except
 * OpenCode's internal `StructuredOutput` tool, which fulfils
 * `format: json_schema`.
 *
 * The exact-name exception is deliberate: the `*` glob alone also removes
 * `StructuredOutput` and breaks structured calls. If a future OpenCode
 * release renames that internal tool, structured calls fail loudly ("Model
 * did not produce structured output") rather than any tool becoming
 * executable — this filter fails closed. Fast supplies a separate explicit
 * allowlist containing only its loopback bridge tools.
 */
const NON_TASK_SESSION_TOOL_DISABLES: Record<string, boolean> = {
  '*': false,
  StructuredOutput: true,
};

let nonTaskSessionDirectory: string | undefined;

/**
 * Sessions run in an empty scratch directory instead of the service's own
 * working directory (the deployment's application code), so even a tool that
 * slips past the permission layers has nothing to read or write, and OpenCode
 * skips indexing the whole repository for a title-generation call.
 */
function resolveNonTaskSessionDirectory(): string {
  nonTaskSessionDirectory ??= mkdtempSync(join(tmpdir(), 'roomote-non-task-'));
  return nonTaskSessionDirectory;
}

export type NonTaskInferenceTrackingInput = {
  surface: string;
  userId?: string | null;
  taskId?: string | null;
  fastConversationId?: string | null;
  provider?: string;
};

export const NON_TASK_INFERENCE_SURFACES = {
  brainSynthesis: 'brain_synthesis',
  chatAudioTranscription: 'chat_audio_transcription',
  chatVideoDescription: 'chat_video_description',
  customAutomationScheduleResolution: 'custom_automation_schedule_resolution',
  fastAgentQuestionAnswering: 'fast_agent',
  inferenceValidation: 'inference_validation',
  prReviewNotificationTriage: 'pr_review_notification_triage',
  routerChannelLaunchGate: 'router_channel_launch_gate',
  routerDiscordForumTag: 'router_discord_forum_tag',
  routerFollowupClassification: 'router_followup_classification',
  routerGitHubRouting: 'router_github_routing',
  routerTaskRouting: 'router_task_routing',
  routerRequestedWorkKind: 'router_requested_work_kind',
  slackQuestionChannelSuggestions: 'slack_question_channel_suggestions',
  taskSummaryGeneration: 'task_summary_generation',
  taskTitleGeneration: 'task_title_generation',
} as const;

const NON_TASK_INFERENCE_VALIDATION_TIMEOUT_MS = 15_000;

export type NonTaskInferenceValidationFailureReason =
  | 'content_filter'
  | 'endpoint_unreachable'
  | 'gateway_blocked'
  | 'insufficient_credits'
  | 'invalid_credentials'
  | 'model_unavailable'
  | 'provider_error'
  | 'rate_limited'
  | 'timeout';

export type NonTaskInferenceValidationResult =
  | {
      success: true;
      checkedAt: string;
      latencyMs: number;
      model: string;
    }
  | {
      success: false;
      checkedAt: string;
      latencyMs: number;
      message: string;
      model: string;
      reason: NonTaskInferenceValidationFailureReason;
      retryable: boolean;
    };

interface GenerateTrackedNonTaskBaseParams extends NonTaskInferenceTrackingInput {
  prompt: string;
  system?: string;
  model?: string;
  modelRole?: 'primary' | 'small' | 'orchestration';
  /** Explicit reasoning-effort override applied to the resolved model. */
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
  /** null lets OpenCode own the prompt lifecycle without a Roomote deadline. */
  timeoutMs?: number | null;
  /**
   * OpenCode retries some provider failures internally before the prompt
   * request settles. Long-running, user-visible callers such as Fast Mode can
   * subscribe to those retry transitions instead of appearing hung until the
   * outer timeout fires.
   */
  onProviderRetry?: (event: NonTaskProviderRetryEvent) => void | Promise<void>;
  /** Stop OpenCode's own provider retry loop at this attempt count. */
  maxProviderRetryAttempts?: number;
}

export type NonTaskProviderRetryEvent = {
  attempt: number;
  message: string;
  nextRetryAtMs?: number;
};

export interface GenerateTrackedNonTaskTextParams extends GenerateTrackedNonTaskBaseParams {
  files?: NonTaskPromptFile[];
  requiredInputModality?: NonTaskInputModality;
}

export type NonTaskInputModality = 'audio' | 'image' | 'video' | 'pdf';

export type NonTaskPromptFile = {
  mime: string;
  filename?: string;
  url: string;
};

export class NonTaskInputModalityUnsupportedError extends Error {
  constructor(public readonly modality: NonTaskInputModality) {
    super(`No configured model supports ${modality} input and text output.`);
    this.name = 'NonTaskInputModalityUnsupportedError';
  }
}

export interface GenerateTrackedNonTaskObjectParams<
  TSchema extends z.ZodTypeAny,
> extends GenerateTrackedNonTaskBaseParams {
  schema: TSchema;
}

/**
 * An intentionally in-memory reference to an OpenCode conversation. Callers
 * may reuse it while their process is warm, but must be able to bootstrap a
 * replacement when the helper server no longer recognizes the id.
 */
export type NonTaskOpenCodeSession = {
  id?: string;
};

export type NonTaskOpenCodeCompletedMessage = {
  id: string | null;
  sessionId: string;
  createdAtMs: number | null;
  completedAtMs: number | null;
};

export type NonTaskOpenCodeNativeSessionOptions = {
  directory: string;
  env?: Partial<Record<string, string>>;
  onModelResolved?: (model: string) => void;
  onMessageCompleted?: (
    message: NonTaskOpenCodeCompletedMessage,
  ) => Promise<void> | void;
  onPermissionAsked?: (request: {
    permission: string;
    sessionId: string;
  }) =>
    | Promise<{ reply: 'once' | 'reject'; message?: string }>
    | { reply: 'once' | 'reject'; message?: string };
  onPromptStarted?: () => void;
  onSessionReady?: (sessionID: string) => Promise<void> | void;
  onSubagentSessionReady?: (sessionID: string) => Promise<void> | void;
  permission?: PermissionRuleset;
  promptOnlySubagents?: boolean;
  signal?: AbortSignal;
  trackSessionTreeUsage?: boolean;
  tools: Record<string, boolean>;
  validateSession?: boolean;
};

export class NonTaskOpenCodeSessionNotFoundError extends Error {
  constructor() {
    super('The OpenCode session is no longer available.');
    this.name = 'NonTaskOpenCodeSessionNotFoundError';
  }
}

export class NonTaskOpenCodeSessionValidationError extends Error {
  constructor(error: unknown) {
    super(
      `OpenCode session validation failed: ${formatOpenCodeSdkError(error)}`,
      {
        cause: error,
      },
    );
    this.name = 'NonTaskOpenCodeSessionValidationError';
  }
}

export class NonTaskOpenCodePromptError extends Error {
  constructor(
    public readonly providerError: unknown,
    label: string,
  ) {
    super(`${label}: ${formatOpenCodeSdkError(providerError)}`, {
      cause: providerError,
    });
    this.name = 'NonTaskOpenCodePromptError';
  }
}

export class NonTaskOpenCodePromptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out waiting for OpenCode output after ${timeoutMs}ms.`);
    this.name = 'NonTaskOpenCodePromptTimeoutError';
  }
}

export function isNonTaskOpenCodePromptTimeoutError(
  error: unknown,
): error is NonTaskOpenCodePromptTimeoutError {
  return error instanceof NonTaskOpenCodePromptTimeoutError;
}

export function isNonTaskOpenCodeSessionNotFoundError(
  error: unknown,
): error is NonTaskOpenCodeSessionNotFoundError {
  return error instanceof NonTaskOpenCodeSessionNotFoundError;
}

export function isNonTaskOpenCodeSessionValidationError(
  error: unknown,
): error is NonTaskOpenCodeSessionValidationError {
  return error instanceof NonTaskOpenCodeSessionValidationError;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function openCodeTimestampToDate(value: unknown): Date | undefined {
  const timestamp = asFiniteNumber(value);
  if (timestamp === undefined) return undefined;

  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

type NonTaskOpenCodeMessageInfo = {
  id?: unknown;
  sessionID?: unknown;
  parentID?: unknown;
  providerID?: unknown;
  modelID?: unknown;
  agent?: unknown;
  mode?: unknown;
  cost?: unknown;
  error?: unknown;
  structured?: unknown;
  time?: {
    created?: unknown;
    completed?: unknown;
  };
  tokens?: {
    input?: unknown;
    output?: unknown;
    reasoning?: unknown;
    cache?: {
      read?: unknown;
      write?: unknown;
    };
  };
};

async function recordNonTaskOpenCodeUsage(
  params: GenerateTrackedNonTaskBaseParams,
  resolvedModel: string,
  info: NonTaskOpenCodeMessageInfo,
): Promise<void> {
  const harnessSessionId = asString(info.sessionID);
  const messageId = asString(info.id);
  if (!harnessSessionId || !messageId) return;

  const inputTokens = asFiniteNumber(info.tokens?.input) ?? 0;
  const outputTokens = asFiniteNumber(info.tokens?.output) ?? 0;
  const reasoningTokens = asFiniteNumber(info.tokens?.reasoning) ?? 0;
  const cacheReadTokens = asFiniteNumber(info.tokens?.cache?.read) ?? 0;
  const cacheWriteTokens = asFiniteNumber(info.tokens?.cache?.write) ?? 0;
  const costUsd = asFiniteNumber(info.cost);
  const fallbackModel = splitOpenCodeModelId(resolvedModel);

  try {
    await recordLlmUsage({
      source: params.surface,
      usageType: 'inference',
      eventKey: `non-task:${params.surface}:${harnessSessionId}:${messageId}`,
      taskId: params.taskId ?? null,
      ...(params.fastConversationId
        ? { fastConversationId: params.fastConversationId }
        : {}),
      userId: params.userId ?? null,
      harnessSessionId,
      messageId,
      providerId:
        asString(info.providerID) ??
        asString(params.provider) ??
        fallbackModel.providerID,
      modelId: asString(info.modelID) ?? fallbackModel.modelID,
      agent: asString(info.agent) ?? asString(info.mode) ?? null,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens:
        inputTokens +
        outputTokens +
        reasoningTokens +
        cacheReadTokens +
        cacheWriteTokens,
      contextTokens: inputTokens + cacheReadTokens,
      costMicroUsd:
        costUsd === undefined
          ? 0
          : Math.max(0, Math.round(costUsd * 1_000_000)),
      costSource: costUsd === undefined ? 'missing' : 'opencode_message',
      messageCreatedAt: openCodeTimestampToDate(info.time?.created),
      messageCompletedAt: openCodeTimestampToDate(info.time?.completed),
      details: { surface: params.surface },
    });
  } catch (error) {
    console.warn(
      `[NonTaskProviderUsage] Failed to record usage for ${params.surface}: ${formatOpenCodeSdkError(error)}`,
    );
  }
}

function parseOpenCodeConfigJson(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OpenCode config must be a JSON object.');
  }

  return parsed as Record<string, unknown>;
}

export function resolveOpenCodeSmallModel(): string | undefined {
  const configuredSmallModel = process.env.R_SMALL_MODEL?.trim();
  const configuredModel = process.env.R_MODEL?.trim();

  if (configuredSmallModel || configuredModel) {
    return configuredSmallModel || configuredModel;
  }

  const config = parseOpenCodeConfigJson(readOpenCodeDebugConfig());

  return asString(config.small_model) ?? asString(config.model);
}

function splitOpenCodeModelId(model: string): {
  providerID: string;
  modelID: string;
} {
  const separatorIndex = model.indexOf('/');

  if (separatorIndex <= 0 || separatorIndex === model.length - 1) {
    throw new Error(
      `OpenCode model must use provider/model format for structured calls. Received "${model}".`,
    );
  }

  return {
    providerID: model.slice(0, separatorIndex),
    modelID: model.slice(separatorIndex + 1),
  };
}

function buildRequestInitForOpenCodeSdkFetch(
  request: Request,
): RequestInit & { duplex?: 'half' } {
  const init: RequestInit & { duplex?: 'half' } = {
    body: request.body,
    headers: request.headers,
    method: request.method,
    redirect: request.redirect,
    signal: request.signal,
  };

  if (request.body) {
    init.duplex = 'half';
  }

  return init;
}

export function createOpenCodeSdkFetch(
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (input instanceof Request) {
      return fetchImpl(
        input.url,
        init ?? buildRequestInitForOpenCodeSdkFetch(input),
      );
    }

    return fetchImpl(input, init);
  };
}

const openCodeSdkFetch = createOpenCodeSdkFetch();

function buildOpenCodePrompt(params: {
  system?: string;
  prompt: string;
  maxOutputTokens?: number;
}): string {
  return [
    params.system?.trim(),
    params.maxOutputTokens
      ? `Keep the response under roughly ${params.maxOutputTokens} output tokens.`
      : undefined,
    params.prompt.trim(),
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
}

function formatOpenCodeSdkError(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return String(error);
  }

  const record = error as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name : undefined;
  const data = record.data;

  if (data && typeof data === 'object') {
    const dataRecord = data as Record<string, unknown>;
    const message =
      typeof dataRecord.message === 'string' ? dataRecord.message : undefined;

    if (message) {
      return name ? `${name}: ${message}` : message;
    }
  }

  const message = typeof record.message === 'string' ? record.message : null;

  if (message) {
    return name ? `${name}: ${message}` : message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isOpenCodeSessionMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const record = error as Record<string, unknown>;
  const data =
    record.data && typeof record.data === 'object'
      ? (record.data as Record<string, unknown>)
      : undefined;
  const statusCode =
    typeof data?.statusCode === 'number'
      ? data.statusCode
      : typeof record.status === 'number'
        ? record.status
        : undefined;

  return statusCode === 404 || record.name === 'NotFoundError';
}

function isOpenCodeSessionInvalid(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const data =
    record.data && typeof record.data === 'object'
      ? (record.data as Record<string, unknown>)
      : undefined;
  const statusCode =
    typeof data?.statusCode === 'number'
      ? data.statusCode
      : typeof record.status === 'number'
        ? record.status
        : undefined;
  if (statusCode !== 400 && statusCode !== 422) return false;
  const detail = formatOpenCodeSdkError(error).toLowerCase();
  return (
    detail.includes('session') &&
    ['invalid', 'malformed', 'corrupt'].some((term) => detail.includes(term))
  );
}

async function resolveNonTaskModelRuntime(
  model?: string,
  modelRole: 'primary' | 'small' | 'orchestration' = 'small',
  reasoningEffort?: ReasoningEffort,
): Promise<{
  model: string;
  resolvedModelRuntimeEnv: NonTaskModelRuntimeEnv;
}> {
  const requestedModel = model?.trim();
  let resolvedModelRuntimeEnv: NonTaskModelRuntimeEnv = {};

  try {
    resolvedModelRuntimeEnv = await resolveEffectiveModelRuntimeEnv();
  } catch (error) {
    if (!requestedModel) {
      throw error;
    }

    console.warn(
      `[NonTaskProviderUsage] Could not resolve deployment model env for explicit model ${requestedModel}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const resolvedModel =
    requestedModel ||
    (modelRole === 'orchestration'
      ? resolvedModelRuntimeEnv.R_ORCHESTRATION_MODEL ||
        resolvedModelRuntimeEnv.R_MODEL
      : modelRole === 'primary'
        ? resolvedModelRuntimeEnv.R_MODEL
        : resolvedModelRuntimeEnv.R_SMALL_MODEL ||
          resolvedModelRuntimeEnv.R_MODEL) ||
    (modelRole === 'primary' || modelRole === 'orchestration'
      ? asString(parseOpenCodeConfigJson(readOpenCodeDebugConfig()).model)
      : resolveOpenCodeSmallModel());

  if (!resolvedModel) {
    throw new Error(
      'Model configuration is required for non-task model calls. Set R_MODEL to a provider/model ID.',
    );
  }

  let selectedRuntimeEnv = resolvedModelRuntimeEnv;

  if (
    requestedModel ||
    (modelRole === 'orchestration' &&
      (resolvedModelRuntimeEnv.R_ORCHESTRATION_MODEL ||
        resolvedModelRuntimeEnv.R_ORCHESTRATION_MODEL_REASONING_EFFORT))
  ) {
    selectedRuntimeEnv = {
      ...resolvedModelRuntimeEnv,
      R_MODEL: resolvedModel,
    };

    if (modelRole === 'orchestration') {
      const orchestrationReasoningEffort =
        resolvedModelRuntimeEnv.R_ORCHESTRATION_MODEL_REASONING_EFFORT;

      if (orchestrationReasoningEffort) {
        selectedRuntimeEnv.R_MODEL_REASONING_EFFORT =
          orchestrationReasoningEffort;
      } else {
        selectedRuntimeEnv.R_MODEL_REASONING_EFFORT = undefined;
      }
    }
  }

  if (reasoningEffort) {
    // The lease cache keys on env, so an explicit effort gets its own server
    // rather than mutating a shared lease.
    selectedRuntimeEnv = {
      ...selectedRuntimeEnv,
      R_MODEL_REASONING_EFFORT: reasoningEffort,
    };
  }

  return {
    // The prompt must address the same runtime provider id the helper
    // server's config registered (Bedrock Mantle GPT ids run under
    // `bedrock-mantle-openai`), mirroring the task worker's rewrite.
    model: toBedrockMantleRuntimeModelId(resolvedModel),
    // An explicit model rides into the server lease env as the primary role
    // model so the config builder registers its provider — the deployment's
    // role models may not include it, and an unregistered Bedrock (or
    // OpenAI-compatible) id fails with ProviderModelNotFoundError before any
    // request is made. The lease cache keys on env, so distinct explicit
    // models get their own servers instead of colliding.
    resolvedModelRuntimeEnv: selectedRuntimeEnv,
  };
}

/**
 * Options passed to `client.session.prompt` on top of the shared session/model
 * wiring the helper supplies (`sessionID`, `directory`, `model`). Callers
 * provide the request-specific fields: `system`, `parts`, and, for structured
 * calls, `format`.
 */
type NonTaskSdkPromptOptions = {
  system?: string;
  format?: {
    type: 'json_schema';
    schema: Record<string, unknown>;
    retryCount: number;
  };
  tools?: Record<string, boolean>;
  parts: Array<
    | { type: 'text'; text: string }
    | {
        type: 'file';
        mime: string;
        filename?: string;
        url: string;
      }
  >;
};

async function resolveModelForInputModality(
  params: GenerateTrackedNonTaskTextParams,
  runtime: {
    model: string;
    resolvedModelRuntimeEnv: NonTaskModelRuntimeEnv;
  },
): Promise<string> {
  const modality = params.requiredInputModality;
  if (!modality) {
    return runtime.model;
  }

  const modalityModels =
    modality === 'image' || modality === 'video'
      ? [
          runtime.resolvedModelRuntimeEnv.R_VISION_MODEL,
          runtime.resolvedModelRuntimeEnv.R_SMALL_MODEL,
        ]
      : [
          runtime.resolvedModelRuntimeEnv.R_SMALL_MODEL,
          runtime.resolvedModelRuntimeEnv.R_VISION_MODEL,
        ];
  const candidates = [
    params.model,
    ...modalityModels,
    runtime.resolvedModelRuntimeEnv.R_MODEL,
    runtime.model,
  ]
    .map((candidate) =>
      candidate ? toBedrockMantleRuntimeModelId(candidate) : candidate,
    )
    .filter(
      (candidate, index, values): candidate is string =>
        Boolean(candidate) && values.indexOf(candidate) === index,
    );
  const timeoutMs = params.timeoutMs === undefined ? 120_000 : params.timeoutMs;
  const server = await leaseOpenCodeSdkServer({
    env: runtime.resolvedModelRuntimeEnv,
    startTimeoutMs:
      timeoutMs === null
        ? DEFAULT_OPENCODE_SDK_SERVER_START_TIMEOUT_MS
        : Math.min(timeoutMs, DEFAULT_OPENCODE_SDK_SERVER_START_TIMEOUT_MS),
  });

  try {
    const client = createOpencodeClient({
      baseUrl: server.url,
      fetch: openCodeSdkFetch,
    });
    const directory = resolveNonTaskSessionDirectory();
    const result = await client.config.providers({ directory });

    if (result.error || !result.data) {
      throw new Error(
        `OpenCode provider capability lookup failed: ${formatOpenCodeSdkError(result.error)}`,
      );
    }

    for (const candidate of candidates) {
      const { providerID, modelID } = splitOpenCodeModelId(candidate);
      const provider = result.data.providers.find(
        (item) => item.id === providerID,
      );
      const model = provider?.models[modelID];

      if (
        model?.capabilities.input[modality] &&
        model.capabilities.output.text
      ) {
        return candidate;
      }
    }
  } finally {
    server.release();
  }

  throw new NonTaskInputModalityUnsupportedError(modality);
}

/**
 * Shared OpenCode SDK plumbing for non-task inference: leases a managed SDK
 * server, wires the abort/timeout controller, creates a session, and issues the
 * prompt. Provider errors from either the event stream or prompt result are
 * normalized before returning, so callers receive the same structured cause
 * regardless of which transport settles first. Successful calls return the raw
 * prompt payload for structured-object extraction or plain-text joining.
 */
async function runNonTaskSdkPrompt(
  params: GenerateTrackedNonTaskBaseParams,
  runtime: {
    model: string;
    resolvedModelRuntimeEnv: NonTaskModelRuntimeEnv;
  },
  promptOptions: NonTaskSdkPromptOptions,
  options: {
    directory?: string;
    ephemeral?: boolean;
    env?: Partial<Record<string, string>>;
    onPromptStarted?: () => void;
    onMessageCompleted?: (
      message: NonTaskOpenCodeCompletedMessage,
    ) => Promise<void> | void;
    onPermissionAsked?: NonTaskOpenCodeNativeSessionOptions['onPermissionAsked'];
    onSessionReady?: (sessionID: string) => Promise<void> | void;
    onSubagentSessionReady?: (sessionID: string) => Promise<void> | void;
    permission?: PermissionRuleset;
    preserveReasoning?: boolean;
    promptOnlySubagents?: boolean;
    promptErrorLabel?: string;
    session?: NonTaskOpenCodeSession;
    signal?: AbortSignal;
    trackSessionTreeUsage?: boolean;
    useConfiguredServer?: boolean;
    validateSession?: boolean;
  } = {},
): Promise<{
  info: NonTaskOpenCodeMessageInfo;
  parts: Array<{ type?: unknown; text?: unknown }>;
}> {
  const { model, resolvedModelRuntimeEnv } = runtime;
  const timeoutMs = params.timeoutMs === undefined ? 120_000 : params.timeoutMs;
  const promptErrorLabel =
    options.promptErrorLabel ??
    `OpenCode structured prompt failed (model ${model})`;
  const sessionDirectory =
    options.directory ?? resolveNonTaskSessionDirectory();
  const server = await leaseOpenCodeSdkServer({
    env: { ...resolvedModelRuntimeEnv, ...options.env },
    ephemeral: options.ephemeral,
    preserveReasoning: options.preserveReasoning,
    promptOnlySubagents: options.promptOnlySubagents,
    startTimeoutMs:
      timeoutMs === null
        ? DEFAULT_OPENCODE_SDK_SERVER_START_TIMEOUT_MS
        : Math.min(timeoutMs, DEFAULT_OPENCODE_SDK_SERVER_START_TIMEOUT_MS),
    useConfiguredServer: options.useConfiguredServer,
  });
  const abortController = new AbortController();
  const timeout =
    timeoutMs === null
      ? undefined
      : setTimeout(() => {
          abortController.abort(
            new NonTaskOpenCodePromptTimeoutError(timeoutMs),
          );
        }, timeoutMs);
  const externalSignal = options.signal;
  const abortFromExternalSignal = () => {
    abortController.abort(
      externalSignal?.reason ?? new Error('The prompt was aborted.'),
    );
  };

  if (externalSignal?.aborted) {
    abortFromExternalSignal();
  } else {
    externalSignal?.addEventListener('abort', abortFromExternalSignal, {
      once: true,
    });
  }

  try {
    const client = createOpencodeClient({
      baseUrl: server.url,
      fetch: openCodeSdkFetch,
    });
    let sessionId = options.session?.id;
    const reusedSession = Boolean(sessionId);
    if (sessionId && options.validateSession) {
      const validationResult = await client.session.messages(
        {
          sessionID: sessionId,
          directory: sessionDirectory,
          limit: 1,
        },
        { signal: abortController.signal },
      );
      if (validationResult.error) {
        if (
          isOpenCodeSessionMissing(validationResult.error) ||
          isOpenCodeSessionInvalid(validationResult.error)
        ) {
          throw new NonTaskOpenCodeSessionNotFoundError();
        }
        throw new NonTaskOpenCodeSessionValidationError(validationResult.error);
      }
      if (!validationResult.data || validationResult.data.length === 0) {
        throw new NonTaskOpenCodeSessionNotFoundError();
      }
    }
    if (!sessionId) {
      const sessionResult = await client.session.create(
        {
          directory: sessionDirectory,
          title: `Roomote ${params.surface}`,
          permission: options.permission ?? NON_TASK_SESSION_PERMISSIONS,
        },
        { signal: abortController.signal },
      );

      if (sessionResult.error || !sessionResult.data) {
        throw new Error(
          `OpenCode structured session creation failed (model ${model}): ${formatOpenCodeSdkError(sessionResult.error)}`,
        );
      }

      sessionId = sessionResult.data.id;
      if (options.session) {
        options.session.id = sessionId;
      }
    }
    if (reusedSession && options.permission) {
      const updateResult = await client.session.update(
        {
          sessionID: sessionId,
          directory: sessionDirectory,
          permission: options.permission,
        },
        { signal: abortController.signal },
      );
      if (updateResult.error || !updateResult.data) {
        if (isOpenCodeSessionMissing(updateResult.error)) {
          throw new NonTaskOpenCodeSessionNotFoundError();
        }
        throw new NonTaskOpenCodeSessionValidationError(updateResult.error);
      }
    }
    await options.onSessionReady?.(sessionId);

    const trackedSessionIds = new Set([sessionId]);
    const sessionsCreatedThisTurn = new Set<string>();
    const usageRecordings = new Map<string, Promise<void>>();
    const observedUsageEventKeys = new Set<string>();
    const usageEventWaiters = new Map<string, () => void>();
    const getUsageKey = (info: NonTaskOpenCodeMessageInfo) => {
      const usageSessionId = asString(info.sessionID);
      const usageMessageId = asString(info.id);
      return usageSessionId && usageMessageId
        ? `${usageSessionId}:${usageMessageId}`
        : undefined;
    };
    const recordUsageOnce = (info: NonTaskOpenCodeMessageInfo) => {
      const usageKey = getUsageKey(info);
      if (!usageKey) {
        return recordNonTaskOpenCodeUsage(params, model, info);
      }

      const existing = usageRecordings.get(usageKey);
      if (existing) return existing;

      const recording = recordNonTaskOpenCodeUsage(params, model, info);
      usageRecordings.set(usageKey, recording);
      return recording;
    };
    const markUsageEventObserved = (info: NonTaskOpenCodeMessageInfo) => {
      const usageKey = getUsageKey(info);
      if (!usageKey) return;

      observedUsageEventKeys.add(usageKey);
      usageEventWaiters.get(usageKey)?.();
      usageEventWaiters.delete(usageKey);
    };
    const waitForUsageEvent = (info: NonTaskOpenCodeMessageInfo) => {
      const usageKey = getUsageKey(info);
      if (!usageKey || observedUsageEventKeys.has(usageKey)) {
        return Promise.resolve(true);
      }

      return new Promise<boolean>((resolve) => {
        usageEventWaiters.set(usageKey, () => resolve(true));
      });
    };

    const eventAbortController = new AbortController();
    const abortEventMonitor = () => {
      eventAbortController.abort(abortController.signal.reason);
    };
    if (abortController.signal.aborted) {
      abortEventMonitor();
    } else {
      abortController.signal.addEventListener('abort', abortEventMonitor, {
        once: true,
      });
    }
    let rejectSessionError: (error: unknown) => void = () => undefined;
    const sessionError = new Promise<never>((_resolve, reject) => {
      rejectSessionError = reject;
    });
    let eventMonitor: Promise<void> | undefined;
    const requiresReliableEventMonitor = Boolean(
      options.onPermissionAsked || options.onSubagentSessionReady,
    );
    const needsEventMonitor = Boolean(
      params.onProviderRetry ||
      options.onPermissionAsked ||
      options.onSubagentSessionReady ||
      options.trackSessionTreeUsage,
    );

    if (needsEventMonitor) {
      try {
        const subscription = await client.event.subscribe(
          { directory: sessionDirectory },
          { signal: eventAbortController.signal },
        );
        eventMonitor = (async () => {
          try {
            for await (const event of subscription.stream) {
              if (
                (event.type === 'session.created' ||
                  event.type === 'session.updated') &&
                event.properties.info.parentID === sessionId
              ) {
                trackedSessionIds.add(event.properties.sessionID);
                if (event.type === 'session.created') {
                  sessionsCreatedThisTurn.add(event.properties.sessionID);
                }
                try {
                  await options.onSubagentSessionReady?.(
                    event.properties.sessionID,
                  );
                } catch (error) {
                  rejectSessionError(error);
                  return;
                }
              } else if (
                options.trackSessionTreeUsage &&
                event.type === 'message.updated' &&
                event.properties.info.role === 'assistant' &&
                event.properties.info.time.completed !== undefined &&
                trackedSessionIds.has(event.properties.info.sessionID)
              ) {
                void recordUsageOnce(event.properties.info);
                markUsageEventObserved(event.properties.info);
              } else if (
                event.type === 'permission.asked' &&
                trackedSessionIds.has(event.properties.sessionID) &&
                options.onPermissionAsked
              ) {
                try {
                  const decision = await options.onPermissionAsked({
                    permission: event.properties.permission,
                    sessionId: event.properties.sessionID,
                  });
                  const permissionResult = await client.permission.reply(
                    {
                      requestID: event.properties.id,
                      directory: sessionDirectory,
                      reply: decision.reply,
                      ...(decision.message
                        ? { message: decision.message }
                        : {}),
                    },
                    { signal: abortController.signal },
                  );
                  if (permissionResult.error || !permissionResult.data) {
                    throw new Error(
                      `OpenCode permission reply failed: ${formatOpenCodeSdkError(permissionResult.error)}`,
                    );
                  }
                } catch (error) {
                  rejectSessionError(error);
                  return;
                }
              } else if (
                event.type === 'session.status' &&
                event.properties.sessionID === sessionId &&
                event.properties.status.type === 'retry'
              ) {
                try {
                  await params.onProviderRetry?.({
                    attempt: event.properties.status.attempt,
                    message: event.properties.status.message,
                    ...(Number.isFinite(event.properties.status.next)
                      ? { nextRetryAtMs: event.properties.status.next }
                      : {}),
                  });
                } catch (error) {
                  // Retry reporting is auxiliary. A transient Slack or Discord
                  // post failure must not stop observation of the provider's
                  // eventual session error.
                  console.warn(
                    `[NonTaskProviderUsage] OpenCode provider retry reporter failed: ${formatOpenCodeSdkError(error)}`,
                  );
                }
                if (
                  params.maxProviderRetryAttempts !== undefined &&
                  event.properties.status.attempt >=
                    params.maxProviderRetryAttempts
                ) {
                  rejectSessionError(
                    new NonTaskOpenCodePromptError(
                      {
                        name: 'APIError',
                        data: {
                          message: event.properties.status.message,
                          isRetryable: false,
                        },
                      },
                      promptErrorLabel,
                    ),
                  );
                  return;
                }
              } else if (
                event.type === 'session.error' &&
                event.properties.sessionID === sessionId
              ) {
                rejectSessionError(
                  new NonTaskOpenCodePromptError(
                    event.properties.error ??
                      new Error(
                        'OpenCode session failed without error detail.',
                      ),
                    promptErrorLabel,
                  ),
                );
                return;
              }
            }
          } catch (error) {
            if (!eventAbortController.signal.aborted) {
              if (requiresReliableEventMonitor) {
                rejectSessionError(
                  new Error(
                    `OpenCode session event monitor failed: ${formatOpenCodeSdkError(error)}`,
                  ),
                );
                return;
              }
              console.warn(
                `[NonTaskProviderUsage] OpenCode event monitor failed: ${formatOpenCodeSdkError(error)}`,
              );
            }
            return;
          }
          if (
            requiresReliableEventMonitor &&
            !eventAbortController.signal.aborted
          ) {
            rejectSessionError(
              new Error('OpenCode session event monitor ended unexpectedly.'),
            );
          }
        })();
      } catch (error) {
        if (requiresReliableEventMonitor) {
          throw new Error(
            `OpenCode session event handling is unavailable: ${formatOpenCodeSdkError(error)}`,
          );
        }
        // Retry reporting is additive. Keep the prompt path available if an
        // older externally configured OpenCode server cannot stream events.
        if (!eventAbortController.signal.aborted) {
          console.warn(
            `[NonTaskProviderUsage] Could not subscribe to OpenCode events: ${formatOpenCodeSdkError(error)}`,
          );
        }
      }
    }

    try {
      const turnStartedAtMs = Date.now();
      options.onPromptStarted?.();
      const promptRequest = client.session.prompt(
        {
          sessionID: sessionId,
          directory: sessionDirectory,
          model: splitOpenCodeModelId(model),
          tools: promptOptions.tools ?? NON_TASK_SESSION_TOOL_DISABLES,
          ...promptOptions,
        },
        { signal: abortController.signal },
      );
      const promptResult = needsEventMonitor
        ? await Promise.race([promptRequest, sessionError])
        : await promptRequest;

      if (promptResult.error || !promptResult.data) {
        if (isOpenCodeSessionMissing(promptResult.error)) {
          throw new NonTaskOpenCodeSessionNotFoundError();
        }

        throw new NonTaskOpenCodePromptError(
          promptResult.error,
          promptErrorLabel,
        );
      }

      if (promptResult.data.info.error) {
        throw new NonTaskOpenCodePromptError(
          promptResult.data.info.error,
          promptErrorLabel,
        );
      }

      await recordUsageOnce(promptResult.data.info);
      if (options.trackSessionTreeUsage) {
        const finalUsageKey = getUsageKey(promptResult.data.info);
        let usageEventBarrierTimeout: NodeJS.Timeout | undefined;
        const finalEventObserved = await Promise.race([
          waitForUsageEvent(promptResult.data.info),
          eventMonitor?.then(() => false) ?? Promise.resolve(false),
          new Promise<boolean>((resolve) => {
            usageEventBarrierTimeout = setTimeout(
              () => resolve(false),
              NON_TASK_USAGE_EVENT_BARRIER_TIMEOUT_MS,
            );
            usageEventBarrierTimeout.unref();
          }),
        ]).finally(() => {
          if (usageEventBarrierTimeout) clearTimeout(usageEventBarrierTimeout);
          if (finalUsageKey) usageEventWaiters.delete(finalUsageKey);
        });
        if (!finalEventObserved) {
          const currentParentId = asString(promptResult.data.info.parentID);
          if (currentParentId === undefined) {
            console.warn(
              `[NonTaskProviderUsage] OpenCode final message for session ${sessionId} has no parent id; intermediate parent usage cannot be reconciled for this turn.`,
            );
          }
          // Reconciliation must stay cancellable and bounded: a wedged
          // OpenCode server would otherwise hold the leased server (and the
          // caller's already-generated answer) behind unsignaled fetches.
          const reconcileAbortController = new AbortController();
          const reconcileTimeout = setTimeout(() => {
            reconcileAbortController.abort(
              new Error('OpenCode usage reconciliation timed out.'),
            );
          }, NON_TASK_USAGE_RECONCILE_TIMEOUT_MS);
          reconcileTimeout.unref();
          const abortReconcile = () => {
            reconcileAbortController.abort(abortController.signal.reason);
          };
          if (abortController.signal.aborted) {
            abortReconcile();
          } else {
            abortController.signal.addEventListener('abort', abortReconcile, {
              once: true,
            });
          }
          try {
            // Child sessions are enumerated from the server rather than from
            // event-stream bookkeeping so a mid-turn stream failure cannot
            // hide subagent usage, and they are bounded to sessions created
            // in the current turn so a warm shared conversation's historical
            // usage is never re-recorded under the current requester.
            const reconcileSessionIds = new Set([
              sessionId,
              ...sessionsCreatedThisTurn,
            ]);
            try {
              const childrenResult = await client.session.children(
                { sessionID: sessionId, directory: sessionDirectory },
                { signal: reconcileAbortController.signal },
              );
              if (childrenResult.error || !childrenResult.data) {
                console.warn(
                  `[NonTaskProviderUsage] Could not list OpenCode child sessions for ${sessionId}: ${formatOpenCodeSdkError(childrenResult.error)}`,
                );
              } else {
                for (const child of childrenResult.data) {
                  const childId = asString(child.id);
                  const childCreatedAtMs = asFiniteNumber(child.time?.created);
                  if (
                    childId &&
                    childCreatedAtMs !== undefined &&
                    childCreatedAtMs >= turnStartedAtMs
                  ) {
                    reconcileSessionIds.add(childId);
                  }
                }
              }
            } catch (error) {
              console.warn(
                `[NonTaskProviderUsage] Could not list OpenCode child sessions for ${sessionId}: ${formatOpenCodeSdkError(error)}`,
              );
            }
            await Promise.all(
              [...reconcileSessionIds].map(async (trackedSessionId) => {
                try {
                  const messagesResult = await client.session.messages(
                    {
                      sessionID: trackedSessionId,
                      directory: sessionDirectory,
                      limit: 100,
                    },
                    { signal: reconcileAbortController.signal },
                  );
                  if (messagesResult.error || !messagesResult.data) {
                    console.warn(
                      `[NonTaskProviderUsage] Could not reconcile OpenCode usage for session ${trackedSessionId}: ${formatOpenCodeSdkError(messagesResult.error)}`,
                    );
                    return;
                  }

                  await Promise.all(
                    messagesResult.data
                      .map((message) => message.info)
                      .filter(
                        (info) =>
                          info.role === 'assistant' &&
                          info.time.completed !== undefined &&
                          (trackedSessionId !== sessionId ||
                            (currentParentId !== undefined &&
                              asString(info.parentID) === currentParentId)),
                      )
                      .map(recordUsageOnce),
                  );
                } catch (error) {
                  console.warn(
                    `[NonTaskProviderUsage] Could not reconcile OpenCode usage for session ${trackedSessionId}: ${formatOpenCodeSdkError(error)}`,
                  );
                }
              }),
            );
          } finally {
            clearTimeout(reconcileTimeout);
            abortController.signal.removeEventListener('abort', abortReconcile);
          }
        }
      }

      try {
        await options.onMessageCompleted?.({
          id: asString(promptResult.data.info.id) ?? null,
          sessionId,
          createdAtMs:
            asFiniteNumber(promptResult.data.info.time?.created) ?? null,
          completedAtMs:
            asFiniteNumber(promptResult.data.info.time?.completed) ?? null,
        });
      } catch (error) {
        console.warn(
          `[NonTaskProviderUsage] OpenCode completion observer failed: ${formatOpenCodeSdkError(error)}`,
        );
      }

      return promptResult.data;
    } catch (error) {
      // Aborting the HTTP request does not guarantee that an OpenCode server
      // stopped its model turn. Explicitly cancel it before the session or a
      // leased server is reused for a bounded retry.
      const sessionAbortController = new AbortController();
      const sessionAbortTimeout = setTimeout(() => {
        sessionAbortController.abort();
      }, NON_TASK_SESSION_ABORT_TIMEOUT_MS);
      sessionAbortTimeout.unref();
      try {
        await client.session
          .abort(
            { sessionID: sessionId, directory: sessionDirectory },
            { signal: sessionAbortController.signal },
          )
          .catch(() => undefined);
      } finally {
        clearTimeout(sessionAbortTimeout);
      }
      throw error;
    } finally {
      abortController.signal.removeEventListener('abort', abortEventMonitor);
      eventAbortController.abort();
      void eventMonitor?.catch(() => undefined);
      // Usage writes started by the event monitor must settle before the
      // prompt call returns or throws — on either path an in-flight write
      // would otherwise race process shutdown. The loop re-snapshots because
      // the monitor can add entries while earlier ones are being awaited.
      let awaitedUsageRecordings = 0;
      while (awaitedUsageRecordings < usageRecordings.size) {
        const pendingUsageRecordings = [...usageRecordings.values()];
        awaitedUsageRecordings = pendingUsageRecordings.length;
        await Promise.allSettled(pendingUsageRecordings);
      }
    }
  } finally {
    externalSignal?.removeEventListener('abort', abortFromExternalSignal);
    if (timeout) clearTimeout(timeout);
    server.release();
  }
}

export async function generateTrackedNonTaskText(
  params: GenerateTrackedNonTaskTextParams,
): Promise<string> {
  const runtime = await resolveNonTaskModelRuntime(
    params.model,
    params.modelRole,
    params.reasoningEffort,
  );
  const model = await resolveModelForInputModality(params, runtime);

  const data = await runNonTaskSdkPrompt(
    params,
    { ...runtime, model },
    {
      system: params.system,
      parts: [
        {
          type: 'text',
          text: buildOpenCodePrompt({
            prompt: params.prompt,
            maxOutputTokens: params.maxOutputTokens,
          }),
        },
        ...(params.files ?? []).map((file) => ({
          type: 'file' as const,
          mime: file.mime,
          ...(file.filename ? { filename: file.filename } : {}),
          url: file.url,
        })),
      ],
    },
    { promptErrorLabel: 'OpenCode text prompt failed' },
  );

  const text = data.parts
    .filter(
      (part): part is { type: 'text'; text: string } =>
        part.type === 'text' && typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('')
    .trim();

  if (!text) {
    throw new Error('OpenCode text prompt returned no text output.');
  }

  return text;
}

export async function generateTrackedNonTaskTextInOpenCodeSession(
  params: GenerateTrackedNonTaskTextParams,
  session: NonTaskOpenCodeSession,
  options: NonTaskOpenCodeNativeSessionOptions,
): Promise<string> {
  const runtime = await resolveNonTaskModelRuntime(
    params.model,
    params.modelRole,
    params.reasoningEffort,
  );
  const model = await resolveModelForInputModality(params, runtime);
  options.onModelResolved?.(model);
  const data = await runNonTaskSdkPrompt(
    params,
    { ...runtime, model },
    {
      system: params.system,
      tools: options.tools,
      parts: [
        {
          type: 'text',
          text: buildOpenCodePrompt({
            prompt: params.prompt,
            maxOutputTokens: params.maxOutputTokens,
          }),
        },
        ...(params.files ?? []).map((file) => ({
          type: 'file' as const,
          mime: file.mime,
          ...(file.filename ? { filename: file.filename } : {}),
          url: file.url,
        })),
      ],
    },
    {
      directory: options.directory,
      env: options.env,
      onPromptStarted: options.onPromptStarted,
      onMessageCompleted: options.onMessageCompleted,
      onPermissionAsked: options.onPermissionAsked,
      onSessionReady: options.onSessionReady,
      onSubagentSessionReady: options.onSubagentSessionReady,
      permission: options.permission,
      preserveReasoning: true,
      promptOnlySubagents: options.promptOnlySubagents,
      promptErrorLabel: 'OpenCode native Fast prompt failed',
      session,
      signal: options.signal,
      trackSessionTreeUsage: options.trackSessionTreeUsage,
      useConfiguredServer: false,
      validateSession: options.validateSession,
    },
  );

  return data.parts
    .filter(
      (part): part is { type: 'text'; text: string } =>
        part.type === 'text' && typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('')
    .trim();
}

async function generateTrackedNonTaskObjectWithSdk<
  TSchema extends z.ZodTypeAny,
>(
  params: GenerateTrackedNonTaskObjectParams<TSchema>,
): Promise<{ object: z.output<TSchema> }> {
  const resolvedRuntime = await resolveNonTaskModelRuntime(
    params.model,
    params.modelRole,
    params.reasoningEffort,
  );

  const data = await runNonTaskSdkPrompt(
    params,
    resolvedRuntime,
    {
      system: params.system,
      format: {
        type: 'json_schema',
        schema: zodToJsonSchema(params.schema, {
          $refStrategy: 'none',
          target: 'jsonSchema7',
        }) as Record<string, unknown>,
        retryCount: DEFAULT_OPENCODE_STRUCTURED_OUTPUT_RETRY_COUNT,
      },
      parts: [
        {
          type: 'text',
          text: buildOpenCodePrompt({
            prompt: params.prompt,
            maxOutputTokens: params.maxOutputTokens,
          }),
        },
      ],
    },
    {
      promptErrorLabel: `OpenCode structured prompt failed (model ${resolvedRuntime.model})`,
    },
  );

  const structured = (data.info as { structured?: unknown }).structured;
  if (structured == null) {
    throw new Error('OpenCode structured prompt returned no structured data.');
  }

  const object = params.schema.parse(structured) as z.output<TSchema>;

  return { object };
}

export async function generateTrackedNonTaskObject<
  TSchema extends z.ZodTypeAny,
>(
  params: GenerateTrackedNonTaskObjectParams<TSchema>,
): Promise<{ object: z.output<TSchema> }> {
  return generateTrackedNonTaskObjectWithSdk(params);
}

function unwrapNonTaskInferenceError(error: unknown): unknown {
  return error instanceof NonTaskOpenCodePromptError
    ? error.providerError
    : error;
}

function findInferenceErrorStatusCode(error: unknown): number | undefined {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: error, depth: 0 },
  ];
  const seen = new Set<object>();

  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || current.depth > 4) {
      continue;
    }

    const { value, depth } = current;
    if (typeof value === 'string') {
      try {
        pending.push({ value: JSON.parse(value), depth: depth + 1 });
      } catch {
        // Provider prose is handled by the fallback signatures below.
      }
      continue;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) {
      continue;
    }

    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ['statusCode', 'status', 'code'] as const) {
      const candidate = record[key];
      const parsed =
        typeof candidate === 'number'
          ? candidate
          : typeof candidate === 'string' && /^\d{3}$/u.test(candidate.trim())
            ? Number(candidate.trim())
            : undefined;
      if (
        parsed !== undefined &&
        Number.isInteger(parsed) &&
        parsed >= 400 &&
        parsed <= 599
      ) {
        return parsed;
      }
    }

    for (const nested of Object.values(record)) {
      pending.push({ value: nested, depth: depth + 1 });
    }
  }

  return undefined;
}

function isInferenceErrorExplicitlyNonRetryable(error: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: error, depth: 0 },
  ];
  const seen = new Set<object>();

  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || current.depth > 4) continue;

    const { value, depth } = current;
    if (typeof value === 'string') {
      try {
        pending.push({ value: JSON.parse(value), depth: depth + 1 });
      } catch {
        // Provider prose is classified separately below.
      }
      continue;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) continue;

    seen.add(value);
    const record = value as Record<string, unknown>;
    if (record.isRetryable === false) return true;
    for (const nested of Object.values(record)) {
      pending.push({ value: nested, depth: depth + 1 });
    }
  }

  return false;
}

function isContentFilterInferenceError(error: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: error, depth: 0 },
  ];
  const seen = new Set<object>();

  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || current.depth > 4) continue;

    const { value, depth } = current;
    if (typeof value === 'string') {
      const normalized = value.toLowerCase();
      if (
        normalized.includes('contentfiltererror') ||
        normalized.includes('content_filter') ||
        (normalized.includes('content filter') &&
          (normalized.includes('blocked') || normalized.includes('filtered')))
      ) {
        return true;
      }

      try {
        pending.push({ value: JSON.parse(value), depth: depth + 1 });
      } catch {
        // The recognized provider message signatures above are sufficient.
      }
      continue;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) continue;

    seen.add(value);
    const record = value as Record<string, unknown>;
    pending.push(
      { value: record.name, depth: depth + 1 },
      { value: record.message, depth: depth + 1 },
    );
    for (const nested of Object.values(value)) {
      pending.push({ value: nested, depth: depth + 1 });
    }
  }

  return false;
}

export function classifyNonTaskInferenceError(
  error: unknown,
): Pick<
  Extract<NonTaskInferenceValidationResult, { success: false }>,
  'message' | 'reason' | 'retryable'
> {
  // OpenCode surfaces provider rejections as `{name, data: {message,
  // statusCode, responseBody}}`. The status code is authoritative when
  // present — provider wording varies too much for substring matching to be
  // the primary signal (Anthropic says "API key is invalid.", which no
  // keyword list reliably catches).
  const inferenceError = unwrapNonTaskInferenceError(error);
  const record =
    inferenceError && typeof inferenceError === 'object'
      ? (inferenceError as Record<string, unknown>)
      : undefined;
  const data =
    record?.data && typeof record.data === 'object'
      ? (record.data as Record<string, unknown>)
      : undefined;
  const statusCode = findInferenceErrorStatusCode(inferenceError);
  const responseBody =
    typeof data?.responseBody === 'string' ? data.responseBody : '';
  const detail =
    `${formatOpenCodeSdkError(inferenceError)} ${responseBody}`.toLowerCase();
  const errorName = typeof record?.name === 'string' ? record.name : '';
  const gatewayBlocked =
    (statusCode === 403 && /^\s*(?:<!doctype|<html)/iu.test(responseBody)) ||
    (detail.includes('forbidden:') &&
      detail.includes('request was blocked by a gateway or proxy'));

  if (isContentFilterInferenceError(inferenceError)) {
    return {
      message:
        'The inference provider blocked the response with its content filter.',
      reason: 'content_filter',
      retryable: false,
    };
  }

  if (isInferenceErrorExplicitlyNonRetryable(inferenceError)) {
    return {
      message: 'The inference provider rejected the request.',
      reason: 'provider_error',
      retryable: false,
    };
  }

  // Failures inside Roomote's own validation helper (the managed OpenCode
  // server) must not read as provider failures — the candidate credentials
  // were never exercised.
  if (
    detail.includes('opencode sdk server') ||
    detail.includes('spawn opencode') ||
    detail.includes('enoent')
  ) {
    return {
      message:
        'Roomote could not run its validation helper. Try again, or check the server logs.',
      reason: 'provider_error',
      retryable: true,
    };
  }

  // OpenCode normalizes HTML 403 responses from provider gateways and WAFs
  // into this error. These are distinct from structured credential failures:
  // the same request can succeed when routed through a healthy edge shortly
  // afterward, so Fast may recover with its bounded outer retry.
  if (gatewayBlocked) {
    return {
      message: 'The inference provider gateway blocked the request.',
      reason: 'gateway_blocked',
      retryable: true,
    };
  }

  if (statusCode === 408) {
    return {
      message: 'The inference provider did not respond in time. Try again.',
      reason: 'timeout',
      retryable: true,
    };
  }

  if (errorName === 'ProviderAuthError') {
    return {
      message: 'The inference provider rejected these credentials.',
      reason: 'invalid_credentials',
      retryable: false,
    };
  }

  if (errorName === 'MessageAbortedError') {
    return {
      message: 'The inference provider did not respond in time. Try again.',
      reason: 'timeout',
      retryable: true,
    };
  }

  if (
    errorName === 'ContextOverflowError' ||
    errorName === 'MessageOutputLengthError' ||
    errorName === 'StructuredOutputError'
  ) {
    return {
      message: 'The inference provider rejected the request.',
      reason: 'provider_error',
      retryable: false,
    };
  }

  if (statusCode === 401 || statusCode === 403) {
    return {
      message: 'The inference provider rejected these credentials.',
      reason: 'invalid_credentials',
      retryable: false,
    };
  }

  if (statusCode === 402) {
    return {
      message:
        'The inference provider account does not have enough credits or quota.',
      reason: 'insufficient_credits',
      retryable: false,
    };
  }

  if (statusCode === 404) {
    return {
      message: 'The selected model is unavailable with these credentials.',
      reason: 'model_unavailable',
      retryable: false,
    };
  }

  if (statusCode === 429) {
    return {
      message: 'The inference provider is rate limiting requests. Try again.',
      reason: 'rate_limited',
      retryable: true,
    };
  }

  if (
    detail.includes('timed out') ||
    detail.includes('timeout') ||
    detail.includes('aborterror') ||
    detail.includes('aborted')
  ) {
    return {
      message: 'The inference provider did not respond in time. Try again.',
      reason: 'timeout',
      retryable: true,
    };
  }

  if (
    detail.includes('insufficient_quota') ||
    detail.includes('insufficient quota') ||
    detail.includes('insufficient credit') ||
    detail.includes('payment required') ||
    detail.includes('billing') ||
    /\b402\b/u.test(detail)
  ) {
    return {
      message:
        'The inference provider account does not have enough credits or quota.',
      reason: 'insufficient_credits',
      retryable: false,
    };
  }

  if (
    detail.includes('unauthorized') ||
    detail.includes('authentication') ||
    detail.includes('invalid api key') ||
    detail.includes('invalid_api_key') ||
    detail.includes('incorrect api key') ||
    detail.includes('revoked') ||
    /\b401\b/u.test(detail)
  ) {
    return {
      message: 'The inference provider rejected these credentials.',
      reason: 'invalid_credentials',
      retryable: false,
    };
  }

  if (
    detail.includes('providermodelnotfound') ||
    detail.includes('model not found') ||
    detail.includes('unknown model') ||
    detail.includes('unsupported model') ||
    detail.includes('does not have access to model') ||
    /\b404\b/u.test(detail)
  ) {
    return {
      message: 'The selected model is unavailable with these credentials.',
      reason: 'model_unavailable',
      retryable: false,
    };
  }

  if (
    detail.includes('rate limit') ||
    detail.includes('rate_limit') ||
    detail.includes('too many requests') ||
    /\b429\b/u.test(detail)
  ) {
    return {
      message: 'The inference provider is rate limiting requests. Try again.',
      reason: 'rate_limited',
      retryable: true,
    };
  }

  if (
    detail.includes('econnrefused') ||
    detail.includes('econnreset') ||
    detail.includes('enotfound') ||
    detail.includes('fetch failed') ||
    detail.includes('network error') ||
    detail.includes('socket')
  ) {
    return {
      message: 'Roomote could not reach the inference provider endpoint.',
      reason: 'endpoint_unreachable',
      retryable: true,
    };
  }

  // Remaining structured 4xx responses (400, 413, 422, …) are client errors:
  // resending the same request cannot recover them. 408 stays retryable as a
  // timeout; 401/402/403/404/429 were classified above.
  if (
    statusCode !== undefined &&
    statusCode >= 400 &&
    statusCode < 500 &&
    statusCode !== 408
  ) {
    return {
      message: 'The inference provider rejected the request.',
      reason: 'provider_error',
      retryable: false,
    };
  }

  return {
    message: 'The inference provider rejected the validation request.',
    reason: 'provider_error',
    retryable: true,
  };
}

/**
 * Qualifies candidate inference credentials through the same restricted
 * OpenCode provider wiring used for control-plane model calls. This is
 * deliberately not a Roomote task: it creates no work item or sandbox, runs
 * in the empty non-task directory, and exposes no executable tools.
 *
 * Candidate env values are sent only to a managed helper process. Reusing an
 * operator-supplied OpenCode server would validate that server's credentials
 * instead of the submitted values, so this path explicitly bypasses it.
 */
export async function validateNonTaskInference(params: {
  model: string;
  runtimeEnv: Partial<Record<string, string>>;
  timeoutMs?: number;
}): Promise<NonTaskInferenceValidationResult> {
  const startedAt = Date.now();
  const checkedAt = new Date(startedAt).toISOString();
  const timeoutMs =
    params.timeoutMs ?? NON_TASK_INFERENCE_VALIDATION_TIMEOUT_MS;
  const configuredModel = params.model.trim();
  const model = toBedrockMantleRuntimeModelId(configuredModel);
  const runtime = {
    model,
    resolvedModelRuntimeEnv: {
      ...params.runtimeEnv,
      R_MODEL: configuredModel,
      // Validation must exercise the model-backed provider config the task
      // runtime builds for this model. An operator-supplied OpenCode config
      // predates the provider being connected and would fail the canary with
      // ProviderModelNotFound.
      OPENCODE_CONFIG_CONTENT: '',
    },
  };

  try {
    if (!configuredModel.includes('/')) {
      throw new Error('ProviderModelNotFound: model must use provider/model');
    }

    // The prompt timeout only starts after the helper server lease. The
    // lease is already bounded by its own start timeout, and this deadline
    // aborts the session/prompt phase, keeping the save mutation to roughly
    // one timeoutMs of wall clock — while always awaiting the call to
    // completion. Returning before the call settles (a race) would let a
    // slow-starting validation discover an invalid key after the save
    // already went through.
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(() => {
      deadlineController.abort(
        new Error(`Inference validation timed out after ${timeoutMs}ms.`),
      );
    }, timeoutMs);
    deadlineTimer.unref();

    let data;
    try {
      data = await runNonTaskSdkPrompt(
        {
          surface: NON_TASK_INFERENCE_SURFACES.inferenceValidation,
          prompt: 'Return an object with ok set to true.',
          timeoutMs,
        },
        runtime,
        {
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: { ok: { const: true, type: 'boolean' } },
              required: ['ok'],
              additionalProperties: false,
            },
            retryCount: 0,
          },
          parts: [
            {
              type: 'text',
              text: 'Return an object with ok set to true.',
            },
          ],
        },
        {
          ephemeral: true,
          promptErrorLabel: `OpenCode inference validation prompt failed (model ${model})`,
          signal: deadlineController.signal,
          useConfiguredServer: false,
        },
      );
    } finally {
      clearTimeout(deadlineTimer);
    }
    const structured = (data.info as { structured?: unknown }).structured;
    if (
      !structured ||
      typeof structured !== 'object' ||
      (structured as { ok?: unknown }).ok !== true
    ) {
      throw new Error('Validation response did not contain the expected data.');
    }

    return {
      success: true,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      model,
    };
  } catch (error) {
    const classified = classifyNonTaskInferenceError(error);

    // The sanitized result hides the provider detail from the UI on purpose;
    // keep the detail in the server log so misclassifications stay
    // diagnosable. Provider rejections can echo the submitted credential
    // ("invalid API key sk-..."), so every candidate env value is redacted
    // from the detail before it reaches the log.
    // Every non-empty value is redacted, even implausibly short ones — a
    // noisier log line is preferable to leaking any real token.
    let detail = formatOpenCodeSdkError(error);
    for (const value of Object.values(params.runtimeEnv)) {
      if (value) {
        detail = detail.split(value).join('[redacted]');
      }
    }
    console.warn(
      `[validateNonTaskInference] ${model} failed (${classified.reason}): ${detail}`,
    );

    return {
      success: false,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      model,
      ...classified,
    };
  }
}
