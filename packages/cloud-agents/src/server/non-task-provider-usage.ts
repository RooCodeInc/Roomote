import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createOpencodeClient,
  type PermissionRuleset,
} from '@opencode-ai/sdk/v2/client';
import { resolveEffectiveModelRuntimeEnv } from '@roomote/db/server';
import { toBedrockMantleRuntimeModelId } from '@roomote/types';
import type { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import {
  DEFAULT_OPENCODE_SDK_SERVER_START_TIMEOUT_MS,
  leaseOpenCodeSdkServer,
  NON_TASK_TOOL_PERMISSION_DENIALS,
  readOpenCodeDebugConfig,
} from './opencode-runtime';

const DEFAULT_OPENCODE_STRUCTURED_OUTPUT_RETRY_COUNT = 2;

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
  provider?: string;
};

export const NON_TASK_INFERENCE_SURFACES = {
  chatAudioTranscription: 'chat_audio_transcription',
  chatVideoDescription: 'chat_video_description',
  customAutomationScheduleResolution: 'custom_automation_schedule_resolution',
  fastAgentOnboardingSuggestions: 'fast_agent_onboarding_suggestions',
  fastAgentQuestionAnswering: 'fast_agent_question_answering',
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
  modelRole?: 'primary' | 'small';
  maxOutputTokens?: number;
  timeoutMs?: number;
  /**
   * When set, timeoutMs becomes a server-start bound while the prompt itself
   * times out only after this much session inactivity. Fast uses this so a
   * productive model or tool turn is not aborted by an absolute deadline.
   */
  idleTimeoutMs?: number;
  /**
   * OpenCode retries some provider failures internally before the prompt
   * request settles. Long-running, user-visible callers such as Fast Mode can
   * subscribe to those retry transitions instead of appearing hung until the
   * outer timeout fires.
   */
  onProviderRetry?: (event: NonTaskProviderRetryEvent) => void | Promise<void>;
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

export type NonTaskOpenCodeNativeSessionOptions = {
  directory: string;
  env?: Partial<Record<string, string>>;
  onActivityReady?: (reportActivity: () => void) => (() => void) | undefined;
  onSessionReady?: (sessionID: string) => Promise<void> | void;
  permission?: PermissionRuleset;
  tools: Record<string, boolean>;
};

export class NonTaskOpenCodeSessionNotFoundError extends Error {
  constructor() {
    super('The OpenCode session is no longer available.');
    this.name = 'NonTaskOpenCodeSessionNotFoundError';
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

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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

async function resolveNonTaskModelRuntime(
  model?: string,
  modelRole: 'primary' | 'small' = 'small',
): Promise<{
  model: string;
  resolvedModelRuntimeEnv: Partial<Record<string, string>>;
}> {
  const requestedModel = model?.trim();
  let resolvedModelRuntimeEnv: Partial<Record<string, string>> = {};

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
    (modelRole === 'primary'
      ? resolvedModelRuntimeEnv.R_MODEL
      : resolvedModelRuntimeEnv.R_SMALL_MODEL ||
        resolvedModelRuntimeEnv.R_MODEL) ||
    (modelRole === 'primary'
      ? asString(parseOpenCodeConfigJson(readOpenCodeDebugConfig()).model)
      : resolveOpenCodeSmallModel());

  if (!resolvedModel) {
    throw new Error(
      'Model configuration is required for non-task model calls. Set R_MODEL to a provider/model ID.',
    );
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
    resolvedModelRuntimeEnv: requestedModel
      ? { ...resolvedModelRuntimeEnv, R_MODEL: requestedModel }
      : resolvedModelRuntimeEnv,
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
    resolvedModelRuntimeEnv: Partial<Record<string, string>>;
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
  const timeoutMs = params.timeoutMs ?? 120_000;
  const server = await leaseOpenCodeSdkServer({
    env: runtime.resolvedModelRuntimeEnv,
    startTimeoutMs: Math.min(
      timeoutMs,
      DEFAULT_OPENCODE_SDK_SERVER_START_TIMEOUT_MS,
    ),
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
    resolvedModelRuntimeEnv: Partial<Record<string, string>>;
  },
  promptOptions: NonTaskSdkPromptOptions,
  options: {
    directory?: string;
    ephemeral?: boolean;
    env?: Partial<Record<string, string>>;
    onActivityReady?: (reportActivity: () => void) => (() => void) | undefined;
    onSessionReady?: (sessionID: string) => Promise<void> | void;
    permission?: PermissionRuleset;
    promptErrorLabel?: string;
    session?: NonTaskOpenCodeSession;
    signal?: AbortSignal;
    useConfiguredServer?: boolean;
  } = {},
): Promise<{
  info: { error?: unknown };
  parts: Array<{ type?: unknown; text?: unknown }>;
}> {
  const { model, resolvedModelRuntimeEnv } = runtime;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const promptTimeoutMs = params.idleTimeoutMs ?? timeoutMs;
  const promptErrorLabel =
    options.promptErrorLabel ??
    `OpenCode structured prompt failed (model ${model})`;
  const sessionDirectory =
    options.directory ?? resolveNonTaskSessionDirectory();
  const server = await leaseOpenCodeSdkServer({
    env: { ...resolvedModelRuntimeEnv, ...options.env },
    ephemeral: options.ephemeral,
    startTimeoutMs: Math.min(
      timeoutMs,
      DEFAULT_OPENCODE_SDK_SERVER_START_TIMEOUT_MS,
    ),
    useConfiguredServer: options.useConfiguredServer,
  });
  const abortController = new AbortController();
  let promptSettled = false;
  let timeout: ReturnType<typeof setTimeout>;
  const abortForTimeout = () => {
    abortController.abort(
      new NonTaskOpenCodePromptTimeoutError(promptTimeoutMs),
    );
  };
  const resetIdleTimeout = (delayMs = promptTimeoutMs) => {
    if (
      params.idleTimeoutMs === undefined ||
      promptSettled ||
      abortController.signal.aborted
    ) {
      return;
    }

    clearTimeout(timeout);
    timeout = setTimeout(abortForTimeout, delayMs);
  };
  timeout = setTimeout(abortForTimeout, promptTimeoutMs);
  const externalSignal = options.signal;
  let removeActivityReporter: (() => void) | undefined;
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
    await options.onSessionReady?.(sessionId);
    removeActivityReporter = options.onActivityReady?.(resetIdleTimeout);

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

    if (params.onProviderRetry || params.idleTimeoutMs !== undefined) {
      try {
        const subscription = await client.event.subscribe(
          { directory: sessionDirectory },
          { signal: eventAbortController.signal },
        );
        eventMonitor = (async () => {
          try {
            for await (const event of subscription.stream) {
              const eventSessionId =
                event.type === 'message.part.updated'
                  ? event.properties.part.sessionID
                  : event.type === 'message.updated'
                    ? event.properties.info.sessionID
                    : event.type === 'session.status' ||
                        event.type === 'session.error'
                      ? event.properties.sessionID
                      : undefined;

              if (
                eventSessionId === sessionId &&
                (event.type === 'message.part.updated' ||
                  event.type === 'message.updated' ||
                  event.type === 'session.status')
              ) {
                const nextRetryAtMs =
                  event.type === 'session.status' &&
                  event.properties.status.type === 'retry' &&
                  Number.isFinite(event.properties.status.next)
                    ? event.properties.status.next
                    : undefined;
                resetIdleTimeout(
                  nextRetryAtMs === undefined
                    ? undefined
                    : Math.max(
                        promptTimeoutMs,
                        nextRetryAtMs - Date.now() + promptTimeoutMs,
                      ),
                );
              }

              if (
                event.type === 'session.status' &&
                event.properties.sessionID === sessionId &&
                event.properties.status.type === 'retry'
              ) {
                void Promise.resolve(
                  params.onProviderRetry?.({
                    attempt: event.properties.status.attempt,
                    message: event.properties.status.message,
                    ...(Number.isFinite(event.properties.status.next)
                      ? { nextRetryAtMs: event.properties.status.next }
                      : {}),
                  }),
                ).catch((error) => {
                  // Retry reporting is auxiliary. A slow or failed chat post
                  // must not block observation of later provider activity.
                  console.warn(
                    `[NonTaskProviderUsage] OpenCode provider retry reporter failed: ${formatOpenCodeSdkError(error)}`,
                  );
                });
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
              console.warn(
                `[NonTaskProviderUsage] OpenCode event monitor failed: ${formatOpenCodeSdkError(error)}`,
              );
            }
          }
        })();
      } catch (error) {
        // Event reporting is additive. Keep the prompt path available if an
        // older externally configured OpenCode server cannot stream events.
        if (!eventAbortController.signal.aborted) {
          console.warn(
            `[NonTaskProviderUsage] Could not subscribe to OpenCode events: ${formatOpenCodeSdkError(error)}`,
          );
        }
      }
    }

    try {
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
      const promptResult = eventMonitor
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

      return promptResult.data;
    } catch (error) {
      // Aborting the HTTP request does not guarantee that an OpenCode server
      // stopped its model turn. Explicitly cancel it before the session or a
      // leased server is reused for a bounded retry.
      await client.session
        .abort({ sessionID: sessionId, directory: sessionDirectory })
        .catch(() => undefined);
      throw error;
    } finally {
      abortController.signal.removeEventListener('abort', abortEventMonitor);
      eventAbortController.abort();
      void eventMonitor?.catch(() => undefined);
    }
  } finally {
    promptSettled = true;
    removeActivityReporter?.();
    externalSignal?.removeEventListener('abort', abortFromExternalSignal);
    clearTimeout(timeout);
    server.release();
  }
}

export async function generateTrackedNonTaskText(
  params: GenerateTrackedNonTaskTextParams,
): Promise<string> {
  const runtime = await resolveNonTaskModelRuntime(
    params.model,
    params.modelRole,
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
  );
  const model = await resolveModelForInputModality(params, runtime);
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
      onActivityReady: options.onActivityReady,
      onSessionReady: options.onSessionReady,
      permission: options.permission,
      promptErrorLabel: 'OpenCode native Fast prompt failed',
      session,
      useConfiguredServer: false,
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
    errorName === 'ContentFilterError' ||
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
