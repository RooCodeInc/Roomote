import type { DiscordInboundEnvelope } from './inbound-queue';

const RETRYABLE_CLIENT_STATUSES = new Set([401, 403, 404, 405, 408, 425, 429]);

export class DiscordApiForwardingError extends Error {
  readonly name = 'DiscordApiForwardingError';

  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status: number,
  ) {
    super(message);
  }
}

function isRetryableDiscordApiStatus(status: number): boolean {
  return RETRYABLE_CLIENT_STATUSES.has(status) || status >= 500;
}

export class DiscordApiForwarder {
  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly timeoutMs: number,
  ) {}

  async forward(envelope: DiscordInboundEnvelope): Promise<void> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-roomote-discord-gateway-secret': this.secret,
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    // A duplicate means an earlier attempt reached the API but its response
    // was lost. It is safe to remove the durable stream entry.
    if (response.ok || response.status === 409) {
      return;
    }

    const responseText = await response.text().catch(() => '');
    const detail = responseText.slice(0, 300).replace(/\s+/gu, ' ').trim();
    throw new DiscordApiForwardingError(
      `Discord API event forwarding failed (${response.status})${detail ? `: ${detail}` : ''}`,
      isRetryableDiscordApiStatus(response.status),
      response.status,
    );
  }
}
