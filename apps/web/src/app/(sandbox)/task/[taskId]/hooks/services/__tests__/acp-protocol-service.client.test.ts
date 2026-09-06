import { ACP_ENVELOPE_EVENT_TYPES, type AcpMessage } from '@roomote/types';

import type { TaskMessageEnvelope } from '@/types';

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
  describe.each(['live', 'history'] as const)('%s tool replay', (mode) => {
    it.each([
      {
        name: 'read',
        kind: 'read',
        rawInput: { filePath: '/tmp/example.ts', offset: 4 },
      },
      {
        name: 'apply_patch',
        kind: 'edit',
        rawInput: { patchText: '*** Begin Patch\n*** End Patch' },
      },
      { name: 'skill', kind: 'other', rawInput: { name: 'implement-changes' } },
      {
        name: 'unknown_native',
        kind: 'other',
        rawInput: {
          server: 'not-mcp',
          tool: 'not-a-tool',
          nested: { values: [1, false] },
        },
      },
    ])(
      'preserves native $name identity and arguments through sparse updates and results',
      ({ name, kind, rawInput }) => {
        const service = new AcpProtocolService();
        const events: AcpMessage[] = [
          {
            toolName: name,
            isMcp: false,
            kind,
            rawInput,
            title: 'mcp__github__list_issues',
            status: 'pending',
          },
          { status: 'in_progress', output: 'Working' },
          {
            title: 'mcp__github__list_issues',
            status: 'completed',
            output: 'Finished',
          },
        ].map((payload, index) => ({
          id: `native:${index}`,
          ts: 1000 + index,
          eventType: [
            ACP_ENVELOPE_EVENT_TYPES.ToolCall,
            ACP_ENVELOPE_EVENT_TYPES.ToolCallUpdate,
            ACP_ENVELOPE_EVENT_TYPES.ToolResult,
          ][index]!,
          role: 'tool',
          kind: index === 0 ? 'tool_call' : 'tool_result',
          contentBlocks: [],
          metadata: { sessionId: 'native-session' },
          payload: { toolCallId: 'native-call', ...payload },
        }));
        let messages = service.applyOutputEvent([], events[0]!)!.acpMessages;
        for (let index = 0; index < events.length; index += 1) {
          if (mode === 'history') {
            messages = service.loadAcpEnvelopes(
              events.slice(0, index + 1).map(
                (event, sequence): TaskMessageEnvelope => ({
                  ...event,
                  taskId: 'task-1',
                  createdAt: event.ts,
                  sequence,
                  protocol: 'roomote_runtime',
                  userId: null,
                  userName: null,
                  userEmail: null,
                  userImageUrl: null,
                }),
              ),
            ).acpMessages;
          } else if (index > 0) {
            messages = service.applyOutputEvent(
              messages,
              events[index]!,
            )!.acpMessages;
          }
          expect(messages).toHaveLength(1);
          expect(messages[0]).toMatchObject({
            kind: index === 0 ? 'tool_call' : 'tool_result',
            partial: index < 2,
            data: {
              kind,
              toolName: name,
              isMcp: false,
              mcpToolName: null,
              mcpServerName: null,
              serverName: null,
              rawInput,
            },
          });
        }
        expect(messages[0]?.text).toBe('Finished');
      },
    );

    it.each([
      {
        label: 'historical kind and arguments',
        payload: { kind: 'read', rawInput: { filePath: '/tmp/legacy.ts' } },
        identity: {
          kind: 'read',
          toolName: null,
          isMcp: false,
          mcpToolName: null,
          mcpServerName: null,
        },
      },
      {
        label: 'MCP',
        payload: {
          kind: 'mcp',
          title: 'mcp__github__list_issues',
          rawInput: { repo: 'example' },
        },
        identity: {
          toolName: 'list_issues',
          serverName: 'github',
          mcpToolName: 'list_issues',
          mcpServerName: 'github',
          isMcp: true,
        },
      },
      {
        label: 'on-demand integration',
        payload: {
          kind: 'mcp',
          title: 'mcp__roomote__call_integration_tool',
          rawInput: {
            integrationId: 'linear',
            toolName: 'list_issues',
            args: { team: 'example' },
          },
        },
        identity: {
          toolName: 'list_issues',
          serverName: 'linear',
          mcpToolName: 'list_issues',
          mcpServerName: 'linear',
          isMcp: true,
        },
      },
    ])('retains $label through a sparse result', ({ payload, identity }) => {
      const service = new AcpProtocolService();
      const events: AcpMessage[] = [
        payload,
        { status: 'completed', output: 'Finished' },
      ].map((data, index) => ({
        id: `compat:${index}`,
        ts: 1000 + index,
        eventType:
          index === 0
            ? ACP_ENVELOPE_EVENT_TYPES.ToolCall
            : ACP_ENVELOPE_EVENT_TYPES.ToolResult,
        kind: index === 0 ? 'tool_call' : 'tool_result',
        role: 'tool',
        contentBlocks: [],
        metadata: { sessionId: 'compat-session' },
        payload: { toolCallId: 'compat-call', ...data },
      }));
      const messages =
        mode === 'history'
          ? service.loadAcpEnvelopes(
              events.map(
                (event, sequence): TaskMessageEnvelope => ({
                  ...event,
                  taskId: 'task-1',
                  createdAt: event.ts,
                  sequence,
                  protocol: 'roomote_runtime',
                  userId: null,
                  userName: null,
                  userEmail: null,
                  userImageUrl: null,
                }),
              ),
            ).acpMessages
          : service.applyOutputEvent(
              service.applyOutputEvent([], events[0]!)!.acpMessages,
              events[1]!,
            )!.acpMessages;
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        kind: 'tool_result',
        partial: false,
        text: 'Finished',
        data: { ...identity, rawInput: payload.rawInput },
      });
    });
  });

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

    service.reset();
    service.rebindMessages(messages);
    messages = service.applyOutputEvent(
      messages,
      reasoningChunk('****Checking gaps**', 3),
    )!.acpMessages;

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      partial: true,
      rawText:
        '**Clarifying boundaries****Assessing precision****Checking gaps**',
      text: [
        '**Clarifying boundaries**',
        '**Assessing precision**',
        '**Checking gaps**',
      ].join('\n\n'),
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
