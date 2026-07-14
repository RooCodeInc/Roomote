import type {
  AcpToolCallUiMessage,
  AcpToolResultUiMessage,
  AcpUiMessage,
} from '../types';
import { buildAcpRenderBlocks } from '../render-blocks';

function explorationToolMessage(params: {
  id: string;
  ts: number;
  title: string | null;
  text?: string;
  mcp?: boolean;
  command?: string | null;
  kind: string | null;
  toolName?: string | null;
  payload?: Record<string, unknown>;
}): AcpToolResultUiMessage {
  return {
    id: params.id,
    ts: params.ts,
    role: 'tool',
    partial: false,
    sessionId: 'session-1',
    updateType: 'roomote_runtime.tool_result',
    kind: 'tool_result',
    text: params.text,
    data: {
      toolCallId: `call-${params.id}`,
      kind: params.kind,
      title: params.title,
      isExecute: params.kind === 'execute',
      isMcp: params.mcp ?? true,
      mcpServerName: params.mcp === false ? null : 'roomote',
      mcpToolName: params.mcp === false ? null : (params.toolName ?? null),
      serverName: params.mcp === false ? null : 'roomote',
      toolName: params.mcp === false ? null : (params.toolName ?? null),
      command: params.command ?? null,
      exitCode: null,
      output: params.text ?? '',
      status: 'completed',
      ...(params.payload ?? {}),
    },
  };
}

function readFileToolMessage(params: {
  id: string;
  ts: number;
  title: string | null;
  text?: string;
  mcp?: boolean;
  toolCallId?: string;
  payload?: Record<string, unknown>;
}): AcpToolResultUiMessage {
  const { toolCallId, payload, ...rest } = params;
  return explorationToolMessage({
    ...rest,
    kind: params.mcp === false ? 'read' : 'mcp',
    toolName: 'read_file',
    payload: {
      ...(toolCallId ? { toolCallId } : {}),
      ...(payload ?? {}),
    },
  });
}

function readFileToolCallMessage(params: {
  id: string;
  ts: number;
  title: string | null;
  toolCallId?: string;
  mcp?: boolean;
  payload?: Record<string, unknown>;
}): AcpToolCallUiMessage {
  const toolCallId = params.toolCallId ?? `call-${params.id}`;
  return {
    id: params.id,
    ts: params.ts,
    role: 'tool',
    partial: true,
    sessionId: 'session-1',
    updateType: 'roomote_runtime.tool_call',
    kind: 'tool_call',
    toolCallId,
    data: {
      toolCallId,
      kind: params.mcp === false ? 'read' : 'mcp',
      title: params.title,
      status: 'in_progress',
      isExecute: false,
      isRead: params.mcp === false,
      isMcp: params.mcp ?? true,
      mcpServerName: params.mcp === false ? null : 'roomote',
      mcpToolName: params.mcp === false ? null : 'read_file',
      serverName: params.mcp === false ? null : 'roomote',
      toolName: params.mcp === false ? null : 'read_file',
      command: null,
      ...(params.payload ?? {}),
    },
  };
}

function searchFilesToolMessage(params: {
  id: string;
  ts: number;
  title: string | null;
  text?: string;
  mcp?: boolean;
  payload?: Record<string, unknown>;
}): AcpToolResultUiMessage {
  return explorationToolMessage({
    ...params,
    kind: 'mcp',
    toolName: 'search_files',
  });
}

function listFilesToolMessage(params: {
  id: string;
  ts: number;
  title: string | null;
  text?: string;
  mcp?: boolean;
  payload?: Record<string, unknown>;
}): AcpToolResultUiMessage {
  return explorationToolMessage({
    ...params,
    kind: 'mcp',
    toolName: 'list_files',
  });
}

function executeExplorationToolMessage(params: {
  id: string;
  ts: number;
  title: string;
  command: string;
  text?: string;
}): AcpToolResultUiMessage {
  return explorationToolMessage({
    ...params,
    mcp: false,
    kind: 'execute',
  });
}

function subagentToolMessage(params: {
  id: string;
  ts: number;
  title: string;
  status?: 'in_progress' | 'completed' | 'failed';
}): AcpToolResultUiMessage {
  return explorationToolMessage({
    id: params.id,
    ts: params.ts,
    title: params.title,
    mcp: false,
    kind: 'subagent',
    payload: {
      isSubagentSpawn: true,
      status: params.status ?? 'completed',
      senderThreadId: 'thread-parent',
      receiverThreadIds: ['thread-child'],
      agentsStates: {
        'thread-child': {
          status: 'pendingInit',
          message: null,
        },
      },
    },
  });
}

function completedSubagentToolMessage(params: {
  id: string;
  ts: number;
  title: string;
  text: string;
}): AcpToolResultUiMessage {
  return explorationToolMessage({
    id: params.id,
    ts: params.ts,
    title: params.title,
    text: params.text,
    mcp: false,
    kind: 'subagent',
    payload: {
      isSubagentSpawn: true,
      status: 'completed',
      senderThreadId: 'thread-parent',
      receiverThreadIds: ['thread-child'],
      agentsStates: {
        'thread-child': {
          status: 'completed',
          message: params.text,
        },
      },
      output: params.text,
    },
  });
}

function pendingSubagentToolCallMessage(params: {
  id: string;
  ts: number;
  title: string;
}): AcpToolCallUiMessage {
  return {
    id: params.id,
    ts: params.ts,
    role: 'tool',
    partial: true,
    sessionId: 'session-1',
    updateType: 'roomote_runtime.tool_call',
    kind: 'tool_call',
    data: {
      toolCallId: `call-${params.id}`,
      kind: 'subagent',
      title: params.title,
      status: 'in_progress',
      isExecute: false,
      isRead: false,
      isMcp: false,
      mcpServerName: null,
      mcpToolName: null,
      command: null,
      isSubagentSpawn: true,
      senderThreadId: 'thread-parent',
      receiverThreadIds: [],
      agentsStates: {},
      prompt: 'Inspect the branch state and report back.',
      model: 'gpt-5.4',
      reasoningEffort: 'low',
    },
  };
}

