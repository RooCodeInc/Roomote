import { streamOpenCodeEventsAcrossDisposal } from '../opencode-event-stream';

type Event = { type: string; id?: string };

async function* streamOf(...events: Event[]): AsyncGenerator<Event> {
  for (const event of events) yield event;
}

const disposed: Event = { type: 'server.instance.disposed' };

async function collect(stream: AsyncIterable<Event>): Promise<string[]> {
  const seen: string[] = [];
  for await (const event of stream) seen.push(event.id ?? event.type);
  return seen;
}

describe('streamOpenCodeEventsAcrossDisposal', () => {
  it('ends with the stream when the instance was not disposed', async () => {
    const resubscribe = vi.fn();
    await expect(
      collect(
        streamOpenCodeEventsAcrossDisposal({
          stream: streamOf({ type: 'message.updated', id: 'a' }),
          resubscribe,
          signal: new AbortController().signal,
        }),
      ),
    ).resolves.toEqual(['a']);
    expect(resubscribe).not.toHaveBeenCalled();
  });

  it('reopens the stream after a disposal and catches up before its events', async () => {
    const order: string[] = [];
    const resubscribe = vi.fn(async () => {
      order.push('resubscribe');
      return streamOf({ type: 'permission.asked', id: 'ask' });
    });
    const onResubscribed = vi.fn(async () => {
      order.push('catch-up');
    });
    const events = streamOpenCodeEventsAcrossDisposal({
      stream: streamOf({ type: 'server.connected', id: 'connected' }, disposed),
      resubscribe,
      onResubscribed,
      signal: new AbortController().signal,
    });
    for await (const event of events) order.push(event.id ?? event.type);
    expect(order).toEqual([
      'connected',
      'server.instance.disposed',
      'resubscribe',
      'catch-up',
      'ask',
    ]);
    expect(resubscribe).toHaveBeenCalledOnce();
  });

  it('does not reopen once the prompt is over', async () => {
    const abort = new AbortController();
    const resubscribe = vi.fn();
    abort.abort();
    await expect(
      collect(
        streamOpenCodeEventsAcrossDisposal({
          stream: streamOf(disposed),
          resubscribe,
          signal: abort.signal,
        }),
      ),
    ).resolves.toEqual(['server.instance.disposed']);
    expect(resubscribe).not.toHaveBeenCalled();
  });

  it('stops following an instance that keeps being disposed, and says so', async () => {
    const resubscribe = vi.fn(async () => streamOf(disposed));
    const onResubscribeFailed = vi.fn();
    const seen = await collect(
      streamOpenCodeEventsAcrossDisposal({
        stream: streamOf(disposed),
        resubscribe,
        onResubscribeFailed,
        signal: new AbortController().signal,
      }),
    );
    expect(resubscribe).toHaveBeenCalledTimes(3);
    expect(seen).toHaveLength(4);
    expect(onResubscribeFailed).toHaveBeenCalledOnce();
  });

  it('catches up only once the reopened stream is live', async () => {
    const order: string[] = [];
    let connect!: () => void;
    const connected = new Promise<void>((resolve) => {
      connect = resolve;
    });
    const events = streamOpenCodeEventsAcrossDisposal({
      stream: streamOf(disposed),
      resubscribe: async () =>
        (async function* (): AsyncGenerator<Event> {
          await connected;
          yield { type: 'server.connected', id: 'reconnected' };
        })(),
      onResubscribed: async () => {
        order.push('catch-up');
      },
      signal: new AbortController().signal,
    });
    const reading = (async () => {
      for await (const event of events) order.push(event.id ?? event.type);
    })();
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Still connecting: nothing has been read for the gap yet.
    expect(order).toEqual(['server.instance.disposed']);
    connect();
    await reading;
    expect(order).toEqual([
      'server.instance.disposed',
      'catch-up',
      'reconnected',
    ]);
  });

  it('reports a stream that cannot be reopened, however it fails', async () => {
    const signal = new AbortController().signal;

    // The subscription itself fails.
    const subscribeFailed = vi.fn();
    await expect(
      collect(
        streamOpenCodeEventsAcrossDisposal({
          stream: streamOf(disposed),
          resubscribe: async () => {
            throw new Error('subscribe failed');
          },
          onResubscribeFailed: subscribeFailed,
          signal,
        }),
      ),
    ).rejects.toThrow('subscribe failed');
    expect(subscribeFailed).toHaveBeenCalledOnce();

    // The reopened stream never connects.
    const neverConnected = vi.fn();
    await expect(
      collect(
        streamOpenCodeEventsAcrossDisposal({
          stream: streamOf(disposed),
          resubscribe: async () =>
            (async function* (): AsyncGenerator<Event> {
              await new Promise(() => undefined);
              yield { type: 'server.connected' };
            })(),
          onResubscribeFailed: neverConnected,
          signal,
          reconnectTimeoutMs: 20,
        }),
      ),
    ).rejects.toThrow('did not connect');
    expect(neverConnected).toHaveBeenCalledOnce();

    // The catch-up after reconnecting fails.
    const catchUpFailed = vi.fn();
    await expect(
      collect(
        streamOpenCodeEventsAcrossDisposal({
          stream: streamOf(disposed),
          resubscribe: async () => streamOf({ type: 'server.connected' }),
          onResubscribed: async () => {
            throw new Error('catch-up failed');
          },
          onResubscribeFailed: catchUpFailed,
          signal,
        }),
      ),
    ).rejects.toThrow('catch-up failed');
    expect(catchUpFailed).toHaveBeenCalledOnce();
  });
});
