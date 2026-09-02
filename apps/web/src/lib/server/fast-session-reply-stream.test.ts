import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

import { parseFastSessionReplyChunkEvent } from './fast-session-reply-stream';

describe('parseFastSessionReplyChunkEvent', () => {
  it('accepts an assistant_message_chunk event and derives its kind', () => {
    const event = parseFastSessionReplyChunkEvent(
      JSON.stringify({
        id: 'turn-1:assistant:0',
        ts: 1_700_000_000_000,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessageChunk,
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: 'Looking' }],
        metadata: { sessionId: 'ses_1', turnId: 'msg_1' },
        payload: { sessionId: 'ses_1', turnId: 'msg_1', text: 'Looking' },
        text: 'Looking',
      }),
    );

    expect(event).toMatchObject({
      id: 'turn-1:assistant:0',
      kind: 'text',
      eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessageChunk,
      role: 'assistant',
      contentBlocks: [{ type: 'text', text: 'Looking' }],
      metadata: { sessionId: 'ses_1', turnId: 'msg_1' },
      text: 'Looking',
    });
  });

  it('rejects malformed payloads and other event types', () => {
    expect(parseFastSessionReplyChunkEvent('not json')).toBeUndefined();
    expect(
      parseFastSessionReplyChunkEvent(
        JSON.stringify({
          id: 'x',
          ts: 1,
          eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
          role: 'assistant',
          contentBlocks: [],
          metadata: null,
          payload: {},
        }),
      ),
    ).toBeUndefined();
  });
});
