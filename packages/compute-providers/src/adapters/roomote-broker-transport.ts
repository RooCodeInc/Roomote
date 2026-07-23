import { createHash, createHmac, randomUUID } from 'node:crypto';

import type { RoomoteBrokerConfig } from '../types';
import { throwIfAborted, toAbortError } from '../modal/abort';

export class BrokerRequestError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'BrokerRequestError';
  }
}

export type BrokerRequestInput = {
  method: string;
  path: string;
  body?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

/** Owns broker URL construction, request signing, and error translation. */
export class RoomoteBrokerTransport {
  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly config: RoomoteBrokerConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  public async requestJson(input: BrokerRequestInput): Promise<unknown> {
    const response = await this.request(input);
    return response.json() as Promise<unknown>;
  }

  public async request(input: BrokerRequestInput): Promise<Response> {
    throwIfAborted(input.signal);

    const url = new URL(this.config.brokerUrl);
    url.pathname = `${url.pathname.replace(/\/$/, '')}${input.path}`;

    const timestamp = Date.now().toString();
    const nonce = randomUUID();
    const body = input.body ?? '';
    const bodyHash = createHash('sha256').update(body).digest('hex');
    const signature = createHmac('sha256', this.config.brokerKey)
      .update(
        [
          timestamp,
          nonce,
          input.method.toUpperCase(),
          url.pathname + url.search,
          bodyHash,
        ].join('\n'),
      )
      .digest('hex');

    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method: input.method,
        headers: {
          'content-type': 'application/json',
          'x-roomote-tenant': this.config.tenantId,
          'x-roomote-timestamp': timestamp,
          'x-roomote-nonce': nonce,
          'x-roomote-signature': signature,
          ...(input.headers ?? {}),
        },
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      if (isAbortLike(error)) {
        throw toAbortError(
          input.signal,
          `Broker request ${input.method} ${input.path} was aborted`,
        );
      }

      throw error;
    }

    if (!response.ok) {
      const payload = (await response.json().catch(() => undefined)) as
        | { error?: string; code?: string }
        | undefined;

      throw new BrokerRequestError(
        payload?.error ??
          `Broker request ${input.method} ${input.path} failed with HTTP ${response.status}`,
        response.status,
        payload?.code ?? 'unknown_error',
      );
    }

    return response;
  }
}

function isAbortLike(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}
