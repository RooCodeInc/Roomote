import {
  ACP_ENVELOPE_EVENT_TYPES,
  PROVIDER_RETRY_NOTICE_PAYLOAD_KEY,
} from '@roomote/types';

import type { TaskArtifact } from '@/types';

import {
  buildAcpActivityRenderBlocks,
  isActivityCollapsibleBlock,
} from '../activity-groups';
import type {
  AcpRenderBlock,
  GroupedToolCallRenderBlock,
} from '../render-blocks';
import type { AcpToolResultUiMessage } from '../types';

function textBlock(id: string, ts: number): AcpRenderBlock {
  return {
    kind: 'message',
    msg: {
      id,
      ts,
      role: 'assistant',
      kind: 'text',
      partial: false,
      sessionId: 'session-1',
      updateType: 'roomote_runtime.assistant_message',
      text: id,
      data: {},
    },
  };
}

function providerRetryBlock(params: {
  id: string;
  ts: number;
  retryAtMs?: number;
  partial?: boolean;
}): AcpRenderBlock {
  return {
    kind: 'message',
    msg: {
      id: params.id,
      ts: params.ts,
      role: 'assistant',
      kind: 'text',
      partial: params.partial === true,
      sessionId: 'session-1',
      updateType: 'roomote_runtime.assistant_message',
      text: 'Provider retry',
      data: {
        [PROVIDER_RETRY_NOTICE_PAYLOAD_KEY]: {
          kind: 'opencode_retry',
          attemptNumber: 1,
          maxAttempts: 3,
          showAttempt: false,
          errorSummary: 'Connection reset by server',
          ...(params.retryAtMs !== undefined
            ? { retryAtMs: params.retryAtMs }
            : {}),
        },
      },
    },
  };
}

function messageBlock(
  id: string,
  ts: number,
  kind: 'reasoning' | 'todo_section' | 'task_cancelled',
): AcpRenderBlock {
  if (kind === 'todo_section') {
    return {
      kind: 'message',
      msg: {
        id,
        ts,
        role: 'assistant',
        kind,
        partial: false,
        sessionId: 'session-1',
        updateType: ACP_ENVELOPE_EVENT_TYPES.Plan,
        text: id,
        data: { todoId: id, content: id },
      },
    };
  }

  return {
    kind: 'message',
    msg: {
      id,
      ts,
      role: kind === 'task_cancelled' ? 'system' : 'assistant',
      kind,
      partial: false,
      sessionId: 'session-1',
      updateType:
        kind === 'task_cancelled'
          ? ACP_ENVELOPE_EVENT_TYPES.TaskCancelled
          : ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
      text: id,
      data: kind === 'task_cancelled' ? { sessionId: 'session-1' } : {},
    },
  };
}

function toolResultBlock(params: {
  id: string;
  ts: number;
  toolName?: string;
  output?: string;
  kind?: string;
}): AcpRenderBlock {
  return {
    kind: 'message',
    msg: buildToolResult(params),
  };
}

function buildToolResult(params: {
  id: string;
  ts: number;
  toolName?: string;
  output?: string;
  kind?: string;
}): AcpToolResultUiMessage {
  return {
    id: params.id,
    ts: params.ts,
    role: 'tool',
    kind: 'tool_result',
    partial: false,
    sessionId: 'session-1',
    updateType: 'roomote_runtime.tool_result',
    text: params.output,
    data: {
      toolCallId: `call-${params.id}`,
      kind: params.kind ?? 'mcp',
      title: params.toolName ?? 'read_file',
      status: 'completed',
      isExecute: false,
      isMcp: true,
      mcpServerName: 'roomote',
      mcpToolName: params.toolName ?? 'read_file',
      serverName: 'roomote',
      toolName: params.toolName ?? 'read_file',
      command: null,
      output: params.output ?? '',
      exitCode: null,
    },
  };
}

function toolGroupBlock(params: {
  id: string;
  ts: number;
  items: AcpToolResultUiMessage[];
}): GroupedToolCallRenderBlock {
  return {
    kind: 'tool_group',
    id: params.id,
    ts: params.ts,
    action: 'Exploring',
    objectSummary: `${params.items.length} files`,
    groupKey: 'mcp:roomote:read_file',
    displayKind: 'read',
    items: params.items.map((msg) => ({
      msg,
      objectLabel: msg.data.title ?? 'Tool',
      groupKey: 'mcp:roomote:read_file',
      displayKind: 'read',
      stepKind: 'read',
    })),
  };
}

const visualProofArtifact: TaskArtifact = {
  id: 'artifact-1',
  path: 'tmp/proof.png',
  version: 1,
  artifactType: 'visual-proof',
  contentType: 'image/png',
  size: 123,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  thumbnailUrl: 'https://example.test/thumb.png',
};

