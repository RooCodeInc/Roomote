import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import { resolveEffectiveModelRuntimeEnv } from '@roomote/db/server';
import type { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

import {
  DEFAULT_OPENCODE_SDK_SERVER_START_TIMEOUT_MS,
  leaseOpenCodeSdkServer,
  readOpenCodeDebugConfig,
} from './opencode-runtime';

const DEFAULT_OPENCODE_STRUCTURED_OUTPUT_RETRY_COUNT = 2;

export type NonTaskInferenceTrackingInput = {
  surface: string;
  userId?: string | null;
  taskId?: string | null;
  provider?: string;
};

export const NON_TASK_INFERENCE_SURFACES = {
  authorshipRulesCompilation: 'authorship_rules_compilation',
  backgroundAnnouncer: 'background_announcer',
  fastAgentOnboardingSuggestions: 'fast_agent_onboarding_suggestions',
  fastAgentQuestionAnswering: 'fast_agent_question_answering',
  prReviewNotificationTriage: 'pr_review_notification_triage',
  routerChannelLaunchGate: 'router_channel_launch_gate',
  routerFollowupClassification: 'router_followup_classification',
  routerGitHubRouting: 'router_github_routing',
  routerTaskRouting: 'router_task_routing',
  routerRequestedWorkKind: 'router_requested_work_kind',
  slackQuestionChannelSuggestions: 'slack_question_channel_suggestions',
  suggestionRoutePlanning: 'suggestion_route_planning',
  suggestionRoutingValidation: 'suggestion_routing_validation',
  taskSummaryGeneration: 'task_summary_generation',
  taskTitleGeneration: 'task_title_generation',
  videoDescription: 'video_description',
} as const;

export interface GenerateTrackedNonTaskTextParams extends NonTaskInferenceTrackingInput {
  prompt: string;
  system?: string;
  model?: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface GenerateTrackedNonTaskObjectParams<
  TSchema extends z.ZodTypeAny,
> extends GenerateTrackedNonTaskTextParams {
  schema: TSchema;
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

async function resolveNonTaskModelRuntime(model?: string): Promise<{
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
    resolvedModelRuntimeEnv.R_SMALL_MODEL ||
    resolvedModelRuntimeEnv.R_MODEL ||
    resolveOpenCodeSmallModel();

  if (!resolvedModel) {
    throw new Error(
      'Model configuration is required for non-task model calls. Set R_MODEL to a provider/model ID.',
    );
  }

  return {
    model: resolvedModel,
    resolvedModelRuntimeEnv,
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
  parts: Array<{ type: 'text'; text: string }>;
};

/**
 * Shared OpenCode SDK plumbing for non-task inference: leases a managed SDK
 * server, wires the abort/timeout controller, creates a session, and issues the
 * prompt. Returns the raw prompt payload (`{ info, parts }`) so each caller can
 * interpret it — structured object extraction or plain-text joining — without
 * duplicating the boilerplate or the terminal-scraping apparatus it replaced.
 */
async function runNonTaskSdkPrompt(
  params: GenerateTrackedNonTaskTextParams,
  runtime: {
    model: string;
    resolvedModelRuntimeEnv: Partial<Record<string, string>>;
  },
  promptOptions: NonTaskSdkPromptOptions,
): Promise<{
  info: { error?: unknown };
  parts: Array<{ type?: unknown; text?: unknown }>;
}> {
  const { model, resolvedModelRuntimeEnv } = runtime;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const server = await leaseOpenCodeSdkServer({
    env: resolvedModelRuntimeEnv,
    startTimeoutMs: Math.min(
      timeoutMs,
      DEFAULT_OPENCODE_SDK_SERVER_START_TIMEOUT_MS,
    ),
  });
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort(
      new Error(
        `Timed out waiting for OpenCode structured output after ${timeoutMs}ms.`,
      ),
    );
  }, timeoutMs);

  try {
    const client = createOpencodeClient({
      baseUrl: server.url,
      fetch: openCodeSdkFetch,
    });
    const sessionResult = await client.session.create(
      {
        directory: process.cwd(),
        title: `Roomote ${params.surface}`,
      },
      { signal: abortController.signal },
    );

    if (sessionResult.error || !sessionResult.data) {
      throw new Error(
        `OpenCode structured session creation failed: ${formatOpenCodeSdkError(sessionResult.error)}`,
      );
    }

    const promptResult = await client.session.prompt(
      {
        sessionID: sessionResult.data.id,
        directory: process.cwd(),
        model: splitOpenCodeModelId(model),
        ...promptOptions,
      },
      { signal: abortController.signal },
    );

    if (promptResult.error || !promptResult.data) {
      throw new Error(
        `OpenCode structured prompt failed: ${formatOpenCodeSdkError(promptResult.error)}`,
      );
    }

    return promptResult.data;
  } finally {
    clearTimeout(timeout);
    server.release();
  }
}

export async function generateTrackedNonTaskText(
  params: GenerateTrackedNonTaskTextParams,
): Promise<string> {
  const runtime = await resolveNonTaskModelRuntime(params.model);

  const data = await runNonTaskSdkPrompt(params, runtime, {
    system: params.system,
    parts: [
      {
        type: 'text',
        text: buildOpenCodePrompt({
          prompt: params.prompt,
          maxOutputTokens: params.maxOutputTokens,
        }),
      },
    ],
  });

  if (data.info.error) {
    throw new Error(
      `OpenCode text prompt failed: ${formatOpenCodeSdkError(data.info.error)}`,
    );
  }

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

async function generateTrackedNonTaskObjectWithSdk<
  TSchema extends z.ZodTypeAny,
>(
  params: GenerateTrackedNonTaskObjectParams<TSchema>,
  runtime?: {
    model: string;
    resolvedModelRuntimeEnv: Partial<Record<string, string>>;
  },
): Promise<{ object: z.output<TSchema> }> {
  const resolvedRuntime =
    runtime ?? (await resolveNonTaskModelRuntime(params.model));

  const data = await runNonTaskSdkPrompt(params, resolvedRuntime, {
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
  });

  if (data.info.error) {
    throw new Error(
      `OpenCode structured prompt failed: ${formatOpenCodeSdkError(data.info.error)}`,
    );
  }

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
