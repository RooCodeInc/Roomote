import { sleepWithSignal, throwIfAborted } from '../modal/abort';
import type { BoxConfig } from '../types';

const READ_RETRY_ATTEMPTS = 3;
const RETRYABLE_CONFLICT_CODES = new Set([
  'box_starting',
  'machine_not_running',
  'snapshot_not_ready',
]);
const RETRYABLE_CONFLICT_STATUSES = new Set([400, 409]);
const ERROR_MESSAGE_MAX_LENGTH = 300;

export interface BoxApiErrorMetadata {
  method: string;
  path: string;
  status: number;
  requestId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export class BoxApiError extends Error {
  public constructor(public readonly metadata: BoxApiErrorMetadata) {
    super(
      `Box API ${metadata.method} ${metadata.path} failed with status ${metadata.status}` +
        (metadata.errorCode ? ` (${metadata.errorCode})` : '') +
        (metadata.errorMessage ? `: ${metadata.errorMessage}` : ''),
    );
    this.name = 'BoxApiError';
  }
}

export class BoxTransport {
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(
    private readonly config: BoxConfig,
    apiBaseUrl: string,
    private readonly pollIntervalMs: () => number,
    private readonly readinessTimeoutMs: () => number,
  ) {
    this.apiBaseUrl = trimTrailingSlashes(apiBaseUrl);
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  public async request<T = unknown>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      signal?: AbortSignal;
      retryRead?: boolean;
    } = {},
  ): Promise<T> {
    let attempt = 0;
    let provisioningDeadline: number | undefined;
    while (true) {
      throwIfAborted(options.signal);
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            Accept: 'application/json',
            ...(options.body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
          },
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
          signal: options.signal,
        });
      } catch {
        throwIfAborted(options.signal);
        throw new BoxApiError({ method, path, status: 0 });
      }

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        const text = await response.text();
        if (!text) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new BoxApiError({
            method,
            path,
            status: response.status,
            errorCode: 'invalid_response',
          });
        }
      }

      const errorPayload = await readErrorPayload(response);
      const errorCode = readErrorPayloadField(errorPayload, 'code');

      if (
        RETRYABLE_CONFLICT_STATUSES.has(response.status) &&
        errorCode !== undefined &&
        RETRYABLE_CONFLICT_CODES.has(errorCode)
      ) {
        // These errors refuse the operation without side effects while the
        // box or source snapshot is still provisioning.
        provisioningDeadline ??= Date.now() + this.readinessTimeoutMs();
        if (Date.now() < provisioningDeadline) {
          await sleepWithSignal(this.pollIntervalMs(), options.signal);
          continue;
        }
      }

      attempt += 1;
      if (
        options.retryRead &&
        attempt < READ_RETRY_ATTEMPTS &&
        (response.status === 429 || response.status >= 500)
      ) {
        await sleepWithSignal(retryDelayMs(response, attempt), options.signal);
        continue;
      }

      const headerRequestId = response.headers.get('x-request-id');
      const errorMessage = readErrorPayloadField(errorPayload, 'message');
      throw new BoxApiError({
        method,
        path,
        status: response.status,
        ...(headerRequestId
          ? { requestId: headerRequestId }
          : typeof errorPayload?.requestId === 'string'
            ? { requestId: errorPayload.requestId }
            : {}),
        ...(errorCode ? { errorCode } : {}),
        ...(errorMessage
          ? {
              errorMessage: sanitizeErrorMessage(
                errorMessage,
                this.config.apiKey,
              ),
            }
          : {}),
      });
    }
  }
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(retryAfter * 1_000, 10_000);
  }
  return Math.min(250 * 2 ** (attempt - 1), 2_000);
}

function readErrorPayloadField(
  payload: Record<string, unknown> | undefined,
  field: 'code' | 'message',
): string | undefined {
  const direct = payload?.[field];
  if (typeof direct === 'string' && direct) return direct;
  const nested = payload?.error;
  if (!nested || typeof nested !== 'object') return undefined;
  const value = (nested as Record<string, unknown>)[field];
  return typeof value === 'string' && value ? value : undefined;
}

function sanitizeErrorMessage(message: string, apiKey: string): string {
  // Error text reaches task UI and logs, so redact credentials and cap size.
  const redacted = apiKey ? message.replaceAll(apiKey, '[redacted]') : message;
  return redacted.length > ERROR_MESSAGE_MAX_LENGTH
    ? `${redacted.slice(0, ERROR_MESSAGE_MAX_LENGTH)}…`
    : redacted;
}

async function readErrorPayload(
  response: Response,
): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = (await response.json()) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