function textMessage(id: string, ts: number): AcpUiMessage {
  return {
    id,
    ts,
    role: 'assistant',
    partial: false,
    sessionId: 'session-1',
    updateType: 'roomote_runtime.assistant_message',
    kind: 'text',
    text: 'Between reads',
    data: {},
  };
}

function childSessionTextMessage(params: {
  id: string;
  ts: number;
  text: string;
  sessionId?: string;
}): AcpUiMessage {
  return {
    id: params.id,
    ts: params.ts,
    role: 'assistant',
    partial: false,
    sessionId: params.sessionId ?? 'thread-child',
    updateType: 'roomote_runtime.assistant_message',
    kind: 'text',
    text: params.text,
    data: {},
  };
}

function childSessionUserPromptMessage(params: {
  id: string;
  ts: number;
  text: string;
  sessionId?: string;
}): AcpUiMessage {
  return {
    id: params.id,
    ts: params.ts,
    role: 'user',
    partial: false,
    sessionId: params.sessionId ?? 'thread-child',
    updateType: 'roomote_runtime.user_prompt',
    kind: 'text',
    text: params.text,
    data: {},
  };
}

function todoSectionMessage(id: string, ts: number): AcpUiMessage {
  return {
    id,
    ts,
    role: 'assistant',
    partial: false,
    sessionId: 'session-1',
    updateType: 'roomote_runtime.plan',
    kind: 'todo_section',
    text: 'Implement fix',
    data: {
      todoId: 'todo-1',
      content: 'Implement fix',
    },
  };
}

function userPromptMessage(params: {
  id: string;
  ts: number;
  text: string;
  images?: string[];
  visibleInTranscript?: boolean;
}): AcpUiMessage {
  return {
    id: params.id,
    ts: params.ts,
    role: 'user',
    partial: false,
    visibleInTranscript: params.visibleInTranscript,
    sessionId: 'session-1',
    updateType: 'roomote_runtime.user_prompt',
    kind: 'text',
    text: params.text,
    images: params.images,
    data: {},
  };
}

function userInputResponseMessage(params: {
  id: string;
  ts: number;
  text: string;
}): AcpUiMessage {
  return {
    id: params.id,
    ts: params.ts,
    role: 'user',
    partial: false,
    sessionId: 'session-1',
    updateType: 'roomote_runtime.request_user_input_response',
    kind: 'text',
    text: params.text,
    data: {},
  };
}

