import type { AcpToolCallUiMessage, AcpUiMessage } from '../types';
import { buildAcpRenderBlocks } from '../render-blocks';

// A spawn row as it comes back from a transcript rebuild: persisted envelope
// data only, no live-only `subagentActivity` payload.
function rebuiltSpawnMessage(params: {
  id: string;
  status?: 'completed' | 'failed' | 'in_progress';
  payload?: Record<string, unknown>;
}): AcpToolCallUiMessage {
  return {
    id: params.id,
    ts: 1,
    role: 'tool',
    partial: false,
    sessionId: 'session-1',
    updateType: 'roomote_runtime.tool_call',
    kind: 'tool_call',
    data: {
      toolCallId: `call-${params.id}`,
      kind: 'subagent',
      title: 'Review polling queues',
      isSubagentSpawn: true,
      agentType: 'code-reviewer',
      isExecute: false,
      isRead: false,
      isMcp: false,
      mcpServerName: null,
      mcpToolName: null,
      serverName: null,
      toolName: 'task',
      command: null,
      status: params.status ?? 'in_progress',
      ...(params.payload ?? {}),
    },
  };
}

function renderedIds(
  messages: AcpUiMessage[],
  options?: Parameters<typeof buildAcpRenderBlocks>[1],
): string[] {
  return buildAcpRenderBlocks(messages, options).flatMap((block) =>
    block.kind === 'message' ? [block.msg.id] : [block.id],
  );
}

describe('subagent spawn row visibility', () => {
  it('renders an in-progress spawn row rebuilt without live activity', () => {
    const ids = renderedIds([rebuiltSpawnMessage({ id: 'spawn-1' })], {
      showInternalMessages: false,
    });

    expect(ids).toContain('spawn-1');
  });

  it('renders rebuilt spawn rows in narration mode', () => {
    const ids = renderedIds([rebuiltSpawnMessage({ id: 'spawn-1' })], {
      showInternalMessages: false,
      displayMode: 'narration',
    });

    expect(ids).toContain('spawn-1');
  });

  it('keeps non-spawn subagent payloads hidden without debug visibility', () => {
    const message = rebuiltSpawnMessage({
      id: 'plumbing-1',
      payload: { kind: 'other_tool' },
    });

    const ids = renderedIds([message], { showInternalMessages: false });

    expect(ids).not.toContain('plumbing-1');
  });

  it('keeps thread-bound subagent rows hidden without debug visibility', () => {
    const message = rebuiltSpawnMessage({
      id: 'thread-bound-1',
      payload: { receiverThreadIds: ['thread-child'] },
    });

    const ids = renderedIds([message], { showInternalMessages: false });

    expect(ids).not.toContain('thread-bound-1');
  });

  it('still shows non-spawn subagent payloads with debug visibility on', () => {
    const message = rebuiltSpawnMessage({
      id: 'plumbing-1',
      payload: { kind: 'other_tool' },
    });

    const ids = renderedIds([message], { showInternalMessages: true });

    expect(ids).toContain('plumbing-1');
  });
});
