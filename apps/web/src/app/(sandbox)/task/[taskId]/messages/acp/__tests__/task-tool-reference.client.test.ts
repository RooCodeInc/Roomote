import { resolveTaskToolReference } from '../task-tool-reference';
import type { AcpToolResultUiMessage } from '../types';

function receipt(
  toolName: string,
  args: unknown = {},
  output: unknown = {},
): AcpToolResultUiMessage {
  return {
    id: 'receipt',
    ts: 1,
    role: 'tool',
    partial: false,
    sessionId: 'session-1',
    kind: 'tool_result',
    updateType: 'roomote_runtime.tool_result',
    data: {
      toolName,
      toolCallId: 'call',
      title: toolName,
      kind: 'mcp',
      isMcp: true,
      serverName: 'roomote',
      mcpServerName: 'roomote',
      mcpToolName: toolName,
      isExecute: false,
      status: 'completed',
      command: null,
      exitCode: null,
      output: JSON.stringify(output),
      ...{ rawInput: args },
    },
  };
}

describe('resolveTaskToolReference', () => {
  it.each([
    'launch_task',
    'review_pull_request',
    'send_task_message',
    'cancel_task',
    'retry_task_start',
    'receive_task_report',
  ])('resolves flat and nested %s arguments', (toolName) => {
    for (const args of [
      { taskId: ' child-42 ' },
      { arguments: { taskId: ' child-42 ' } },
    ]) {
      expect(resolveTaskToolReference(receipt(toolName, args))).toEqual({
        taskId: 'child-42',
      });
    }
  });

  it.each([
    'get_summary',
    'get_messages',
    'get_updates',
    'send_message',
    'cancel',
    'get_compute_logs',
    'launch',
    'update_models',
  ])('recognizes task-addressed manage_tasks %s', (action) => {
    expect(
      resolveTaskToolReference(
        receipt('manage_tasks', {
          arguments: { action, taskId: 'child-42', sessionId: 'not-a-task' },
        }),
      ),
    ).toEqual({ taskId: 'child-42' });
  });

  it.each(['get_summary', 'get_messages', 'get_updates', 'send_message'])(
    'does not identify a Session-targeted %s as a child task',
    (action) => {
      const msg = receipt(
        'manage_tasks',
        { action, sessionId: 'session-1' },
        { taskId: 'incidental-child' },
      );
      expect(
        resolveTaskToolReference(msg, { orderedTaskIds: ['sole-child'] }),
      ).toBeNull();
      expect(
        resolveTaskToolReference(msg, { currentTaskId: 'source-task' }),
      ).toEqual({ taskId: 'source-task' });
      expect(
        resolveTaskToolReference(receipt('manage_tasks', { action })),
      ).toBeNull();
    },
  );

  it.each([
    'start',
    'search',
    'search_tasks',
    'list_models',
    'list_environments',
    'nonsense',
    undefined,
  ])('leaves global or invalid management action %s semantic', (action) => {
    expect(
      resolveTaskToolReference(
        receipt(
          'manage_tasks',
          { action, taskId: 'child-42' },
          { taskId: 'child-42' },
        ),
        {
          currentTaskId: 'source-task',
          orderedTaskIds: ['child-42'],
        },
      ),
    ).toBeNull();
  });

  it.each([
    { taskId: 'child-42' },
    { result: { taskId: 'child-42' } },
    { data: { taskId: 'child-42' } },
    { result: { data: { taskId: 'child-42' } } },
    { target: { kind: 'task', id: 'child-42' } },
  ])('resolves structured result identity %j', (output) => {
    expect(
      resolveTaskToolReference(
        receipt('manage_tasks', { action: 'get_updates' }, output),
      ),
    ).toEqual({ taskId: 'child-42' });
  });

  it.each([
    { sessionId: 'session-1' },
    { target: { kind: 'session', id: 'session-1' } },
  ])('keeps Session result identity separate from task identity', (output) => {
    const msg = receipt('manage_tasks', { action: 'get_updates' }, output);
    expect(resolveTaskToolReference(msg)).toBeNull();
    expect(
      resolveTaskToolReference(msg, { currentTaskId: 'source-task' }),
    ).toEqual({ taskId: 'source-task' });
  });

  it('uses only source context for parent reports, never a sole child or output', () => {
    const msg = receipt(
      'report_to_parent_session',
      { taskId: 'other' },
      { taskId: 'other' },
    );
    expect(
      resolveTaskToolReference(msg, {
        currentTaskId: 'source-task',
        orderedTaskIds: ['sole-child'],
      }),
    ).toEqual({ taskId: 'source-task' });
    expect(
      resolveTaskToolReference(msg, { orderedTaskIds: ['sole-child'] }),
    ).toEqual({ taskId: null });
  });

  it('limits sole-task inference to the existing direct tools', () => {
    const context = { orderedTaskIds: ['sole-child'] };
    expect(
      resolveTaskToolReference(receipt('send_task_message'), context),
    ).toEqual({ taskId: 'sole-child' });
    expect(
      resolveTaskToolReference(receipt('receive_task_report'), context),
    ).toEqual({ taskId: null });
    expect(
      resolveTaskToolReference(
        receipt('manage_tasks', { action: 'launch' }),
        context,
      ),
    ).toEqual({ taskId: null });
  });

  it('uses the current task for implicit model updates', () => {
    expect(
      resolveTaskToolReference(
        receipt('manage_tasks', { action: 'update_models' }),
        { currentTaskId: 'source-task' },
      ),
    ).toEqual({ taskId: 'source-task' });
  });

  it.each([
    'send_task_message',
    'receive_task_report',
    'report_to_parent_session',
    'manage_tasks',
  ])('excludes foreign MCP %s even with a Roomote alias', (toolName) => {
    const msg = receipt(toolName, {
      action: 'send_message',
      taskId: 'child-42',
    });
    msg.data.serverName = 'linear';
    expect(
      resolveTaskToolReference(msg, { currentTaskId: 'source-task' }),
    ).toBeNull();
  });

  it('uses canonical tool names ahead of raw aliases', () => {
    const msg = receipt('manage_tasks', {
      action: 'send_message',
      taskId: 'child-42',
    });
    msg.data.toolName = 'list_environments';
    expect(resolveTaskToolReference(msg)).toBeNull();
  });

  it.each(['not JSON', 'null', '[]', '{"tasks":[{"taskId":"child-42"}]}'])(
    'retains an unknown eligible identity for non-target output %s',
    (output) => {
      const msg = receipt('receive_task_report');
      msg.data.output = output;
      expect(resolveTaskToolReference(msg)).toEqual({ taskId: null });
    },
  );
});
