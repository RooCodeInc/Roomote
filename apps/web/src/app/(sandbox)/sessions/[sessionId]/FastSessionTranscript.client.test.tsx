import { fireEvent, render, screen } from '@testing-library/react';
import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

import { FastSessionTranscript } from './FastSessionTranscript';

describe('FastSessionTranscript', () => {
  it('renders persisted user and assistant text with task transcript primitives', () => {
    render(
      <FastSessionTranscript
        messages={[
          {
            id: 'tool-call-1',
            eventId: 'turn-1:tool-call:0',
            turnId: 'turn-1',
            turnSeq: 1,
            ts: 2,
            eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCall,
            role: 'tool',
            contentBlocks: [],
            metadata: { visibleInTranscript: true },
            payload: {
              toolCallId: 'turn-1:tool:0',
              title: 'launch_task',
              kind: 'tool',
              status: 'in_progress',
              isExecute: false,
              isRead: false,
              isMcp: false,
              mcpServerName: null,
              mcpToolName: null,
              toolName: 'launch_task',
              command: null,
              rawInput: { arguments: { prompt: 'Fix checkout' } },
            },
            source: 'slack',
            nativeSessionId: 'opencode-1',
            nativeMessageId: null,
            createdAt: new Date('2026-01-01T00:00:01.000Z'),
          },
          {
            id: 'user-1',
            eventId: 'turn-1:user',
            turnId: 'turn-1',
            turnSeq: 0,
            ts: 1,
            eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
            role: 'user',
            contentBlocks: [{ type: 'text', text: 'What changed?' }],
            metadata: { visibleInTranscript: true },
            payload: {},
            source: 'slack',
            nativeSessionId: null,
            nativeMessageId: null,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
          },
          {
            id: 'assistant-1',
            eventId: 'turn-1:assistant:0',
            turnId: 'turn-1',
            turnSeq: 1,
            ts: 2,
            eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
            role: 'assistant',
            contentBlocks: [{ type: 'text', text: '**Two files**' }],
            metadata: { visibleInTranscript: true },
            payload: {},
            source: 'slack',
            nativeSessionId: 'opencode-1',
            nativeMessageId: null,
            createdAt: new Date('2026-01-01T00:00:01.000Z'),
          },
        ]}
        footer={<p>Transcript limitation</p>}
      />,
    );

    expect(screen.getByRole('log')).toBeInTheDocument();
    expect(screen.getByText('What changed?')).toBeInTheDocument();
    expect(screen.getByText('Two files')).toBeInTheDocument();
    expect(screen.getByText('Transcript limitation')).toBeInTheDocument();
  });

  it('updates one canonical tool row from in-progress to completed', () => {
    const baseMessage = {
      id: 'tool-1',
      eventId: 'turn-1:tool:0',
      turnId: 'turn-1',
      turnSeq: 1,
      ts: 2,
      role: 'tool' as const,
      metadata: { visibleInTranscript: true },
      source: 'slack',
      nativeSessionId: 'opencode-1',
      nativeMessageId: null,
      createdAt: new Date('2026-01-01T00:00:01.000Z'),
    };
    const toolCall = {
      ...baseMessage,
      eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCall,
      contentBlocks: [],
      payload: {
        toolCallId: 'turn-1:tool:0',
        title: 'launch_task',
        kind: 'tool',
        status: 'in_progress',
        isExecute: false,
        isRead: false,
        isMcp: false,
        mcpServerName: null,
        mcpToolName: null,
        toolName: 'launch_task',
        command: null,
        rawInput: { arguments: { prompt: 'Fix checkout' } },
      },
    };
    const toolResult = {
      ...baseMessage,
      eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
      contentBlocks: [{ type: 'text', text: '{"success":true}' }],
      payload: {
        ...toolCall.payload,
        status: 'completed',
        exitCode: null,
        output: '{"success":true}',
      },
    };
    const { rerender } = render(
      <FastSessionTranscript messages={[toolCall]} />,
    );

    expect(screen.getAllByText('launch_task')).toHaveLength(1);

    rerender(<FastSessionTranscript messages={[toolResult]} />);

    expect(screen.getAllByText('launch_task')).toHaveLength(1);
  });

  it('cold-loads one completed tool row before an intervening kickoff', () => {
    render(
      <FastSessionTranscript
        messages={[
          {
            id: 'tool-1',
            eventId: 'turn-1:tool:0',
            turnId: 'turn-1',
            turnSeq: 1,
            ts: 2,
            eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
            role: 'tool',
            contentBlocks: [{ type: 'text', text: '{"success":true}' }],
            metadata: { visibleInTranscript: true },
            payload: {
              toolCallId: 'turn-1:tool:0',
              title: 'launch_task',
              kind: 'tool',
              status: 'completed',
              isExecute: false,
              isMcp: false,
              mcpServerName: null,
              mcpToolName: null,
              toolName: 'launch_task',
              command: null,
              exitCode: null,
              output: '{"success":true}',
              rawInput: { arguments: { prompt: 'Fix checkout' } },
            },
            source: 'slack',
            nativeSessionId: 'opencode-1',
            nativeMessageId: null,
            createdAt: new Date('2026-01-01T00:00:01.000Z'),
          },
          {
            id: 'kickoff-1',
            eventId: 'turn-1:assistant:0',
            turnId: 'turn-1',
            turnSeq: 2,
            ts: 3,
            eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
            role: 'assistant',
            contentBlocks: [
              { type: 'text', text: 'I started the checkout fix.' },
            ],
            metadata: { visibleInTranscript: true },
            payload: { purpose: 'progress', kickoff: true },
            source: 'slack',
            nativeSessionId: 'opencode-1',
            nativeMessageId: null,
            createdAt: new Date('2026-01-01T00:00:02.000Z'),
          },
        ]}
      />,
    );

    const activityToggle = screen.getByRole('button', {
      name: /Worked for/,
    });
    expect(screen.queryByText('launch_task')).not.toBeInTheDocument();

    fireEvent.click(activityToggle);

    expect(screen.getAllByText('launch_task')).toHaveLength(1);
    expect(screen.getByText('I started the checkout fix.')).toBeInTheDocument();
  });
});