describe('buildAcpRenderBlocks', () => {
  it('groups consecutive file reads into one exploration block', () => {
    const entries = buildAcpRenderBlocks([
      readFileToolMessage({
        id: 'tool-1',
        ts: 1,
        title: 'Read server.ts',
        text: 'server content',
      }),
      readFileToolMessage({
        id: 'tool-2',
        ts: 2,
        title: 'Read evaluator.ts',
        text: 'evaluator content',
      }),
      readFileToolMessage({
        id: 'tool-3',
        ts: 3,
        title: 'Read task-runs.ts',
        text: 'task runs content',
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'tool_group',
      id: 'tool-1',
      ts: 1,
      action: 'Exploring',
      objectSummary: '3 files',
    });

    if (entries[0]?.kind !== 'tool_group') {
      throw new Error('Expected tool_group entry');
    }

    expect(entries[0].items).toHaveLength(3);
    expect(entries[0].items.map((item) => item.objectLabel)).toEqual([
      'server.ts',
      'evaluator.ts',
      'task-runs.ts',
    ]);
    expect(entries[0].items.map((item) => item.displayKind)).toEqual([
      'read',
      'read',
      'read',
    ]);
  });

  it('counts each invocation once when tool_call and tool_result share a toolCallId', () => {
    const entries = buildAcpRenderBlocks([
      readFileToolCallMessage({
        id: 'tool-1-call',
        ts: 1,
        title: 'Read server.ts',
        toolCallId: 'call-shared-1',
      }),
      readFileToolMessage({
        id: 'tool-1-result',
        ts: 2,
        title: 'Read server.ts',
        text: 'server content',
        toolCallId: 'call-shared-1',
      }),
      readFileToolCallMessage({
        id: 'tool-2-call',
        ts: 3,
        title: 'Read evaluator.ts',
        toolCallId: 'call-shared-2',
      }),
      readFileToolMessage({
        id: 'tool-2-result',
        ts: 4,
        title: 'Read evaluator.ts',
        text: 'evaluator content',
        toolCallId: 'call-shared-2',
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'tool_group',
      action: 'Exploring',
      objectSummary: '2 files',
    });

    if (entries[0]?.kind !== 'tool_group') {
      throw new Error('Expected tool_group entry');
    }

    expect(entries[0].items).toHaveLength(2);
    // The tool_result is preferred over the paired tool_call.
    expect(entries[0].items.map((item) => item.msg.kind)).toEqual([
      'tool_result',
      'tool_result',
    ]);
    expect(entries[0].items.map((item) => item.objectLabel)).toEqual([
      'server.ts',
      'evaluator.ts',
    ]);
    // Group identity stays anchored to the first message in the run, not the
    // deduped representative, so the React key and hash anchor stay stable as
    // results stream in.
    expect(entries[0].id).toBe('tool-1-call');
    expect(entries[0].ts).toBe(1);
  });

  it('keeps a stable group id and ts as results stream in', () => {
    // Before either result arrives, fewer than two calls are complete so the
    // run stays expanded as individual messages.
    const streamingEntries = buildAcpRenderBlocks([
      readFileToolCallMessage({
        id: 'tool-1-call',
        ts: 1,
        title: 'Read server.ts',
        toolCallId: 'call-shared-1',
      }),
      readFileToolCallMessage({
        id: 'tool-2-call',
        ts: 2,
        title: 'Read evaluator.ts',
        toolCallId: 'call-shared-2',
      }),
    ]);

    expect(streamingEntries.map((entry) => entry.kind)).toEqual([
      'message',
      'message',
    ]);

    // After the results arrive, the run collapses. The group id/ts must stay
    // anchored to the first message in the consecutive run.
    const settledEntries = buildAcpRenderBlocks([
      readFileToolCallMessage({
        id: 'tool-1-call',
        ts: 1,
        title: 'Read server.ts',
        toolCallId: 'call-shared-1',
      }),
      readFileToolMessage({
        id: 'tool-1-result',
        ts: 3,
        title: 'Read server.ts',
        text: 'server content',
        toolCallId: 'call-shared-1',
      }),
      readFileToolCallMessage({
        id: 'tool-2-call',
        ts: 2,
        title: 'Read evaluator.ts',
        toolCallId: 'call-shared-2',
      }),
      readFileToolMessage({
        id: 'tool-2-result',
        ts: 4,
        title: 'Read evaluator.ts',
        text: 'evaluator content',
        toolCallId: 'call-shared-2',
      }),
    ]);

    if (settledEntries[0]?.kind !== 'tool_group') {
      throw new Error('Expected tool_group entry');
    }

    expect(settledEntries[0].id).toBe('tool-1-call');
    expect(settledEntries[0].ts).toBe(1);
    expect(settledEntries[0].items.map((item) => item.msg.kind)).toEqual([
      'tool_result',
      'tool_result',
    ]);
  });

  it('does not collapse until the second same-type call completes', () => {
    const entries = buildAcpRenderBlocks([
      readFileToolMessage({
        id: 'tool-1-result',
        ts: 1,
        title: 'Read server.ts',
        text: 'server content',
      }),
      readFileToolCallMessage({
        id: 'tool-2-call',
        ts: 2,
        title: 'Read evaluator.ts',
        toolCallId: 'call-shared-2',
      }),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual(['message', 'message']);
    if (entries[0]?.kind !== 'message' || entries[1]?.kind !== 'message') {
      throw new Error('Expected plain message entries');
    }

    expect(entries[0].msg.kind).toBe('tool_result');
    expect(entries[1].msg.kind).toBe('tool_call');
  });

  it('appends later the third completed same-type call into the collapsed group', () => {
    const entries = buildAcpRenderBlocks([
      readFileToolMessage({
        id: 'tool-1',
        ts: 1,
        title: 'Read server.ts',
        text: 'server content',
      }),
      readFileToolMessage({
        id: 'tool-2',
        ts: 2,
        title: 'Read evaluator.ts',
        text: 'evaluator content',
      }),
      readFileToolMessage({
        id: 'tool-3',
        ts: 3,
        title: 'Read task-runs.ts',
        text: 'task runs content',
      }),
    ]);

    expect(entries).toHaveLength(1);
    if (entries[0]?.kind !== 'tool_group') {
      throw new Error('Expected tool_group entry');
    }

    expect(entries[0].objectSummary).toBe('3 files');
    expect(entries[0].items.map((item) => item.msg.id)).toEqual([
      'tool-1',
      'tool-2',
      'tool-3',
    ]);
  });

  it('renders a lone collapsed invocation as a plain tool message instead of a group', () => {
    const entries = buildAcpRenderBlocks([
      readFileToolCallMessage({
        id: 'tool-1-call',
        ts: 1,
        title: 'Read server.ts',
        toolCallId: 'call-shared-1',
      }),
      readFileToolMessage({
        id: 'tool-1-result',
        ts: 2,
        title: 'Read server.ts',
        text: 'server content',
        toolCallId: 'call-shared-1',
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe('message');

    if (entries[0]?.kind !== 'message') {
      throw new Error('Expected plain message entry');
    }

    // The result is preferred over the in-progress tool_call.
    expect(entries[0].msg.kind).toBe('tool_result');

    if (entries[0].msg.kind !== 'tool_result') {
      throw new Error('Expected tool_result message');
    }

    expect(entries[0].msg.data.title).toBe('Read server.ts');
  });

  it('does not mix different tool types into one collapsed group', () => {
    const entries = buildAcpRenderBlocks([
      searchFilesToolMessage({
        id: 'tool-search',
        ts: 1,
        title: 'Search Button.tsx',
      }),
      listFilesToolMessage({
        id: 'tool-list',
        ts: 2,
        title: 'List src/components',
      }),
      readFileToolMessage({
        id: 'tool-read',
        ts: 3,
        title: 'Read src/components/Button.tsx',
      }),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual([
      'message',
      'message',
      'message',
    ]);
  });

  it('uses payload labels when grouped MCP items have no descriptive title', () => {
    const entries = buildAcpRenderBlocks([
      readFileToolMessage({
        id: 'tool-read-1',
        ts: 1,
        title: null,
        payload: { path: 'src/components/Button.tsx' },
      }),
      readFileToolMessage({
        id: 'tool-read-2',
        ts: 2,
        title: null,
        payload: { path: 'src/components/Input.tsx' },
      }),
    ]);

    expect(entries).toHaveLength(1);

    if (entries[0]?.kind !== 'tool_group') {
      throw new Error('Expected tool_group entry');
    }

    expect(entries[0].items.map((item) => item.objectLabel)).toEqual([
      'src/components/Button.tsx',
      'src/components/Input.tsx',
    ]);
  });

  it('uses nested rawInput arguments when grouped MCP items omit top-level labels', () => {
    const entries = buildAcpRenderBlocks([
      readFileToolMessage({
        id: 'tool-read-1',
        ts: 1,
        title: null,
        payload: {
          rawInput: {
            tool: 'read_file',
            arguments: { path: 'src/components/Button.tsx' },
          },
        },
      }),
      readFileToolMessage({
        id: 'tool-read-2',
        ts: 2,
        title: null,
        payload: {
          rawInput: {
            tool: 'read_file',
            arguments: { path: 'src/components/Input.tsx' },
          },
        },
      }),
    ]);

    expect(entries).toHaveLength(1);

    if (entries[0]?.kind !== 'tool_group') {
      throw new Error('Expected tool_group entry');
    }

    expect(entries[0].items.map((item) => item.objectLabel)).toEqual([
      'src/components/Button.tsx',
      'src/components/Input.tsx',
    ]);
  });

  it('does not group title-only exploration messages without canonical metadata', () => {
    const entries = buildAcpRenderBlocks([
      explorationToolMessage({
        id: 'legacy-search',
        ts: 1,
        title: 'Search Button.tsx',
        mcp: false,
        kind: null,
      }),
      explorationToolMessage({
        id: 'legacy-list',
        ts: 2,
        title: 'List src/components',
        mcp: false,
        kind: null,
      }),
      explorationToolMessage({
        id: 'legacy-read',
        ts: 3,
        title: 'Read src/components/Button.tsx',
        mcp: false,
        kind: null,
      }),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual([
      'message',
      'message',
      'message',
    ]);
  });

  it('groups consecutive completed shell commands into one block', () => {
    const entries = buildAcpRenderBlocks([
      executeExplorationToolMessage({
        id: 'tool-search',
        ts: 1,
        title: 'Run ripgrep',
        command: 'rg Button src/components',
      }),
      executeExplorationToolMessage({
        id: 'tool-read',
        ts: 2,
        title: 'Run cat',
        command: 'cat src/components/Button.tsx',
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'tool_group',
      action: 'Ran',
      objectSummary: '2 commands',
      displayKind: 'execute',
    });

    if (entries[0]?.kind !== 'tool_group') {
      throw new Error('Expected tool_group entry');
    }

    expect(entries[0].items.map((item) => item.objectLabel)).toEqual([
      'rg Button src/components',
      'cat src/components/Button.tsx',
    ]);
  });

  it('does not mix shell commands with other tool types', () => {
    const entries = buildAcpRenderBlocks([
      executeExplorationToolMessage({
        id: 'tool-execute-1',
        ts: 1,
        title: 'Run ls',
        command: 'ls',
      }),
      executeExplorationToolMessage({
        id: 'tool-execute-2',
        ts: 2,
        title: 'Run pwd',
        command: 'pwd',
      }),
      readFileToolMessage({
        id: 'tool-read',
        ts: 3,
        title: 'Read package.json',
      }),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual([
      'tool_group',
      'message',
    ]);
  });

  it('uses lowercase plural-friendly labels for generic MCP tool groups', () => {
    const entries = buildAcpRenderBlocks([
      explorationToolMessage({
        id: 'tool-1',
        ts: 1,
        title: null,
        kind: 'mcp',
        toolName: 'get_issue',
      }),
      explorationToolMessage({
        id: 'tool-2',
        ts: 2,
        title: null,
        kind: 'mcp',
        toolName: 'get_issue',
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'tool_group',
      action: 'Used',
      objectSummary: '2 get issue calls',
      displayKind: 'tool',
    });
  });

  it('groups edit tools with edit-specific summary labels', () => {
    const entries = buildAcpRenderBlocks([
      explorationToolMessage({
        id: 'tool-edit-1',
        ts: 1,
        title: 'Edit src/a.ts',
        mcp: false,
        kind: 'edit',
      }),
      explorationToolMessage({
        id: 'tool-edit-2',
        ts: 2,
        title: 'Edit src/b.ts',
        mcp: false,
        kind: 'edit',
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'tool_group',
      action: 'Edited',
      objectSummary: '2 files',
      displayKind: 'edit',
    });
  });

  it('dedupes call/result pairs without a toolCallId via payload signature', () => {
    const callWithoutId = {
      ...readFileToolCallMessage({
        id: 'tool-1-call',
        ts: 1,
        title: 'Read server.ts',
        toolCallId: '',
      }),
      data: {
        ...readFileToolCallMessage({
          id: 'tool-1-call',
          ts: 1,
          title: 'Read server.ts',
          toolCallId: '',
        }).data,
        toolCallId: null,
      },
    } as AcpToolCallUiMessage;

    const resultWithoutId = {
      ...readFileToolMessage({
        id: 'tool-1-result',
        ts: 2,
        title: 'Read server.ts',
        text: 'server content',
        toolCallId: '',
      }),
      data: {
        ...readFileToolMessage({
          id: 'tool-1-result',
          ts: 2,
          title: 'Read server.ts',
          text: 'server content',
          toolCallId: '',
        }).data,
        toolCallId: null,
      },
    } as AcpToolResultUiMessage;

    const call2WithoutId = {
      ...readFileToolCallMessage({
        id: 'tool-2-call',
        ts: 3,
        title: 'Read evaluator.ts',
        toolCallId: '',
      }),
      data: {
        ...readFileToolCallMessage({
          id: 'tool-2-call',
          ts: 3,
          title: 'Read evaluator.ts',
          toolCallId: '',
        }).data,
        toolCallId: null,
      },
    } as AcpToolCallUiMessage;

    const result2WithoutId = {
      ...readFileToolMessage({
        id: 'tool-2-result',
        ts: 4,
        title: 'Read evaluator.ts',
        text: 'evaluator content',
        toolCallId: '',
      }),
      data: {
        ...readFileToolMessage({
          id: 'tool-2-result',
          ts: 4,
          title: 'Read evaluator.ts',
          text: 'evaluator content',
          toolCallId: '',
        }).data,
        toolCallId: null,
      },
    } as AcpToolResultUiMessage;

    const entries = buildAcpRenderBlocks([
      callWithoutId,
      resultWithoutId,
      call2WithoutId,
      result2WithoutId,
    ]);

    expect(entries).toHaveLength(1);
    if (entries[0]?.kind !== 'tool_group') {
      throw new Error('Expected tool_group entry');
    }

    expect(entries[0].items).toHaveLength(2);
    expect(entries[0].items.map((item) => item.msg.kind)).toEqual([
      'tool_result',
      'tool_result',
    ]);
    expect(entries[0].objectSummary).toBe('2 files');
  });

  it('does not group across non-tool messages', () => {
    const entries = buildAcpRenderBlocks([
      readFileToolMessage({
        id: 'tool-1',
        ts: 1,
        title: 'Read server.ts',
      }),
      textMessage('assistant-1', 2),
      readFileToolMessage({
        id: 'tool-2',
        ts: 3,
        title: 'Read evaluator.ts',
      }),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual([
      'message',
      'message',
      'message',
    ]);
  });

  it('groups legacy non-MCP read messages', () => {
    const entries = buildAcpRenderBlocks([
      readFileToolMessage({
        id: 'legacy-1',
        ts: 1,
        title: 'Read src/index.ts',
        mcp: false,
      }),
      readFileToolMessage({
        id: 'legacy-2',
        ts: 2,
        title: 'Read package.json',
        mcp: false,
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'tool_group',
      action: 'Exploring',
      objectSummary: '2 files',
    });
  });

  it('does not group across hidden boundary messages', () => {
    const entries = buildAcpRenderBlocks([
      readFileToolMessage({
        id: 'tool-1',
        ts: 1,
        title: 'Read server.ts',
      }),
      {
        id: 'plan-1',
        ts: 2,
        role: 'assistant',
        partial: false,
        sessionId: 'session-1',
        updateType: 'roomote_runtime.assistant_message',
        kind: 'plan',
        text: 'Planning next steps',
        data: { entries: [] },
      } satisfies AcpUiMessage,
      readFileToolMessage({
        id: 'tool-2',
        ts: 3,
        title: 'Read evaluator.ts',
      }),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual(['message', 'message']);
  });

  it('does not group across hidden tool boundary messages', () => {
    const entries = buildAcpRenderBlocks([
      readFileToolMessage({
        id: 'tool-1',
        ts: 1,
        title: 'Read server.ts',
      }),
      {
        id: 'tool-hidden',
        ts: 2,
        role: 'tool',
        partial: false,
        sessionId: 'session-1',
        updateType: 'roomote_runtime.tool_result',
        kind: 'tool_result',
        text: 'clicked button',
        data: {
          toolCallId: 'call-hidden',
          kind: 'mcp',
          title: 'browser-mcp/browser_click',
          isExecute: false,
          isMcp: true,
          mcpServerName: 'browser-mcp',
          mcpToolName: 'browser_click',
          serverName: 'browser-mcp',
          toolName: 'browser_click',
          command: null,
          exitCode: null,
          output: 'clicked button',
          status: 'completed',
        },
      } satisfies AcpUiMessage,
      readFileToolMessage({
        id: 'tool-2',
        ts: 3,
        title: 'Read evaluator.ts',
      }),
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual(['message', 'message']);
  });

  it('keeps grouping across transparent hidden messages', () => {
    const entries = buildAcpRenderBlocks([
      readFileToolMessage({
        id: 'tool-1',
        ts: 1,
        title: 'Read server.ts',
      }),
      {
        id: 'assistant-empty',
        ts: 2,
        role: 'assistant',
        partial: false,
        sessionId: 'session-1',
        updateType: 'roomote_runtime.assistant_message',
        kind: 'text',
        text: '',
        data: {},
      },
      readFileToolMessage({
        id: 'tool-2',
        ts: 3,
        title: 'Read evaluator.ts',
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'tool_group',
      objectSummary: '2 files',
    });
  });

  it('treats suppressed messages as group boundaries', () => {
    const entries = buildAcpRenderBlocks(
      [
        readFileToolMessage({
          id: 'tool-1',
          ts: 1,
          title: 'Read server.ts',
        }),
        {
          id: 'reasoning-1',
          ts: 2,
          role: 'assistant',
          partial: false,
          sessionId: 'session-1',
          updateType: 'roomote_runtime.assistant_thought',
          kind: 'reasoning',
          text: 'Hidden reasoning',
          data: {},
        },
        readFileToolMessage({
          id: 'tool-2',
          ts: 3,
          title: 'Read evaluator.ts',
        }),
      ],
      { suppressedMessageIds: new Set(['reasoning-1']) },
    );

    expect(entries.map((entry) => entry.kind)).toEqual(['message', 'message']);
  });

  it('does not group across session boundaries', () => {
    const first = readFileToolMessage({
      id: 'tool-1',
      ts: 1,
      title: 'Read server.ts',
    });
    const second = {
      ...readFileToolMessage({
        id: 'tool-2',
        ts: 2,
        title: 'Read evaluator.ts',
      }),
      sessionId: 'session-2',
    } satisfies AcpToolResultUiMessage;

    const entries = buildAcpRenderBlocks([first, second]);

    expect(entries.map((entry) => entry.kind)).toEqual(['message', 'message']);
  });

  it('drops grouped exploration sequences in narration mode', () => {
    const entries = buildAcpRenderBlocks(
      [
        searchFilesToolMessage({
          id: 'tool-search',
          ts: 1,
          title: 'Search Button.tsx',
        }),
        listFilesToolMessage({
          id: 'tool-list',
          ts: 2,
          title: 'List src/components',
        }),
        readFileToolMessage({
          id: 'tool-read',
          ts: 3,
          title: 'Read src/components/Button.tsx',
        }),
      ],
      { displayMode: 'narration' },
    );

    expect(entries).toEqual([]);
  });

  it('hides command output rows in narration mode while keeping text messages', () => {
    const entries = buildAcpRenderBlocks(
      [
        textMessage('assistant-1', 1),
        executeExplorationToolMessage({
          id: 'tool-execute',
          ts: 2,
          title: 'Run pnpm lint',
          command: 'pnpm lint',
          text: 'lint output',
        }),
        textMessage('assistant-2', 3),
      ],
      { displayMode: 'narration' },
    );

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.kind)).toEqual(['message', 'message']);
  });

  it('keeps subagent tool rows visible in narration mode', () => {
    const entries = buildAcpRenderBlocks(
      [
        textMessage('assistant-1', 1),
        subagentToolMessage({
          id: 'tool-subagent',
          ts: 2,
          title: 'Spawned subagent',
        }),
        textMessage('assistant-2', 3),
      ],
      { displayMode: 'narration' },
    );

    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'message',
      'message',
      'message',
    ]);

    if (entries[1]?.kind !== 'message') {
      throw new Error('Expected subagent tool entry');
    }

    expect(entries[1].msg.kind).toBe('tool_result');
    if (entries[1].msg.kind !== 'tool_result') {
      throw new Error('Expected subagent tool_result entry');
    }

    expect(entries[1].msg.data.kind).toBe('subagent');
  });

  it('keeps in-progress spawn rows and completed rows visible in narration mode', () => {
    const entries = buildAcpRenderBlocks(
      [
        textMessage('assistant-1', 1),
        pendingSubagentToolCallMessage({
          id: 'tool-subagent-pending',
          ts: 2,
          title: 'Spawning subagent',
        }),
        subagentToolMessage({
          id: 'tool-subagent-completed',
          ts: 3,
          title: 'Spawned subagent',
        }),
        textMessage('assistant-2', 4),
      ],
      { displayMode: 'narration' },
    );

    expect(entries).toHaveLength(4);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'message',
      'message',
      'message',
      'message',
    ]);

    if (entries[1]?.kind !== 'message' || entries[2]?.kind !== 'message') {
      throw new Error('Expected pending and completed subagent tool entries');
    }

    expect(entries[1].msg.kind).toBe('tool_call');
    if (entries[1].msg.kind !== 'tool_call') {
      throw new Error('Expected tool_call entry');
    }

    // A spawn row rebuilt from persisted envelopes (no live activity) stays
    // visible: a row that vanishes on refresh reads as a lost subagent.
    expect(entries[1].msg.data.title).toBe('Spawning subagent');

    expect(entries[2].msg.kind).toBe('tool_result');
    if (entries[2].msg.kind !== 'tool_result') {
      throw new Error('Expected tool_result entry');
    }

    expect(entries[2].msg.data.title).toBe('Spawned subagent');
  });

  it('keeps internal subagent rows visible in narration mode when debug UI is enabled', () => {
    const entries = buildAcpRenderBlocks(
      [
        textMessage('assistant-1', 1),
        pendingSubagentToolCallMessage({
          id: 'tool-subagent-pending',
          ts: 2,
          title: 'Spawning subagent',
        }),
        subagentToolMessage({
          id: 'tool-subagent-completed',
          ts: 3,
          title: 'Spawned subagent',
        }),
      ],
      {
        displayMode: 'narration',
        showInternalMessages: true,
      },
    );

    expect(entries).toHaveLength(3);

    if (
      entries[1]?.kind !== 'message' ||
      entries[2]?.kind !== 'message' ||
      entries[1].msg.kind !== 'tool_call' ||
      entries[2].msg.kind !== 'tool_result'
    ) {
      throw new Error('Expected pending and completed subagent entries');
    }

    expect(entries[1].msg.data.title).toBe('Spawning subagent');
    expect(entries[2].msg.data.title).toBe('Spawned subagent');
  });

  it('keeps completed subagent result rows visible in narration mode', () => {
    const entries = buildAcpRenderBlocks(
      [
        textMessage('assistant-1', 1),
        completedSubagentToolMessage({
          id: 'tool-subagent-finished',
          ts: 2,
          title: 'Subagent completed',
          text: 'Found the issue and confirmed the failing path.',
        }),
        textMessage('assistant-2', 3),
      ],
      { displayMode: 'narration' },
    );

    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'message',
      'message',
      'message',
    ]);

    if (entries[1]?.kind !== 'message') {
      throw new Error('Expected completed subagent row');
    }

    expect(entries[1].msg.kind).toBe('tool_result');
    if (entries[1].msg.kind !== 'tool_result') {
      throw new Error('Expected tool_result entry');
    }

    expect(entries[1].msg.data.title).toBe('Subagent completed');
    expect(entries[1].msg.text).toBe(
      'Found the issue and confirmed the failing path.',
    );
  });

  it('nests child-session assistant output under the parent subagent row', () => {
    const entries = buildAcpRenderBlocks(
      [
        textMessage('assistant-1', 1),
        completedSubagentToolMessage({
          id: 'tool-subagent-finished',
          ts: 2,
          title: 'Subagent completed',
          text: 'Found the issue and confirmed the failing path.',
        }),
        childSessionTextMessage({
          id: 'assistant-child-1',
          ts: 3,
          text: 'Child agent says hello.',
        }),
        textMessage('assistant-2', 4),
      ],
      { showInternalMessages: true },
    );

    expect(entries).toHaveLength(3);

    if (entries[1]?.kind !== 'message') {
      throw new Error('Expected completed subagent row');
    }

    expect(entries[1].msg.kind).toBe('tool_result');
    if (entries[1].msg.kind !== 'tool_result') {
      throw new Error('Expected tool_result entry');
    }

    expect(entries[1].childBlocks).toHaveLength(1);
    expect(entries[1].childBlocks?.[0]).toEqual({
      kind: 'message',
      msg: expect.objectContaining({
        id: 'assistant-child-1',
        text: 'Child agent says hello.',
      }),
    });
  });

  it('keeps child-session user prompts that match the initial prompt after a visible parent row', () => {
    const entries = buildAcpRenderBlocks(
      [
        completedSubagentToolMessage({
          id: 'tool-subagent-finished',
          ts: 1,
          title: 'Subagent completed',
          text: 'Found the issue and confirmed the failing path.',
        }),
        childSessionUserPromptMessage({
          id: 'child-user-prompt',
          ts: 2,
          text: 'Wake up and keep going',
        }),
      ],
      {
        showInternalMessages: true,
        shouldHideFirstMessage: true,
        initialPrompt: {
          text: 'Wake up and keep going',
        },
      },
    );

    expect(entries).toHaveLength(1);

    if (entries[0]?.kind !== 'message') {
      throw new Error('Expected completed subagent row');
    }

    expect(entries[0].childBlocks).toHaveLength(1);
    expect(entries[0].childBlocks?.[0]).toEqual({
      kind: 'message',
      msg: expect.objectContaining({
        id: 'child-user-prompt',
        text: 'Wake up and keep going',
      }),
    });
  });

  it('keeps child-session output attached to the first parent row when a later row repeats the same child session', () => {
    const entries = buildAcpRenderBlocks(
      [
        subagentToolMessage({
          id: 'tool-subagent-spawned',
          ts: 1,
          title: 'Spawned subagent',
          status: 'completed',
        }),
        completedSubagentToolMessage({
          id: 'tool-subagent-finished',
          ts: 2,
          title: 'Subagent completed',
          text: 'Found the issue and confirmed the failing path.',
        }),
        childSessionTextMessage({
          id: 'assistant-child-1',
          ts: 3,
          text: 'Child agent says hello.',
        }),
      ],
      { showInternalMessages: true },
    );

    expect(entries).toHaveLength(2);

    if (entries[0]?.kind !== 'message' || entries[1]?.kind !== 'message') {
      throw new Error('Expected subagent rows');
    }

    expect(entries[0].msg.id).toBe('tool-subagent-spawned');
    expect(entries[0].childBlocks).toHaveLength(1);
    expect(entries[0].childBlocks?.[0]).toEqual({
      kind: 'message',
      msg: expect.objectContaining({
        id: 'assistant-child-1',
        text: 'Child agent says hello.',
      }),
    });
    expect(entries[1].msg.id).toBe('tool-subagent-finished');
    expect(entries[1].childBlocks).toBeUndefined();
  });

  it('hides child-session output when debug-gated subagent rows are hidden', () => {
    const entries = buildAcpRenderBlocks(
      [
        textMessage('assistant-1', 1),
        completedSubagentToolMessage({
          id: 'tool-subagent-finished',
          ts: 2,
          title: 'Subagent completed',
          text: 'Found the issue and confirmed the failing path.',
        }),
        childSessionTextMessage({
          id: 'assistant-child-1',
          ts: 3,
          text: 'Child agent says hello.',
        }),
        textMessage('assistant-2', 4),
      ],
      { showInternalMessages: false },
    );

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.kind)).toEqual(['message', 'message']);
    expect(
      entries.some(
        (entry) =>
          entry.kind === 'message' &&
          entry.msg.kind === 'text' &&
          entry.msg.text === 'Child agent says hello.',
      ),
    ).toBe(false);
  });

  it('keeps the in-progress subagent spawn row visible in the default transcript', () => {
    const entries = buildAcpRenderBlocks([
      textMessage('assistant-1', 1),
      pendingSubagentToolCallMessage({
        id: 'tool-subagent-pending',
        ts: 2,
        title: 'Spawning subagent',
      }),
      subagentToolMessage({
        id: 'tool-subagent-completed',
        ts: 3,
        title: 'Spawned subagent',
      }),
      textMessage('assistant-2', 4),
    ]);

    expect(entries).toHaveLength(4);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'message',
      'message',
      'message',
      'message',
    ]);

    if (entries[1]?.kind !== 'message' || entries[2]?.kind !== 'message') {
      throw new Error('Expected pending and completed subagent tool entries');
    }

    expect(entries[1].msg.kind).toBe('tool_call');
    if (entries[1].msg.kind !== 'tool_call') {
      throw new Error('Expected tool_call entry');
    }

    expect(entries[1].msg.data.title).toBe('Spawning subagent');
    expect(entries[2].msg.kind).toBe('tool_result');
    if (entries[2].msg.kind !== 'tool_result') {
      throw new Error('Expected tool_result entry');
    }

    expect(entries[2].msg.data.title).toBe('Spawned subagent');
  });

  it('keeps spawn rows but hides thread-bound subagent rows when internal transcript rows are disabled', () => {
    const entries = buildAcpRenderBlocks(
      [
        textMessage('assistant-1', 1),
        pendingSubagentToolCallMessage({
          id: 'tool-subagent-pending',
          ts: 2,
          title: 'Spawning subagent',
        }),
        subagentToolMessage({
          id: 'tool-subagent-completed',
          ts: 3,
          title: 'Spawned subagent',
        }),
        textMessage('assistant-2', 4),
      ],
      { showInternalMessages: false },
    );

    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'message',
      'message',
      'message',
    ]);

    if (entries[1]?.kind !== 'message') {
      throw new Error('Expected pending spawn row entry');
    }

    expect(entries[1].msg.id).toBe('tool-subagent-pending');
  });

  it('hides Roomote Slack reply tool rows when internal transcript rows are disabled', () => {
    const entries = buildAcpRenderBlocks(
      [
        explorationToolMessage({
          id: 'tool-send-chat',
          ts: 1,
          title: 'send_chat_reply',
          text: 'Sent a Slack update.',
          kind: 'mcp',
          toolName: 'send_chat_reply',
        }),
        textMessage('assistant-2', 2),
      ],
      { showInternalMessages: false },
    );

    expect(entries).toEqual([
      {
        kind: 'message',
        msg: expect.objectContaining({
          id: 'assistant-2',
        }),
      },
    ]);
  });

  it('hides Roomote Slack reply tool results in narration mode', () => {
    const entries = buildAcpRenderBlocks(
      [
        explorationToolMessage({
          id: 'tool-send-chat',
          ts: 1,
          title: 'send_chat_reply',
          text: JSON.stringify({
            success: true,
            summary: 'Brief Slack update.',
          }),
          kind: 'mcp',
          toolName: 'send_chat_reply',
          payload: {
            output: JSON.stringify({
              success: true,
              summary: 'Brief Slack update.',
            }),
          },
        }),
        explorationToolMessage({
          id: 'tool-send-chat-closeout',
          ts: 2,
          title: 'send_chat_reply',
          text: JSON.stringify({
            success: true,
            message: 'Investigation result.',
            purpose: 'closeout',
          }),
          kind: 'mcp',
          toolName: 'send_chat_reply',
          payload: {
            output: JSON.stringify({
              success: true,
              message: 'Investigation result.',
              purpose: 'closeout',
            }),
          },
        }),
      ],
      { displayMode: 'narration' },
    );

    expect(entries).toEqual([]);
  });

  it('keeps Roomote Slack reply tool results visible in narration mode when debug UI is enabled', () => {
    const entries = buildAcpRenderBlocks(
      [
        explorationToolMessage({
          id: 'tool-send-chat',
          ts: 1,
          title: 'send_chat_reply',
          text: JSON.stringify({
            success: true,
            summary: 'Brief Slack update.',
          }),
          kind: 'mcp',
          toolName: 'send_chat_reply',
          payload: {
            output: JSON.stringify({
              success: true,
              summary: 'Brief Slack update.',
            }),
          },
        }),
      ],
      {
        displayMode: 'narration',
        showInternalMessages: true,
      },
    );

    expect(entries).toEqual([
      {
        kind: 'message',
        msg: expect.objectContaining({
          kind: 'tool_result',
          data: expect.objectContaining({
            title: 'send_chat_reply',
          }),
        }),
      },
    ]);
  });

  it('keeps todo section rows visible in narration mode', () => {
    const entries = buildAcpRenderBlocks(
      [
        todoSectionMessage('todo-section-1', 1),
        executeExplorationToolMessage({
          id: 'tool-execute',
          ts: 2,
          title: 'Run pnpm lint',
          command: 'pnpm lint',
          text: 'lint output',
        }),
      ],
      { displayMode: 'narration' },
    );

    expect(entries).toEqual([
      {
        kind: 'message',
        msg: expect.objectContaining({
          id: 'todo-section-1',
          kind: 'todo_section',
        }),
      },
    ]);
  });

  it('hides the first renderable user prompt when hidden bootstrap prompts come first', () => {
    const entries = buildAcpRenderBlocks(
      [
        userPromptMessage({
          id: 'hidden-bootstrap',
          ts: 1,
          text: '<request>bootstrap</request>',
          visibleInTranscript: false,
        }),
        userPromptMessage({
          id: 'visible-prompt',
          ts: 2,
          text: '<request>Tell me a pirate joke.</request>',
        }),
        textMessage('assistant-1', 3),
      ],
      {
        shouldHideFirstMessage: true,
        initialPrompt: {
          text: 'Tell me a pirate joke.',
        },
      },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'message',
      msg: {
        id: 'assistant-1',
      },
    });
  });

  it('does not hide request_user_input_response entries when suppressing the duplicate initial prompt', () => {
    const entries = buildAcpRenderBlocks(
      [
        userPromptMessage({
          id: 'hidden-bootstrap',
          ts: 1,
          text: '<request>bootstrap</request>',
          visibleInTranscript: false,
        }),
        userInputResponseMessage({
          id: 'user-input-response',
          ts: 2,
          text: 'Use the recommended option.',
        }),
        textMessage('assistant-1', 3),
      ],
      {
        shouldHideFirstMessage: true,
        initialPrompt: { text: 'bootstrap' },
      },
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: 'message',
      msg: {
        id: 'user-input-response',
      },
    });
    expect(entries[1]).toMatchObject({
      kind: 'message',
      msg: {
        id: 'assistant-1',
      },
    });
  });

  it('keeps the first follow-up user prompt when it does not duplicate the session prompt', () => {
    const entries = buildAcpRenderBlocks(
      [
        userPromptMessage({
          id: 'follow-up',
          ts: 1,
          text: 'yes',
        }),
        textMessage('assistant-1', 2),
      ],
      {
        shouldHideFirstMessage: true,
        initialPrompt: {
          text: 'Tell me a pirate joke.',
        },
      },
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: 'message',
      msg: {
        id: 'follow-up',
      },
    });
    expect(entries[1]).toMatchObject({
      kind: 'message',
      msg: {
        id: 'assistant-1',
      },
    });
  });

  it('keeps a later wake-up prompt even when it matches the session prompt', () => {
    const entries = buildAcpRenderBlocks(
      [
        textMessage('assistant-1', 1),
        userPromptMessage({
          id: 'wake-up',
          ts: 2,
          text: 'Wake up and keep going',
        }),
        textMessage('assistant-2', 3),
      ],
      {
        shouldHideFirstMessage: true,
        initialPrompt: {
          text: 'Wake up and keep going',
        },
      },
    );

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      kind: 'message',
      msg: {
        id: 'assistant-1',
      },
    });
    expect(entries[1]).toMatchObject({
      kind: 'message',
      msg: {
        id: 'wake-up',
      },
    });
    expect(entries[2]).toMatchObject({
      kind: 'message',
      msg: {
        id: 'assistant-2',
      },
    });
  });

  it('deduplicates repeated user image attachments after the first visible occurrence', () => {
    const entries = buildAcpRenderBlocks([
      userPromptMessage({
        id: 'prompt-1',
        ts: 1,
        text: 'first question',
        images: ['data:image/png;base64,AAA'],
      }),
      userPromptMessage({
        id: 'prompt-2',
        ts: 2,
        text: 'follow-up',
        images: ['data:image/png;base64,AAA'],
      }),
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: 'message',
      msg: {
        id: 'prompt-1',
        images: ['data:image/png;base64,AAA'],
      },
    });
    expect(entries[1]).toMatchObject({
      kind: 'message',
      msg: {
        id: 'prompt-2',
        images: undefined,
      },
    });
  });

  it('deduplicates user image attachments already shown in the session prompt', () => {
    const entries = buildAcpRenderBlocks(
      [
        userPromptMessage({
          id: 'prompt-1',
          ts: 1,
          text: 'follow-up',
          images: ['data:image/png;base64,AAA'],
        }),
      ],
      {
        initialPrompt: {
          text: 'initial prompt',
          images: ['data:image/png;base64,AAA'],
        },
      },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'message',
      msg: {
        id: 'prompt-1',
        images: undefined,
      },
    });
  });
});
