/** How many times one prompt follows its event stream onto a new instance. */
const MAX_RESUBSCRIBES = 3;
const RESUBSCRIBE_DELAY_MS = 50;
/** How long a reopened stream may take to deliver its first event. */
const RECONNECT_TIMEOUT_MS = 10_000;

/**
 * One prompt's OpenCode events, followed across an instance disposal.
 *
 * OpenCode closes a directory's event streams when that directory's instance
 * is disposed, after announcing it with `server.instance.disposed`. A disposal
 * can still be finishing when the prompt subscribes (a tool-configuration
 * refresh disposes the instance just before), which would close the new
 * stream moments later. Nothing would then relay a `permission.asked`, and
 * the prompt would wait on an ask nobody answers. So a stream that ends on a
 * disposal is reopened; any other ending is final.
 *
 * A stream connects when it is first read, so a reopened stream counts as
 * open once it delivers an event. Only then does `onResubscribed` run, so
 * whatever it reads covers everything up to a live stream. If the stream
 * cannot be reopened, `onResubscribeFailed` is told, so the caller can stop
 * the prompt instead of leaving it without anyone to answer an ask.
 */
export async function* streamOpenCodeEventsAcrossDisposal<
  Event extends { type: string },
>(input: {
  stream: EventStream<Event>;
  resubscribe: () => Promise<EventStream<Event>> | EventStream<Event>;
  /** Runs once a reopened stream is live, before its events: catch up on what the gap hid. */
  onResubscribed?: () => Promise<void>;
  onResubscribeFailed?: (error: unknown) => void;
  signal: AbortSignal;
  reconnectTimeoutMs?: number;
}): AsyncGenerator<Event> {
  const failed = (error: unknown) => {
    if (!input.signal.aborted) input.onResubscribeFailed?.(error);
  };
  let stream = input.stream;
  for (let resubscribes = 0; ; resubscribes += 1) {
    const iterator = iteratorOf(stream);
    let next: IteratorResult<Event>;
    if (resubscribes === 0) {
      next = await iterator.next();
    } else {
      try {
        next = await firstEventWithin(
          iterator,
          input.reconnectTimeoutMs ?? RECONNECT_TIMEOUT_MS,
        );
        if (next.done) {
          throw new Error('The reopened OpenCode event stream ended at once.');
        }
        await input.onResubscribed?.();
      } catch (error) {
        failed(error);
        throw error;
      }
    }
    let disposed = false;
    while (!next.done) {
      if (next.value.type === 'server.instance.disposed') disposed = true;
      yield next.value;
      next = await iterator.next();
    }
    if (!disposed || input.signal.aborted) return;
    if (resubscribes >= MAX_RESUBSCRIBES) {
      failed(new Error('The OpenCode instance kept being disposed.'));
      return;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, RESUBSCRIBE_DELAY_MS * (resubscribes + 1)),
    );
    if (input.signal.aborted) return;
    try {
      stream = await input.resubscribe();
    } catch (error) {
      failed(error);
      throw error;
    }
  }
}

type EventStream<Event> = AsyncIterable<Event> | Iterable<Event>;

/** Read either kind of stream the way `for await` would. */
function iteratorOf<Event>(
  stream: EventStream<Event>,
): AsyncIterator<Event> | Iterator<Event> {
  return Symbol.asyncIterator in stream
    ? stream[Symbol.asyncIterator]()
    : stream[Symbol.iterator]();
}

async function firstEventWithin<Event>(
  iterator: AsyncIterator<Event> | Iterator<Event>,
  timeoutMs: number,
): Promise<IteratorResult<Event>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error('The reopened OpenCode event stream did not connect.'),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
