import { ACP_ENVELOPE_EVENT_TYPES, type AcpMessage } from '@roomote/types';

import { AcpProtocolService } from '../acp-protocol-service';

function assistantChunk(text: string, sequence: number): AcpMessage {
  return {
    id: `opencode-server:${sequence}`,
    ts: 1000 + sequence,
    eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessageChunk,
    role: 'assistant',
    kind: 'text',
    contentBlocks: [{ type: 'text', text }],
    metadata: {
      sessionId: 'session-opencode',
      turnId: 'message-opencode',
    },
    payload: {
      sessionId: 'session-opencode',
      turnId: 'message-opencode',
      text,
    },
    text,
  };
}

function toolCallUpdate(sequence: number): AcpMessage {
  return {
    id: `opencode-server:${sequence}`,
    ts: 1000 + sequence,
    eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate,
    role: 'tool',
    kind: 'tool_result',
    contentBlocks: [{ type: 'text', text: 'Reading files...' }],
    metadata: {
      sessionId: 'session-opencode',
      turnId: 'message-opencode',
    },
    payload: {
      sessionId: 'session-opencode',
      turnId: 'message-opencode',
      toolCallId: 'tool-call-1',
      title: 'Read',
      status: 'in_progress',
      output: 'Reading files...',
    },
    text: 'Reading files...',
  };
}

describe('AcpProtocolService', () => {
  it('continues a partial assistant stream after active stream state is rebuilt', () => {
    const service = new AcpProtocolService();
    let messages = service.applyOutputEvent(
      [],
      assistantChunk('Hello ', 1),
    )!.acpMessages;

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      partial: true,
      text: 'Hello ',
    });

    service.reset();
    service.rebindMessages(messages);
    messages = service.applyOutputEvent(
      messages,
      assistantChunk('world', 2),
    )!.acpMessages;

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      partial: true,
      text: 'Hello world',
    });
  });

  it('continues a partial assistant stream followed by a continuation row after active stream state is rebuilt', () => {
    const service = new AcpProtocolService();
    let messages = service.applyOutputEvent(
      [],
      assistantChunk('Hello ', 1),
    )!.acpMessages;

    messages = service.applyOutputEvent(
      messages,
      toolCallUpdate(2),
    )!.acpMessages;

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      partial: true,
      text: 'Hello ',
    });
    expect(messages[1]).toMatchObject({
      kind: 'tool_result',
      partial: true,
    });

    service.reset();
    service.rebindMessages(messages);
    messages = service.applyOutputEvent(
      messages,
      assistantChunk('world', 3),
    )!.acpMessages;

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      partial: true,
      text: 'Hello world',
    });
    expect(messages[1]).toMatchObject({
      kind: 'tool_result',
      partial: true,
    });
  });
});
