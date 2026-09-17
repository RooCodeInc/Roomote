import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

import {
  parseFastSessionLiveEvent,
  parseFastSessionReplyChunkEvent,
} from './fast-session-reply-stream';

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

describe('parseFastSessionLiveEvent', () => {
  it('accepts a bounded task-report refresh without treating it as assistant text', () => {
    const raw = JSON.stringify({
      type: 'task_report_admitted',
      eventId: 'fast-parent-child-message:report-1:user',
      taskId: 'task-1',
      admittedAtMs: 1_700_000_000_000,
      publishedAtMs: 1_700_000_000_010,
    });

    expect(parseFastSessionLiveEvent(raw)).toEqual(JSON.parse(raw));
    expect(parseFastSessionReplyChunkEvent(raw)).toBeUndefined();
  });
});
