import {
  DiscordApiForwarder,
  DiscordApiForwardingError,
} from './api-forwarder';
import type { DiscordInboundEnvelope } from './inbound-queue';

const envelope: DiscordInboundEnvelope = {
  eventId: 'message-1',
  eventType: 'MESSAGE_CREATE',
  payload: { id: 'message-1' },
  receivedAt: '2026-07-12T12:00:00.000Z',
};

describe('DiscordApiForwarder', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the signed gateway event contract', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }));
    const forwarder = new DiscordApiForwarder(
      'http://api:3001/api/internal/discord/events',
      'internal-secret',
      1_000,
    );

    await forwarder.forward(envelope);

    expect(fetch).toHaveBeenCalledWith(
      'http://api:3001/api/internal/discord/events',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-roomote-discord-gateway-secret': 'internal-secret',
        },
        body: JSON.stringify(envelope),
      }),
    );
  });

  it('treats API duplicate responses as delivered', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 409 }));
    const forwarder = new DiscordApiForwarder('http://api', 'secret', 1_000);

    await expect(forwarder.forward(envelope)).resolves.toBeUndefined();
  });

  it('retains events when the API rejects delivery', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('temporarily unavailable', { status: 503 }),
    );
    const forwarder = new DiscordApiForwarder('http://api', 'secret', 1_000);

    await expect(forwarder.forward(envelope)).rejects.toThrow(
      'Discord API event forwarding failed (503): temporarily unavailable',
    );
  });

  it.each([401, 403, 404, 405, 408, 425, 429, 500, 503])(
    'classifies status %s as retryable',
    async (status) => {
      vi.mocked(fetch).mockResolvedValue(new Response(null, { status }));
      const forwarder = new DiscordApiForwarder('http://api', 'secret', 1_000);

      const error = await forwarder.forward(envelope).catch((cause) => cause);

      expect(error).toBeInstanceOf(DiscordApiForwardingError);
      expect(error).toMatchObject({ status, retryable: true });
    },
  );

  it.each([400, 410, 413, 415, 422])(
    'classifies deterministic status %s as permanent',
    async (status) => {
      vi.mocked(fetch).mockResolvedValue(new Response(null, { status }));
      const forwarder = new DiscordApiForwarder('http://api', 'secret', 1_000);

      const error = await forwarder.forward(envelope).catch((cause) => cause);

      expect(error).toBeInstanceOf(DiscordApiForwardingError);
      expect(error).toMatchObject({ status, retryable: false });
    },
  );
});
