import {
  formatSingleLineLog,
  getModelFastModeCapabilityForModel,
  validateModelFastModeResponse,
} from '@roomote/types';

const MAX_FAST_MODE_INSPECTION_BYTES = 8 * 1024 * 1024;

type OpenAiFastModeResponseContext = {
  modelId: string;
  capabilityId: string;
};

type OpenAiFastModeRequestInspection =
  | { status: 'not-fast' }
  | { status: 'uninspected' }
  | { status: 'unsupported'; error: string }
  | { status: 'fast'; context: OpenAiFastModeResponseContext };

/**
 * Verify direct OpenAI Fast requests against the route capability registry.
 * The request is cloned and read with a bound, so large prompts remain
 * streamed without forcing unbounded buffering in the inference gateway.
 */
export async function inspectOpenAiFastModeRequest(
  request: Request,
): Promise<OpenAiFastModeRequestInspection> {
  const rawContentLength = request.headers.get('content-length');
  const contentLength = rawContentLength ? Number(rawContentLength) : null;

  if (
    contentLength !== null &&
    Number.isFinite(contentLength) &&
    contentLength > MAX_FAST_MODE_INSPECTION_BYTES
  ) {
    return { status: 'uninspected' };
  }

  let body: string | null;
  try {
    body = await readBodyWithinLimit(
      request.clone(),
      MAX_FAST_MODE_INSPECTION_BYTES,
    );
  } catch {
    return { status: 'uninspected' };
  }

  if (body === null) return { status: 'uninspected' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { status: 'not-fast' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'not-fast' };
  }

  const payload = parsed as Record<string, unknown>;
  if (payload.service_tier !== 'fast' && payload.service_tier !== 'priority') {
    return { status: 'not-fast' };
  }

  const rawModelId =
    typeof payload.model === 'string' ? payload.model.trim() : '';
  const modelId = rawModelId.startsWith('openai/')
    ? rawModelId
    : rawModelId
      ? `openai/${rawModelId}`
      : '';
  const capability = getModelFastModeCapabilityForModel({
    authKind: 'openai-api-key',
    modelId,
  });

  if (!capability || capability.endpoint !== 'responses') {
    return {
      status: 'unsupported',
      error:
        'Fast mode is not available for this OpenAI API model and Responses route. Choose Inherit or Normal in Settings > Models.',
    };
  }

  return {
    status: 'fast',
    context: { modelId, capabilityId: capability.id },
  };
}

/** Observe OpenAI's response-reported tier without changing the response. */
export function observeOpenAiFastModeResponse(
  response: Response,
  context: OpenAiFastModeResponseContext,
  fields: { requestId: string; runId: number },
): Response {
  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('text/event-stream') && response.body) {
    return new Response(
      observeSseServiceTier(response.body, (tier) =>
        reportTier(context, tier, fields),
      ),
      {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      },
    );
  }

  if (contentType.includes('application/json')) {
    void response
      .clone()
      .json()
      .then((payload: unknown) => {
        const responsePayload = asRecord(asRecord(payload).response);
        const tier =
          asString(responsePayload.service_tier) ??
          asString(asRecord(payload).service_tier);
        reportTier(context, tier, fields);
      })
      .catch(() => undefined);
  }

  return response;
}

function reportTier(
  context: OpenAiFastModeResponseContext,
  tier: string | null,
  fields: { requestId: string; runId: number },
): void {
  const validation = validateModelFastModeResponse({
    capabilityId: context.capabilityId,
    requestedMode: 'fast',
    reportedTier: tier,
  });

  if (validation === 'served-standard') {
    console.warn(
      formatSingleLineLog(
        '[Inference Gateway:openai] Fast mode request was served as Standard',
        {
          ...fields,
          modelId: context.modelId,
          requestedTier: 'priority',
          reportedTier: tier,
        },
      ),
    );
  } else if (validation === 'unexpected-tier') {
    console.warn(
      formatSingleLineLog(
        '[Inference Gateway:openai] OpenAI returned an unrecognized service tier',
        {
          ...fields,
          modelId: context.modelId,
          requestedTier: 'priority',
          reportedTier: tier,
        },
      ),
    );
  }
}

function observeSseServiceTier(
  body: ReadableStream<Uint8Array>,
  onTier: (tier: string | null) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();

        if (done) {
          pending += decoder.decode();
          for (const event of takeCompleteEvents(pending, true)) {
            onTier(readEventServiceTier(event));
          }
          controller.close();
          return;
        }

        pending += decoder.decode(value, { stream: true });
        const { events, remainder } = splitCompleteEvents(pending);
        pending = remainder;
        for (const event of events) {
          const tier = readEventServiceTier(event);
          if (tier) onTier(tier);
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

function readEventServiceTier(event: string): string | null {
  const data = event
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('\n');

  if (!data || data === '[DONE]') return null;

  try {
    const payload = asRecord(JSON.parse(data));
    if (payload.type !== 'response.completed') return null;
    return asString(asRecord(payload.response).service_tier);
  } catch {
    return null;
  }
}

function splitCompleteEvents(value: string): {
  events: string[];
  remainder: string;
} {
  const parts = value.split(/\r?\n\r?\n/u);
  return { events: parts.slice(0, -1), remainder: parts.at(-1) ?? '' };
}

function takeCompleteEvents(value: string, flush: boolean): string[] {
  const { events, remainder } = splitCompleteEvents(value);
  return flush && remainder ? [...events, remainder] : events;
}

async function readBodyWithinLimit(
  request: Request,
  maximumBytes: number,
): Promise<string | null> {
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;

      if (totalBytes > maximumBytes) {
        await reader.cancel();
        return null;
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}
