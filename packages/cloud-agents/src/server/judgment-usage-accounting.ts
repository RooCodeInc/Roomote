import { recordLlmUsage } from '@roomote/db/server';

import { NON_TASK_INFERENCE_SURFACES } from './non-task-provider-usage';

export type JudgmentUsageProvider =
  | 'roomote'
  | 'typesafe'
  | 'openrouter'
  | 'vercel';

export type JudgmentRequestRole = 'primary' | 'shadow';

export type JudgmentRequestOutcome =
  | 'success'
  | 'http_error'
  | 'timeout'
  | 'transport_error'
  | 'response_parse_error'
  | 'response_error'
  | 'validation_error';

export type JudgmentRequestTracking = {
  requestId: string;
  provider: JudgmentUsageProvider;
  model: string;
  role: JudgmentRequestRole;
  primaryProvider?: JudgmentUsageProvider;
};

export type JudgmentUsageResponse = {
  body: Record<string, unknown>;
  status: number;
  headers: Headers;
};

export type TrackedJudgmentResponse = JudgmentUsageResponse & {
  finish: (outcome: JudgmentRequestOutcome) => void;
};

type NormalizedJudgmentUsage = {
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costMicroUsd?: number;
  pricingMetadata?: Record<string, unknown>;
  usageMetadataAvailable: boolean;
  usageMetadataSource: 'response' | 'header' | 'none';
  metadataReadFailed: boolean;
  missingUsageFields: string[];
};

/** Carries an HTTP status and headers without persisting an error response body. */
export class JudgmentHttpError extends Error {
  constructor(
    readonly status: number,
    detail: string,
    readonly headers?: Headers,
  ) {
    super(
      `Judgment model request failed with HTTP ${status}${
        detail ? `: ${detail.slice(0, 200)}` : ''
      }`,
    );
    this.name = 'JudgmentHttpError';
  }
}

export class JudgmentResponseParseError extends Error {
  constructor(
    readonly status: number,
    readonly headers: Headers,
  ) {
    super('Judgment model response was not valid JSON');
    this.name = 'JudgmentResponseParseError';
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : undefined;

  return number !== undefined && Number.isFinite(number) && number >= 0
    ? number
    : undefined;
}

function firstNonNegativeNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = nonNegativeNumber(value);
    if (number !== undefined) return number;
  }

  return undefined;
}

function readHeaderNumber(
  headers: Headers | undefined,
  names: readonly string[],
): number | undefined {
  if (!headers) return undefined;

  for (const name of names) {
    const number = nonNegativeNumber(headers.get(name));
    if (number !== undefined) return number;
  }

  return undefined;
}

function readHeaderString(
  headers: Headers | undefined,
  names: readonly string[],
): string | undefined {
  if (!headers) return undefined;

  for (const name of names) {
    const value = headers.get(name)?.trim();
    if (value) return value;
  }

  return undefined;
}

export function normalizeJudgmentUsage(
  response: JudgmentUsageResponse | undefined,
  metadataReadFailed = false,
): NormalizedJudgmentUsage {
  const body = response?.body ?? {};
  const usage =
    asRecord(body.usage) ??
    asRecord(body.usageMetadata) ??
    asRecord(body.usage_metadata);
  const headers = response?.headers;

  const responseInputTokens = firstNonNegativeNumber(
    usage?.input_tokens,
    usage?.prompt_tokens,
    usage?.inputTokens,
    usage?.promptTokens,
  );
  const responseOutputTokens = firstNonNegativeNumber(
    usage?.output_tokens,
    usage?.completion_tokens,
    usage?.outputTokens,
    usage?.completionTokens,
  );
  const responseTotalTokens = firstNonNegativeNumber(
    usage?.total_tokens,
    usage?.totalTokens,
  );
  const responseCostMicroUsd = firstNonNegativeNumber(
    usage?.cost_micro_usd,
    usage?.costMicroUsd,
  );
  const responseCostUsd = firstNonNegativeNumber(
    usage?.cost,
    usage?.cost_usd,
    usage?.costUsd,
  );

  const headerInputTokens = readHeaderNumber(headers, [
    'x-input-tokens',
    'x-prompt-tokens',
    'x-usage-input-tokens',
    'x-openrouter-input-tokens',
  ]);
  const headerOutputTokens = readHeaderNumber(headers, [
    'x-output-tokens',
    'x-completion-tokens',
    'x-usage-output-tokens',
    'x-openrouter-output-tokens',
  ]);
  const headerTotalTokens = readHeaderNumber(headers, [
    'x-total-tokens',
    'x-usage-total-tokens',
    'x-openrouter-total-tokens',
  ]);
  const headerCostMicroUsd = readHeaderNumber(headers, [
    'x-cost-micro-usd',
    'x-usage-cost-micro-usd',
  ]);
  const headerCostUsd = readHeaderNumber(headers, [
    'x-cost-usd',
    'x-cost',
    'x-provider-cost',
    'x-openrouter-cost',
  ]);

  const inputTokens = responseInputTokens ?? headerInputTokens;
  const outputTokens = responseOutputTokens ?? headerOutputTokens;
  const totalTokens = responseTotalTokens ?? headerTotalTokens;
  const costMicroUsd =
    responseCostMicroUsd ??
    (responseCostUsd === undefined
      ? (headerCostMicroUsd ??
        (headerCostUsd === undefined
          ? undefined
          : Math.round(headerCostUsd * 1_000_000)))
      : Math.round(responseCostUsd * 1_000_000));
  const responseMetadataAvailable =
    responseInputTokens !== undefined ||
    responseOutputTokens !== undefined ||
    responseTotalTokens !== undefined ||
    responseCostMicroUsd !== undefined ||
    responseCostUsd !== undefined;
  const headerMetadataAvailable =
    headerInputTokens !== undefined ||
    headerOutputTokens !== undefined ||
    headerTotalTokens !== undefined ||
    headerCostMicroUsd !== undefined ||
    headerCostUsd !== undefined;
  const missingUsageFields: string[] = [];

  if (inputTokens === undefined) missingUsageFields.push('input_tokens');
  if (outputTokens === undefined) missingUsageFields.push('output_tokens');
  if (totalTokens === undefined) missingUsageFields.push('total_tokens');
  if (costMicroUsd === undefined) missingUsageFields.push('cost');

  const costDetails = asRecord(usage?.cost_details ?? usage?.costDetails);
  const responseModel =
    typeof body.model === 'string' && body.model.trim()
      ? body.model.trim()
      : undefined;
  const headerModel = readHeaderString(headers, [
    'x-model',
    'x-provider-model',
  ]);

  return {
    ...(responseModel || headerModel
      ? { modelId: responseModel ?? headerModel }
      : {}),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(costMicroUsd === undefined ? {} : { costMicroUsd }),
    ...(costDetails ? { pricingMetadata: { costDetails } } : {}),
    usageMetadataAvailable:
      responseMetadataAvailable || headerMetadataAvailable,
    usageMetadataSource: responseMetadataAvailable
      ? 'response'
      : headerMetadataAvailable
        ? 'header'
        : 'none',
    metadataReadFailed,
    missingUsageFields,
  };
}

