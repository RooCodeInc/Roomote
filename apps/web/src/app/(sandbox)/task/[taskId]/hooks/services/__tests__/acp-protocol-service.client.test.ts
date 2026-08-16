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

function reasoningChunk(text: string, sequence: number): AcpMessage {
  return {
    ...assistantChunk(text, sequence),
    eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantThoughtChunk,
    kind: 'reasoning',
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

function subagentActivityUpdate(
  sequence: number,
  lastMessage: string,
): AcpMessage {
  return {
    id: `opencode-server:${sequence}`,
    ts: 1000 + sequence,
    eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate,
    role: 'tool',
    kind: 'tool_result',
    contentBlocks: [],
    metadata: {
      sessionId: 'session-opencode',
      turnId: 'message-opencode',
    },
    payload: {
      toolCallId: 'subagent-call-1',
      kind: 'subagent',
      status: 'in_progress',
      subagentActivity: { lastMessage },
    },
  };
}

describe('AcpProtocolService', () => {
  it('separates adjacent bold headings across reasoning chunks', () => {
    const service = new AcpProtocolService();
    let messages = service.applyOutputEvent(
      [],
      reasoningChunk('**Clarifying boundaries***', 1),
    )!.acpMessages;

    messages = service.applyOutputEvent(
      messages,
      reasoningChunk('*Assessing precision**', 2),
    )!.acpMessages;

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      partial: true,
      text: '**Clarifying boundaries**\n\n**Assessing precision**',
    });
  });

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

  it('keeps an OpenCode subagent prompt from rawInput when its result arrives', () => {
    const service = new AcpProtocolService();
    const metadata = {
      sessionId: 'session-opencode',
      turnId: 'message-opencode',
    };
    const toolCall: AcpMessage = {
      id: 'opencode-server:1',
      ts: 1001,
      eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCall,
      role: 'tool',
      kind: 'tool_call',
      contentBlocks: [],
      metadata,
      payload: {
        toolCallId: 'subagent-call-1',
        kind: 'subagent',
        title: 'Launch explorer',
        status: 'in_progress',
        rawInput: {
          prompt: 'Inspect the task transcript implementation.',
          subagent_type: 'explore',
        },
      },
    };
    const toolResult: AcpMessage = {
      id: 'opencode-server:2',
      ts: 1002,
      eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
      role: 'tool',
      kind: 'tool_result',
      contentBlocks: [],
      metadata,
      payload: {
        toolCallId: 'subagent-call-1',
        kind: 'subagent',
        title: 'Launch explorer',
        status: 'completed',
        output: 'The transcript renderer owns nested subagent rows.',
      },
    };

    const initial = service.applyOutputEvent([], toolCall)!.acpMessages;
    const completed = service.applyOutputEvent(
      initial,
      toolResult,
    )!.acpMessages;

    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      kind: 'tool_result',
      data: {
        prompt: 'Inspect the task transcript implementation.',
        output: 'The transcript renderer owns nested subagent rows.',
      },
    });
  });

  it('merges live child activity into an in-progress subagent row', () => {
    const service = new AcpProtocolService();
    const toolCall: AcpMessage = {
      id: 'opencode-server:1',
      ts: 1001,
      eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCall,
      role: 'tool',
      kind: 'tool_call',
      contentBlocks: [],
      metadata: {
        sessionId: 'session-opencode',
        turnId: 'message-opencode',
      },
      payload: {
        toolCallId: 'subagent-call-1',
        kind: 'subagent',
        title: 'Launch explorer',
        status: 'in_progress',
        prompt: 'Inspect the task transcript implementation.',
      },
    };

    const initial = service.applyOutputEvent([], toolCall)!.acpMessages;
    const updated = service.applyOutputEvent(
      initial,
      subagentActivityUpdate(
        2,
        'The child agent is reviewing the render path.',
      ),
    )!.acpMessages;

    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      kind: 'tool_result',
      partial: true,
      data: {
        prompt: 'Inspect the task transcript implementation.',
        subagentActivity: {
          lastMessage: 'The child agent is reviewing the render path.',
        },
      },
    });
  });
});
