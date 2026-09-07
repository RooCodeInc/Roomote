import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

import {
  buildFastAgentReplyChunkEvent,
  createFastAgentReplyStreamPublisher,
  createFastAgentReplyTextTracker,
  getFastAgentReplyStreamChannel,
} from '../fast-agent-reply-stream';

describe('createFastAgentReplyTextTracker', () => {
  it('orders parts, applies deltas and full text, and tracks delivery', () => {
    const tracker = createFastAgentReplyTextTracker();
    expect(tracker.sawText()).toBe(false);

    expect(
      tracker.apply({ messageId: 'm1', partId: 'p1', delta: 'Hel' }),
    ).toEqual({ newPart: true });
    expect(
      tracker.apply({ messageId: 'm1', partId: 'p1', delta: 'lo' }),
    ).toEqual({ newPart: false });
    expect(tracker.unconsumedText()).toBe('Hello');
    expect(tracker.hasIncompleteUnconsumed()).toBe(true);

    // The completing update carries the authoritative full text.
    tracker.apply({
      messageId: 'm1',
      partId: 'p1',
      text: 'Hello!',
      completed: true,
    });
    expect(tracker.unconsumedText()).toBe('Hello!');
    expect(tracker.hasIncompleteUnconsumed()).toBe(false);

    expect(tracker.consumeUnconsumed()).toBe('Hello!');
    expect(tracker.unconsumedText()).toBe('');

    tracker.apply({
      messageId: 'm1',
      partId: 'p2',
      text: ' World',
      completed: true,
    });
    expect(tracker.unconsumedText()).toBe(' World');
    expect(tracker.consumedText('m1')).toBe('Hello!');
    expect(tracker.consumedText('other')).toBe('');
    expect(tracker.sawText()).toBe(true);
  });
});

describe('buildFastAgentReplyChunkEvent', () => {
  it('shapes the chunk like a task runtime assistant_message_chunk', () => {
    const event = buildFastAgentReplyChunkEvent({
      eventId: 'turn-1:assistant:0',
      sessionId: 'ses_1',
      turnId: 'msg_1',
      ts: 1_000,
      text: 'Hel',
    });

    expect(event).toMatchObject({
      id: 'turn-1:assistant:0',
      kind: 'text',
      ts: 1_000,
      eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessageChunk,
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'Hel' }],
      metadata: {
        sessionId: 'ses_1',
        turnId: 'msg_1',
        replyEventId: 'turn-1:assistant:0',
      },
      payload: { sessionId: 'ses_1', turnId: 'msg_1', text: 'Hel' },
      text: 'Hel',
    });
    expect(event.logicalEventId).toEqual(expect.stringContaining('ses_1'));
    expect(event.metadata?.logicalEventId).toBe(event.logicalEventId);
  });
});

describe('createFastAgentReplyStreamPublisher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const chunk = (text: string, eventId = 'turn-1:assistant:0') => ({
    eventId,
    sessionId: 'ses_1',
    turnId: 'msg_1',
    ts: 1_000,
    text,
  });
  type PublishFn = (channel: string, payload: string) => Promise<number>;
  const publishedText = (publish: { mock: { calls: [string, string][] } }) =>
    publish.mock.calls.map(([, payload]) => {
      const event = JSON.parse(payload) as { id: string; text: string };
      return `${event.id}=${event.text}`;
    });

  it('coalesces deltas of one reply into one chunk per interval', async () => {
    const publish = vi.fn<PublishFn>(async () => 1);
    const publisher = createFastAgentReplyStreamPublisher({
      getConversationId: () => 'conversation-1',
      intervalMs: 100,
      publish,
    });

    publisher.publishChunk(chunk('He'));
    publisher.publishChunk(chunk('llo'));
    expect(publish).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![0]).toBe(
      getFastAgentReplyStreamChannel('conversation-1'),
    );
    expect(publishedText(publish)).toEqual(['turn-1:assistant:0=Hello']);

    publisher.publishChunk(chunk(' there'));
    await publisher.flush();
    expect(publishedText(publish)).toEqual([
      'turn-1:assistant:0=Hello',
      'turn-1:assistant:0= there',
    ]);
  });

  it('flushes the previous reply before starting a new one', async () => {
    const publish = vi.fn<PublishFn>(async () => 1);
    const publisher = createFastAgentReplyStreamPublisher({
      getConversationId: () => 'conversation-1',
      intervalMs: 100,
      publish,
    });

    publisher.publishChunk(chunk('First'));
    publisher.publishChunk(chunk('Second', 'turn-1:assistant:1'));
    await publisher.flush();

    expect(publishedText(publish)).toEqual([
      'turn-1:assistant:0=First',
      'turn-1:assistant:1=Second',
    ]);
  });

  it('publishes nothing without a conversation and swallows publish failures', async () => {
    const publish = vi.fn<PublishFn>(async () => {
      throw new Error('redis down');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const publisher = createFastAgentReplyStreamPublisher({
      getConversationId: () => null,
      intervalMs: 10,
      publish,
    });
    publisher.publishChunk(chunk('x'));
    await publisher.flush();
    expect(publish).not.toHaveBeenCalled();

    const live = createFastAgentReplyStreamPublisher({
      getConversationId: () => 'conversation-1',
      intervalMs: 10,
      publish,
    });
    live.publishChunk(chunk('x'));
    await expect(live.flush()).resolves.toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to publish a reply chunk'),
    );
    await live.dispose();
  });
});
