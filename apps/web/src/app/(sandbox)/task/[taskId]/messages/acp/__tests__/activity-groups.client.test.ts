import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

import type { TaskArtifact } from '@/types';

import {
  buildAcpActivityRenderBlocks,
  isActivityCollapsibleBlock,
} from '../activity-groups';
import type { AcpRenderBlock, GroupedToolCallRenderBlock } from '../render-blocks';
import type {
  AcpToolResultUiMessage,
  AcpUiMessage,
} from '../types';

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

  it('keeps todo section markers visible and uses them as a boundary', () => {
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
      'message',
      'message',
      'tool_group',
      'message',
    ]);
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

    if (visualProof.kind !== 'message' || visualProof.msg.kind !== 'tool_result') {
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

  it('keeps leading todo section markers visible', () => {
    const entries = buildAcpActivityRenderBlocks([
      messageBlock('leading', 1_000, 'reasoning'),
      messageBlock('todo-1', 1_500, 'todo_section'),
      textBlock('text-1', 2_000),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual([
      'message',
      'message',
      'message',
    ]);
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