function classifyJudgmentRequestError(error: unknown): {
  outcome: JudgmentRequestOutcome;
  status: number | null;
  headers?: Headers;
  metadataReadFailed: boolean;
} {
  if (error instanceof JudgmentHttpError) {
    return {
      outcome: 'http_error',
      status: error.status,
      headers: error.headers,
      metadataReadFailed: false,
    };
  }

  if (error instanceof JudgmentResponseParseError) {
    return {
      outcome: 'response_parse_error',
      status: error.status,
      headers: error.headers,
      metadataReadFailed: true,
    };
  }

  if (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  ) {
    return {
      outcome: 'timeout',
      status: null,
      metadataReadFailed: false,
    };
  }

  return {
    outcome: 'transport_error',
    status: null,
    metadataReadFailed: false,
  };
}

function recordJudgmentUsage(input: {
  tracking: JudgmentRequestTracking;
  startedAt: number;
  response?: JudgmentUsageResponse;
  status: number | null;
  outcome: JudgmentRequestOutcome;
  headers?: Headers;
  metadataReadFailed?: boolean;
}): void {
  const response =
    input.response ??
    (input.headers
      ? { body: {}, status: input.status ?? 0, headers: input.headers }
      : undefined);
  const usage = normalizeJudgmentUsage(
    response,
    input.metadataReadFailed ?? false,
  );
  const eventKey = `judgment-model:${input.tracking.provider}:${input.tracking.role}:${input.tracking.requestId}`;
  const details: Record<string, unknown> = {
    surface: NON_TASK_INFERENCE_SURFACES.judgmentModel,
    requestRole: input.tracking.role,
    status: input.status,
    outcome: input.outcome,
    latencyMs: Math.max(0, Date.now() - input.startedAt),
    usageMetadataAvailable: usage.usageMetadataAvailable,
    usageMetadataSource: usage.usageMetadataSource,
    metadataReadFailed: usage.metadataReadFailed,
    missingUsageFields: usage.missingUsageFields,
    ...(input.tracking.primaryProvider
      ? { primaryProvider: input.tracking.primaryProvider }
      : {}),
  };

  const persist = async () => {
    await recordLlmUsage({
      source: NON_TASK_INFERENCE_SURFACES.judgmentModel,
      usageType: 'inference',
      eventKey,
      providerId: input.tracking.provider,
      modelId: usage.modelId ?? input.tracking.model,
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      totalTokens: usage.totalTokens ?? 0,
      contextTokens: usage.inputTokens ?? 0,
      costMicroUsd: usage.costMicroUsd ?? null,
      costSource:
        usage.costMicroUsd === undefined ? 'missing' : 'provider_response',
      ...(usage.pricingMetadata
        ? { pricingMetadata: usage.pricingMetadata }
        : {}),
      details,
    });
  };

  void persist().catch(() => {
    // Usage telemetry must never change judgment behavior.
    console.warn(
      `[JudgmentUsage] Failed to record ${input.tracking.provider} ${input.tracking.role} usage`,
    );
  });
}

/**
 * Run one provider request and expose an idempotent completion hook for answer
 * translation/validation. Failed requests are classified and recorded before
 * the original error is rethrown; ledger persistence remains detached.
 */
export async function trackJudgmentRequest(
  tracking: JudgmentRequestTracking,
  request: () => Promise<JudgmentUsageResponse>,
): Promise<TrackedJudgmentResponse> {
  const startedAt = Date.now();

  try {
    const response = await request();
    let finished = false;

    return {
      ...response,
      finish: (outcome) => {
        if (finished) return;
        finished = true;
        recordJudgmentUsage({
          tracking,
          startedAt,
          response,
          status: response.status,
          outcome,
        });
      },
    };
  } catch (error) {
    const failure = classifyJudgmentRequestError(error);
    recordJudgmentUsage({
      tracking,
      startedAt,
      status: failure.status,
      outcome: failure.outcome,
      headers: failure.headers,
      metadataReadFailed: failure.metadataReadFailed,
    });
    throw error;
  }
}
