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

  it('stops following an instance that keeps being disposed', async () => {
    const resubscribe = vi.fn(async () => streamOf(disposed));
    const seen = await collect(
      streamOpenCodeEventsAcrossDisposal({
        stream: streamOf(disposed),
        resubscribe,
        signal: new AbortController().signal,
      }),
    );
    expect(resubscribe).toHaveBeenCalledTimes(3);
    expect(seen).toHaveLength(4);
  });
});