describe('buildAcpActivityRenderBlocks', () => {
  it('collapses one eligible activity block between text messages', () => {
    const entries = buildAcpActivityRenderBlocks([
      textBlock('text-1', 1_000),
      messageBlock('reasoning-1', 2_000, 'reasoning'),
      textBlock('text-2', 19_000),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual([
      'message',
      'activity_group',
      'message',
    ]);
    expect(entries[1]).toMatchObject({
      kind: 'activity_group',
      ts: 2_000,
      endTs: 19_000,
    });
  });

  it('keeps live partial reasoning and tools outside collapsed activity groups', () => {
    const partialReasoning: AcpRenderBlock = {
      kind: 'message',
      msg: {
        id: 'reasoning-partial',
        ts: 2_000,
        role: 'assistant',
        kind: 'reasoning',
        partial: true,
        sessionId: 'session-1',
        updateType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        text: 'thinking…',
        data: {},
      },
    };

    const inProgressTool: AcpRenderBlock = {
      kind: 'message',
      msg: {
        id: 'tool-partial',
        ts: 3_000,
        role: 'tool',
        kind: 'tool_call',
        partial: true,
        sessionId: 'session-1',
        updateType: 'roomote_runtime.tool_call',
        data: {
          toolCallId: 'call-tool-partial',
          kind: 'mcp',
          title: 'read_file',
          status: 'in_progress',
          isExecute: false,
          isRead: true,
          isMcp: true,
          mcpServerName: 'roomote',
          mcpToolName: 'read_file',
          serverName: 'roomote',
          toolName: 'read_file',
          command: null,
        },
      },
    };

    const entries = buildAcpActivityRenderBlocks([
      textBlock('text-1', 1_000),
      partialReasoning,
      inProgressTool,
      textBlock('text-2', 4_000),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual([
      'message',
      'message',
      'message',
      'message',
    ]);
  });

  it('collapses mixed eligible activity blocks into one group', () => {
    const entries = buildAcpActivityRenderBlocks([
      textBlock('text-1', 1_000),
      messageBlock('reasoning-1', 2_000, 'reasoning'),
      toolGroupBlock({
        id: 'group-1',
        ts: 4_000,
        items: [
          buildToolResult({ id: 'tool-1', ts: 4_000 }),
          buildToolResult({ id: 'tool-2', ts: 5_000 }),
        ],
      }),
      textBlock('text-2', 10_000),
    ]);

    expect(entries).toHaveLength(3);
    expect(entries[1]?.kind).toBe('activity_group');

    if (entries[1]?.kind !== 'activity_group') {
      throw new Error('Expected activity group');
    }

    expect(entries[1].blocks.map((block) => block.kind)).toEqual([
      'message',
      'tool_group',
    ]);
  });

  it('collapses settled provider retry notices with neighboring activity', () => {
    const entries = buildAcpActivityRenderBlocks([
      textBlock('text-1', 1_000),
      messageBlock('reasoning-1', 2_000, 'reasoning'),
      providerRetryBlock({ id: 'retry-1', ts: 3_000, retryAtMs: 2_500 }),
      toolGroupBlock({
        id: 'group-1',
        ts: 4_000,
        items: [buildToolResult({ id: 'tool-1', ts: 4_000 })],
      }),
      textBlock('text-2', 10_000),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual([
      'message',
      'activity_group',
      'message',
    ]);

    if (entries[1]?.kind !== 'activity_group') {
      throw new Error('Expected activity group');
    }

    expect(entries[1].blocks.map((block) => block.kind)).toEqual([
      'message',
      'message',
      'tool_group',
    ]);
    expect(
      entries[1].blocks.map((block) =>
        block.kind === 'message' ? block.msg.id : block.id,
      ),
    ).toEqual(['reasoning-1', 'retry-1', 'group-1']);
  });

  it('keeps trailing provider retry notices expanded until a later text boundary', () => {
    const liveRetry = providerRetryBlock({
      id: 'retry-live',
      ts: 3_000,
      retryAtMs: Date.now() + 30_000,
    });
    const entries = buildAcpActivityRenderBlocks([
      textBlock('text-1', 1_000),
      messageBlock('reasoning-1', 2_000, 'reasoning'),
      liveRetry,
    ]);

    // Without a following narrative text turn, activity stays expanded so the
    // live retry status remains visible.
    expect(entries.map((entry) => entry.kind)).toEqual([
      'message',
      'message',
      'message',
    ]);
    expect(entries[2]).toMatchObject({
      kind: 'message',
      msg: { id: 'retry-live' },
    });
    expect(isActivityCollapsibleBlock(liveRetry)).toBe(true);
  });

  it('keeps todo section markers visible and starts a new activity boundary after them', () => {
    const entries = buildAcpActivityRenderBlocks([
      textBlock('text-1', 1_000),
      messageBlock('reasoning-1', 2_000, 'reasoning'),
      messageBlock('todo-1', 3_000, 'todo_section'),
      toolGroupBlock({
        id: 'group-1',
        ts: 4_000,
        items: [
          buildToolResult({ id: 'tool-1', ts: 4_000 }),
          buildToolResult({ id: 'tool-2', ts: 5_000 }),
        ],
      }),
      textBlock('text-2', 10_000),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual([
      'message',
      'activity_group',
      'message',
      'activity_group',
      'message',
    ]);

    expect(entries[1]).toMatchObject({
      kind: 'activity_group',
      ts: 2_000,
      endTs: 3_000,
    });

    expect(entries[3]).toMatchObject({
      kind: 'activity_group',
      ts: 4_000,
      endTs: 10_000,
    });
  });

  it('keeps task cancellation visible and uses it as a boundary', () => {
    const entries = buildAcpActivityRenderBlocks([
      textBlock('text-1', 1_000),
      messageBlock('reasoning-1', 2_000, 'reasoning'),
      messageBlock('cancel-1', 3_000, 'task_cancelled'),
      messageBlock('reasoning-2', 4_000, 'reasoning'),
      textBlock('text-2', 5_000),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual([
      'message',
      'message',
      'message',
      'message',
      'message',
    ]);
  });

  it('keeps manage_artifacts rows visible and uses them as a boundary', () => {
    const manageArtifacts = toolResultBlock({
      id: 'artifact-tool',
      ts: 3_000,
      toolName: 'manage_artifacts',
    });

    expect(isActivityCollapsibleBlock(manageArtifacts)).toBe(false);

    const entries = buildAcpActivityRenderBlocks([
      textBlock('text-1', 1_000),
      messageBlock('reasoning-1', 2_000, 'reasoning'),
      manageArtifacts,
      messageBlock('reasoning-2', 4_000, 'reasoning'),
      textBlock('text-2', 5_000),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual([
      'message',
      'message',
      'message',
      'message',
      'message',
    ]);
  });

  it('keeps visual-proof preview rows visible and uses them as a boundary', () => {
    const visualProof = toolResultBlock({
      id: 'subagent-proof',
      ts: 3_000,
      toolName: 'subagent',
      kind: 'subagent',
      output:
        'Uploaded proof https://example.test/task/task-1/artifacts/tmp/proof.png?v=1',
    });

    if (
      visualProof.kind !== 'message' ||
      visualProof.msg.kind !== 'tool_result'
    ) {
      throw new Error('Expected tool result');
    }

    visualProof.msg.data = {
      ...visualProof.msg.data,
      isMcp: false,
      isSubagentSpawn: true,
      receiverThreadIds: [],
    };

    expect(isActivityCollapsibleBlock(visualProof, [visualProofArtifact])).toBe(
      false,
    );

    const entries = buildAcpActivityRenderBlocks(
      [
        textBlock('text-1', 1_000),
        messageBlock('reasoning-1', 2_000, 'reasoning'),
        visualProof,
        messageBlock('reasoning-2', 4_000, 'reasoning'),
        textBlock('text-2', 5_000),
      ],
      { artifacts: [visualProofArtifact] },
    );

    expect(entries.map((entry) => entry.kind)).toEqual([
      'message',
      'message',
      'message',
      'message',
      'message',
    ]);
  });

  it('collapses leading eligible activity before the first text message', () => {
    const entries = buildAcpActivityRenderBlocks([
      messageBlock('leading', 1_000, 'reasoning'),
      textBlock('text-1', 2_000),
      messageBlock('trailing', 3_000, 'reasoning'),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual([
      'activity_group',
      'message',
      'message',
    ]);

    expect(entries[0]).toMatchObject({
      kind: 'activity_group',
      ts: 1_000,
      endTs: 2_000,
    });
  });

  it('keeps leading todo section markers visible and starts a new activity boundary after them', () => {
    const entries = buildAcpActivityRenderBlocks([
      messageBlock('leading', 1_000, 'reasoning'),
      messageBlock('todo-1', 1_500, 'todo_section'),
      messageBlock('reasoning-2', 1_700, 'reasoning'),
      textBlock('text-1', 2_000),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual([
      'activity_group',
      'message',
      'activity_group',
      'message',
    ]);

    expect(entries[0]).toMatchObject({
      kind: 'activity_group',
      ts: 1_000,
      endTs: 1_500,
    });

    expect(entries[2]).toMatchObject({
      kind: 'activity_group',
      ts: 1_700,
      endTs: 2_000,
    });
  });

  it('collapses leading activity when an external session prompt provides the left text boundary', () => {
    const entries = buildAcpActivityRenderBlocks(
      [
        messageBlock('reasoning-1', 2_000, 'reasoning'),
        textBlock('text-1', 10_000),
      ],
      { hasLeadingTextBoundary: true },
    );

    expect(entries.map((entry) => entry.kind)).toEqual([
      'activity_group',
      'message',
    ]);
    expect(entries[0]).toMatchObject({
      kind: 'activity_group',
      ts: 2_000,
      endTs: 10_000,
    });
  });

  it('bypasses grouping in narration mode', () => {
    const entries = buildAcpActivityRenderBlocks(
      [
        textBlock('text-1', 1_000),
        messageBlock('reasoning-1', 2_000, 'reasoning'),
        textBlock('text-2', 3_000),
      ],
      { displayMode: 'narration' },
    );

    expect(entries.map((entry) => entry.kind)).toEqual([
      'message',
      'message',
      'message',
    ]);
  });
});
