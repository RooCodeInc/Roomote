import {
  DiscordApiForwarder,
  DiscordApiForwardingError,
} from './api-forwarder';
import { runDeliveryLoop, runSupervisedDeliveryLoop } from './delivery-loop';
import type {
  DiscordInboundEnvelope,
  DiscordInboundQueue,
} from './inbound-queue';
import type { GatewayStatusStore } from './status';

function event(id: string): DiscordInboundEnvelope {
  return {
    eventId: id,
    eventType: 'MESSAGE_CREATE',
    payload: { id },
    receivedAt: '2026-07-12T12:00:00.000Z',
  };
}

describe('Discord delivery worker', () => {
  it('quarantines malformed and deterministic failures without blocking later events', async () => {
    const abort = new AbortController();
    const malformed = {
      kind: 'malformed' as const,
      streamId: '1-0',
      serializedEnvelope: '{bad json',
      reason: 'Envelope is not valid JSON',
    };
    const rejectedEnvelope = event('rejected');
    const goodEnvelope = event('good');
    const queue = {
      peek: vi.fn().mockResolvedValue([
        malformed,
        {
          kind: 'event',
          streamId: '2-0',
          envelope: rejectedEnvelope,
          serializedEnvelope: JSON.stringify(rejectedEnvelope),
        },
        {
          kind: 'event',
          streamId: '3-0',
          envelope: goodEnvelope,
          serializedEnvelope: JSON.stringify(goodEnvelope),
        },
      ]),
      recordAttempt: vi.fn().mockResolvedValue(1),
      quarantine: vi.fn().mockResolvedValue(true),
      acknowledge: vi.fn(async () => abort.abort()),
      depth: vi.fn().mockResolvedValue(0),
    } as unknown as DiscordInboundQueue;
    const forwarder = {
      forward: vi.fn(async (envelope: DiscordInboundEnvelope) => {
        if (envelope.eventId === 'rejected') {
          throw new DiscordApiForwardingError(
            'Discord API event forwarding failed (400)',
            false,
            400,
          );
        }
      }),
    } as unknown as DiscordApiForwarder;
    const status = {
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as GatewayStatusStore;

    await runDeliveryLoop({
      queue,
      forwarder,
      status,
      signal: abort.signal,
      pollMs: 1,
    });

    expect(queue.quarantine).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ streamId: '1-0', attempts: 0 }),
    );
    expect(queue.quarantine).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ streamId: '2-0', attempts: 1 }),
    );
    expect(forwarder.forward).toHaveBeenCalledWith(goodEnvelope);
    expect(queue.acknowledge).toHaveBeenCalledWith('3-0');
  });

  it('quarantines repeatedly failing transient events at the attempt cap', async () => {
    const abort = new AbortController();
    const envelope = event('poison');
    const queue = {
      peek: vi.fn().mockResolvedValue([
        {
          kind: 'event',
          streamId: '1-0',
          envelope,
          serializedEnvelope: JSON.stringify(envelope),
        },
      ]),
      recordAttempt: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
      quarantine: vi.fn(async () => {
        abort.abort();
        return true;
      }),
      acknowledge: vi.fn(),
      depth: vi.fn().mockResolvedValue(1),
    } as unknown as DiscordInboundQueue;
    const forwarder = {
      forward: vi
        .fn()
        .mockRejectedValue(
          new DiscordApiForwardingError(
            'Discord API event forwarding failed (500)',
            true,
            500,
          ),
        ),
    } as unknown as DiscordApiForwarder;
    const status = {
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as GatewayStatusStore;

    await runDeliveryLoop({
      queue,
      forwarder,
      status,
      signal: abort.signal,
      pollMs: 1,
      maxAttempts: 2,
    });

    expect(forwarder.forward).toHaveBeenCalledTimes(2);
    expect(queue.quarantine).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: '1-0',
        attempts: 2,
        reason: expect.stringContaining('attempts exhausted'),
      }),
    );
  });

  it.each([
    ['network failure', new Error('connection reset')],
    [
      'invalid delivery secret',
      new DiscordApiForwardingError(
        'Discord API event forwarding failed (401)',
        true,
        401,
      ),
    ],
    [
      'event still processing',
      new DiscordApiForwardingError(
        'Discord API event forwarding failed (425)',
        true,
        425,
      ),
    ],
    [
      'API outage',
      new DiscordApiForwardingError(
        'Discord API event forwarding failed (503)',
        true,
        503,
      ),
    ],
  ])('preserves events during a %s', async (_label, error) => {
    const envelope = event('preserve-me');
    const queue = {
      peek: vi.fn().mockResolvedValue([
        {
          kind: 'event',
          streamId: '1-0',
          envelope,
          serializedEnvelope: JSON.stringify(envelope),
        },
      ]),
      recordAttempt: vi.fn().mockResolvedValue(99),
      quarantine: vi.fn(),
      acknowledge: vi.fn(),
      depth: vi.fn().mockResolvedValue(1),
    } as unknown as DiscordInboundQueue;
    const forwarder = {
      forward: vi.fn().mockRejectedValue(error),
    } as unknown as DiscordApiForwarder;

    await expect(
      runDeliveryLoop({
        queue,
        forwarder,
        status: {
          update: vi.fn().mockResolvedValue(undefined),
        } as unknown as GatewayStatusStore,
        signal: new AbortController().signal,
        pollMs: 1,
        maxAttempts: 1,
      }),
    ).rejects.toBe(error);
    expect(queue.quarantine).not.toHaveBeenCalled();
    expect(queue.acknowledge).not.toHaveBeenCalled();
  });

  it('marks forwarding unavailable and restarts a crashed delivery loop', async () => {
    const abort = new AbortController();
    const update = vi.fn().mockResolvedValue(undefined);
    const runLoop = vi
      .fn()
      .mockRejectedValueOnce(new Error('Redis read failed'))
      .mockImplementationOnce(async () => {
        abort.abort();
      });

    await runSupervisedDeliveryLoop({
      queue: {} as DiscordInboundQueue,
      forwarder: {} as DiscordApiForwarder,
      status: { update } as unknown as GatewayStatusStore,
      signal: abort.signal,
      pollMs: 1,
      runLoop,
    });

    expect(runLoop).toHaveBeenCalledTimes(2);
    expect(update.mock.calls.map(([patch]) => patch.forwardingReady)).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        forwardingReady: false,
        lastError: expect.stringContaining('Redis read failed'),
      }),
    );
  });
});
