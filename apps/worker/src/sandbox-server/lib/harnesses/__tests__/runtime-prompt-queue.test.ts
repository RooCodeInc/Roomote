import type { AcpMessage } from '@roomote/types';

import { RuntimePromptQueue } from '../runtime-prompt-queue';

function createQueue() {
  const emittedEvents: AcpMessage[] = [];
  let sequence = 0;

  const queue = new RuntimePromptQueue({
    getSessionId: () => 'test-session',
    getNextSequence: () => ++sequence,
    emitRuntimeOutput: (event) => emittedEvents.push(event),
  });

  return { queue, emittedEvents };
}

describe('RuntimePromptQueue', () => {
  describe('enqueue / dequeue', () => {
    it('enqueues and dequeues in FIFO order', () => {
      const { queue } = createQueue();

      queue.enqueue({ text: 'first' });
      queue.enqueue({ text: 'second' });

      const first = queue.dequeue();
      const second = queue.dequeue();

      expect(first?.text).toBe('first');
      expect(second?.text).toBe('second');
    });

    it('returns undefined when empty', () => {
      const { queue } = createQueue();
      expect(queue.dequeue()).toBeUndefined();
    });

    it('assigns unique IDs to each queued message', () => {
      const { queue } = createQueue();

      queue.enqueue({ text: 'a' });
      queue.enqueue({ text: 'b' });

      const a = queue.dequeue();
      const b = queue.dequeue();

      expect(a?.id).not.toBe(b?.id);
    });

    it('preserves images in queued messages', () => {
      const { queue } = createQueue();

      queue.enqueue({ text: 'with images', images: ['img1', 'img2'] });

      const msg = queue.dequeue();
      expect(msg?.images).toEqual(['img1', 'img2']);
    });

    it('preserves prompt metadata in queued messages', () => {
      const { queue } = createQueue();

      queue.enqueue({
        text: 'with metadata',
        userName: 'Casey',
        userImageUrl: 'https://example.com/casey.png',
        clientMessageId: 'client-message-1',
      });

      const msg = queue.dequeue();
      expect(msg?.userName).toBe('Casey');
      expect(msg?.userImageUrl).toBe('https://example.com/casey.png');
      expect(msg?.clientMessageId).toBe('client-message-1');
    });
  });

  describe('clear', () => {
    it('removes all queued messages', () => {
      const { queue } = createQueue();

      queue.enqueue({ text: 'a' });
      queue.enqueue({ text: 'b' });
      queue.clear();

      expect(queue.dequeue()).toBeUndefined();
    });

    it('emits a clear-cause update when clearing queued messages', () => {
      const { queue, emittedEvents } = createQueue();

      queue.enqueue({ text: 'a' });
      queue.clear();

      expect(emittedEvents[emittedEvents.length - 1]?.payload).toMatchObject({
        cause: 'clear',
        queuedMessages: [],
      });
    });

    it('does not emit when already empty', () => {
      const { queue, emittedEvents } = createQueue();

      queue.clear();

      expect(emittedEvents).toHaveLength(0);
    });
  });

  describe('deleteById', () => {
    it('removes only the matching queued message', () => {
      const { queue, emittedEvents } = createQueue();

      queue.enqueue({ text: 'first' });
      queue.enqueue({ text: 'second' });
      queue.enqueue({ text: 'third' });

      const latestQueued = emittedEvents[emittedEvents.length - 1];
      const queuedMessages = (
        latestQueued?.payload as { queuedMessages?: Array<{ id: string }> }
      )?.queuedMessages;
      const secondId = queuedMessages?.[1]?.id;

      expect(typeof secondId).toBe('string');
      expect(queue.deleteById(secondId!)).toBe(true);

      const first = queue.dequeue();
      const second = queue.dequeue();

      expect(first?.text).toBe('first');
      expect(second?.text).toBe('third');
      expect(queue.dequeue()).toBeUndefined();
    });

    it('returns false when message id does not exist', () => {
      const { queue } = createQueue();
      queue.enqueue({ text: 'only' });

      expect(queue.deleteById('missing-id')).toBe(false);
    });

    it('emits queue update after deleting a message', () => {
      const { queue, emittedEvents } = createQueue();

      queue.enqueue({ text: 'first' });
      queue.enqueue({ text: 'second' });

      const latestQueued = emittedEvents[emittedEvents.length - 1];
      const queuedMessages = (
        latestQueued?.payload as { queuedMessages?: Array<{ id: string }> }
      )?.queuedMessages;
      const firstId = queuedMessages?.[0]?.id;

      expect(typeof firstId).toBe('string');
      expect(queue.deleteById(firstId!)).toBe(true);

      const deleteUpdate = emittedEvents[emittedEvents.length - 1];
      expect(deleteUpdate?.payload).toMatchObject({
        cause: 'delete',
        queuedMessages: [expect.objectContaining({ text: 'second' })],
      });
    });
  });

  describe('prioritize', () => {
    it('moves matching queued message to the front', () => {
      const { queue, emittedEvents } = createQueue();

      queue.enqueue({ text: 'first' });
      queue.enqueue({ text: 'second' });
      queue.enqueue({ text: 'third' });

      const latestQueued = emittedEvents[emittedEvents.length - 1];
      const queuedMessages = (
        latestQueued?.payload as { queuedMessages?: Array<{ id: string }> }
      )?.queuedMessages;
      const secondId = queuedMessages?.[1]?.id;

      expect(typeof secondId).toBe('string');
      expect(queue.prioritize(secondId!)).toBe(true);

      const first = queue.dequeue();
      const second = queue.dequeue();
      const third = queue.dequeue();

      expect(first?.text).toBe('second');
      expect(second?.text).toBe('first');
      expect(third?.text).toBe('third');
    });

    it('returns false when message id does not exist', () => {
      const { queue } = createQueue();
      queue.enqueue({ text: 'only' });

      expect(queue.prioritize('missing-id')).toBe(false);
    });

    it('does not emit update when message is already at the front', () => {
      const { queue, emittedEvents } = createQueue();

      queue.enqueue({ text: 'first' });
      queue.enqueue({ text: 'second' });

      const eventsBeforePrioritize = emittedEvents.length;
      const latestQueued = emittedEvents[emittedEvents.length - 1];
      const queuedMessages = (
        latestQueued?.payload as { queuedMessages?: Array<{ id: string }> }
      )?.queuedMessages;
      const firstId = queuedMessages?.[0]?.id;

      expect(typeof firstId).toBe('string');
      expect(queue.prioritize(firstId!)).toBe(true);
      expect(emittedEvents).toHaveLength(eventsBeforePrioritize);
    });
  });

  describe('move', () => {
    it('moves a queued message before the target message', () => {
      const { queue, emittedEvents } = createQueue();

      queue.enqueue({ text: 'first' });
      queue.enqueue({ text: 'second' });
      queue.enqueue({ text: 'third' });

      const latestQueued = emittedEvents[emittedEvents.length - 1];
      const queuedMessages = (
        latestQueued?.payload as { queuedMessages?: Array<{ id: string }> }
      )?.queuedMessages;
      const firstId = queuedMessages?.[0]?.id;
      const thirdId = queuedMessages?.[2]?.id;

      expect(typeof firstId).toBe('string');
      expect(typeof thirdId).toBe('string');
      expect(queue.move(thirdId!, firstId!, 'before')).toBe(true);

      expect(queue.dequeue()?.text).toBe('third');
      expect(queue.dequeue()?.text).toBe('first');
      expect(queue.dequeue()?.text).toBe('second');
    });

    it('moves a queued message after the target message', () => {
      const { queue, emittedEvents } = createQueue();

      queue.enqueue({ text: 'first' });
      queue.enqueue({ text: 'second' });
      queue.enqueue({ text: 'third' });

      const latestQueued = emittedEvents[emittedEvents.length - 1];
      const queuedMessages = (
        latestQueued?.payload as { queuedMessages?: Array<{ id: string }> }
      )?.queuedMessages;
      const firstId = queuedMessages?.[0]?.id;
      const thirdId = queuedMessages?.[2]?.id;

      expect(typeof firstId).toBe('string');
      expect(typeof thirdId).toBe('string');
      expect(queue.move(firstId!, thirdId!, 'after')).toBe(true);

      expect(queue.dequeue()?.text).toBe('second');
      expect(queue.dequeue()?.text).toBe('third');
      expect(queue.dequeue()?.text).toBe('first');
    });

    it('returns false when either queued message id does not exist', () => {
      const { queue } = createQueue();

      queue.enqueue({ text: 'only' });

      expect(queue.move('missing-id', 'runtime-queued-1', 'before')).toBe(
        false,
      );
      expect(queue.move('runtime-queued-1', 'missing-id', 'after')).toBe(false);
    });

    it('does not emit update when the move does not change the order', () => {
      const { queue, emittedEvents } = createQueue();

      queue.enqueue({ text: 'first' });
      queue.enqueue({ text: 'second' });

      const latestQueued = emittedEvents[emittedEvents.length - 1];
      const queuedMessages = (
        latestQueued?.payload as { queuedMessages?: Array<{ id: string }> }
      )?.queuedMessages;
      const firstId = queuedMessages?.[0]?.id;
      const secondId = queuedMessages?.[1]?.id;
      const eventsBeforeMove = emittedEvents.length;

      expect(typeof firstId).toBe('string');
      expect(typeof secondId).toBe('string');
      expect(queue.move(firstId!, secondId!, 'before')).toBe(true);
      expect(emittedEvents).toHaveLength(eventsBeforeMove);
    });
  });

  describe('emitUpdate', () => {
    it('emits queued_messages_update on enqueue', () => {
      const { queue, emittedEvents } = createQueue();

      queue.enqueue({ text: 'hello' });

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]?.eventType).toBe(
        'roomote_runtime.queued_messages_update',
      );
      expect(emittedEvents[0]?.metadata).toMatchObject({
        sessionId: 'test-session',
      });
      expect(emittedEvents[0]?.payload).toMatchObject({
        cause: 'enqueue',
        queuedMessages: [expect.objectContaining({ text: 'hello' })],
      });
    });

    it('includes prompt metadata in queued_messages_update payloads', () => {
      const { queue, emittedEvents } = createQueue();

      queue.enqueue({
        text: 'hello',
        userName: 'Robin',
        userImageUrl: 'https://example.com/robin.png',
        clientMessageId: 'client-message-2',
      });

      expect(emittedEvents[0]?.payload).toMatchObject({
        queuedMessages: [
          expect.objectContaining({
            userName: 'Robin',
            userImageUrl: 'https://example.com/robin.png',
            clientMessageId: 'client-message-2',
          }),
        ],
      });
    });

    it('hides queue-only prompts from queued_messages_update payloads', () => {
      const { queue, emittedEvents } = createQueue();

      queue.enqueue({
        text: 'background context',
        queueOnly: true,
      });

      expect(emittedEvents[0]?.payload).toMatchObject({
        queuedMessages: [],
        deliverableCount: 0,
      });
    });

    it('replaces a queue-only prompt with the same client message id', () => {
      const { queue, emittedEvents } = createQueue();

      const firstId = queue.enqueue({
        text: 'review head a',
        queueOnly: true,
        clientMessageId: 'github-pr-synchronize:100:owner/repo:42',
      });
      const replacementId = queue.enqueue({
        text: 'review head b',
        queueOnly: true,
        clientMessageId: 'github-pr-synchronize:100:owner/repo:42',
      });

      expect(replacementId).toBe(firstId);
      expect(queue.snapshot()).toEqual([
        expect.objectContaining({
          id: firstId,
          text: 'review head b',
          queueOnly: true,
        }),
      ]);
      expect(emittedEvents.at(-1)?.payload).toMatchObject({
        cause: 'replace',
        queuedMessages: [],
        deliverableCount: 0,
      });
    });

    it('replaces a hidden deliverable prompt with the same client message id', () => {
      const { queue, emittedEvents } = createQueue();

      const firstId = queue.enqueue({
        text: 'review head a',
        visibleInTranscript: false,
        clientMessageId: 'github-pr-synchronize:100:owner/repo:42',
      });
      const replacementId = queue.enqueue({
        text: 'review head b',
        visibleInTranscript: false,
        clientMessageId: 'github-pr-synchronize:100:owner/repo:42',
      });

      expect(replacementId).toBe(firstId);
      expect(queue.snapshot()).toEqual([
        expect.objectContaining({
          id: firstId,
          text: 'review head b',
          visibleInTranscript: false,
        }),
      ]);
      expect(emittedEvents.at(-1)?.payload).toMatchObject({
        cause: 'replace',
        queuedMessages: [],
        deliverableCount: 1,
      });
    });

    it('never replaces user-visible prompts that share a client message id', () => {
      const { queue } = createQueue();

      const firstId = queue.enqueue({
        text: 'first message',
        clientMessageId: 'client-message-1',
      });
      const secondId = queue.enqueue({
        text: 'second message',
        clientMessageId: 'client-message-1',
      });

      expect(secondId).not.toBe(firstId);
      expect(queue.snapshot()).toHaveLength(2);
    });

    it('hides internal continuations from the visible payload but counts them as deliverable', () => {
      const { queue, emittedEvents } = createQueue();

      queue.enqueue({
        text: 'The read-only planning restriction has been lifted.',
        visibleInTranscript: false,
      });

      expect(emittedEvents[0]?.payload).toMatchObject({
        queuedMessages: [],
        deliverableCount: 1,
      });
    });

    it('keeps deliverable prompts in queued_messages_update payloads when queue-only prompts are also buffered', () => {
      const { queue, emittedEvents } = createQueue();

      queue.enqueue({
        text: 'background context',
        queueOnly: true,
      });
      queue.enqueue({
        text: 'visible follow-up',
      });

      expect(emittedEvents.at(-1)?.payload).toMatchObject({
        queuedMessages: [
          expect.objectContaining({ text: 'visible follow-up' }),
        ],
        deliverableCount: 1,
      });
    });

    it('counts internal continuations and visible prompts together as deliverable', () => {
      const { queue, emittedEvents } = createQueue();

      queue.enqueue({
        text: 'The read-only planning restriction has been lifted.',
        visibleInTranscript: false,
      });
      queue.enqueue({
        text: 'visible follow-up',
      });

      expect(emittedEvents.at(-1)?.payload).toMatchObject({
        queuedMessages: [
          expect.objectContaining({ text: 'visible follow-up' }),
        ],
        deliverableCount: 2,
      });
    });

    it('emits with empty queue after dequeue of last item', () => {
      const { queue, emittedEvents } = createQueue();

      queue.enqueue({ text: 'only' });
      queue.dequeue();

      const lastEvent = emittedEvents[emittedEvents.length - 1];
      expect(lastEvent?.payload).toMatchObject({
        cause: 'dequeue',
        queuedMessages: [],
      });
    });

    it('emits with incremented sequence numbers', () => {
      const { queue, emittedEvents } = createQueue();

      queue.enqueue({ text: 'a' });
      queue.enqueue({ text: 'b' });

      expect(
        (emittedEvents[0]?.metadata as { sequence?: number })?.sequence,
      ).toBe(1);
      expect(
        (emittedEvents[1]?.metadata as { sequence?: number })?.sequence,
      ).toBe(2);
    });
  });

  describe('buildPromptBlocks', () => {
    it('returns a text block for plain text', () => {
      const { queue } = createQueue();

      const blocks = queue.buildPromptBlocks('hello');

      expect(blocks).toEqual([{ type: 'text', text: 'hello' }]);
    });

    it('prepends image blocks before text', () => {
      const { queue } = createQueue();

      const blocks = queue.buildPromptBlocks('describe this', [
        'data:image/png;base64,aGVsbG8=',
      ]);

      expect(blocks).toEqual([
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        { type: 'text', text: 'describe this' },
      ]);
    });

    it('includes text block even when empty if no images parsed', () => {
      const { queue } = createQueue();

      const blocks = queue.buildPromptBlocks('', ['not-an-image']);

      expect(blocks).toEqual([{ type: 'text', text: '' }]);
    });

    it('omits text block when text is whitespace-only and images are present', () => {
      const { queue } = createQueue();

      const blocks = queue.buildPromptBlocks('  ', [
        'data:image/jpeg;base64,Zm9v',
      ]);

      expect(blocks).toEqual([
        { type: 'image', data: 'Zm9v', mimeType: 'image/jpeg' },
      ]);
    });
  });
});
