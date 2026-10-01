/** How many times one prompt follows its event stream onto a new instance. */
const MAX_RESUBSCRIBES = 3;
const RESUBSCRIBE_DELAY_MS = 50;

/**
 * One prompt's OpenCode events, followed across an instance disposal.
 *
 * OpenCode closes a directory's event streams when that directory's instance
 * is disposed, after announcing it with `server.instance.disposed`. A disposal
 * can still be finishing when the prompt subscribes (a tool-configuration
 * refresh disposes the instance just before), which would close the new
 * stream moments later. Nothing would then relay a `permission.asked`, and
 * the prompt would wait on an ask nobody answers. So a stream that ends on a
 * disposal is reopened; any other ending is final, as before.
 */
export async function* streamOpenCodeEventsAcrossDisposal<
  Event extends { type: string },
>(input: {
  stream: AsyncIterable<Event>;
  resubscribe: () => Promise<AsyncIterable<Event>>;
  /** Runs after each reopening, before its events: catch up on what the gap hid. */
  onResubscribed?: () => Promise<void>;
  signal: AbortSignal;
}): AsyncGenerator<Event> {
  let stream = input.stream;
  for (let resubscribes = 0; ; resubscribes += 1) {
    let disposed = false;
    for await (const event of stream) {
      if (event.type === 'server.instance.disposed') disposed = true;
      yield event;
    }
    if (!disposed || input.signal.aborted || resubscribes >= MAX_RESUBSCRIBES) {
      return;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, RESUBSCRIBE_DELAY_MS * (resubscribes + 1)),
    );
    if (input.signal.aborted) return;
    stream = await input.resubscribe();
    await input.onResubscribed?.();
  }
}
