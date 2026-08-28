import type { AcpToolResultPayload } from '@roomote/types';

import { resolveToolPresentation } from '../tool-presentation';
import { resolveToolPresentationPolicy } from '../tool-presentation-policy';
import type { AcpToolResultUiMessage } from '../types';

function toolData(
  overrides: Partial<AcpToolResultPayload> = {},
): AcpToolResultPayload {
  return {
    toolCallId: 'call-1',
    kind: 'tool',
    title: 'custom_tool',
    isExecute: false,
    isMcp: false,
    mcpServerName: null,
    mcpToolName: null,
    command: null,
    exitCode: null,
    output: '{}',
    status: 'completed',
    ...overrides,
  };
}

function toolMessage(
  overrides: Partial<AcpToolResultPayload> = {},
): AcpToolResultUiMessage {
  const data = toolData(overrides);
  return {
    id: 'message-1',
    ts: 1,
    role: 'tool',
    partial: false,
    sessionId: 'session-1',
    updateType: 'roomote_runtime.tool_result',
    kind: 'tool_result',
    text: data.output,
    data,
  };
}

describe('tool presentation resolver', () => {
  it.each([
    [{ kind: 'execute', isExecute: true }, 'execute', 'terminal'],
    [{ kind: 'read' }, 'read', 'file'],
    [{ toolName: 'spill_grep' }, 'search', 'search'],
    [{ toolName: 'list_skills' }, 'list', 'folder'],
    [{ toolName: 'launch_task' }, 'task', 'task'],
    [{ toolName: 'save_memory' }, 'memory', 'memory'],
    [{ toolName: 'show_widget' }, 'widget', 'widget'],
  ] as const)('classifies %o as %s', (overrides, category, iconKey) => {
    expect(resolveToolPresentation(toolData(overrides))).toMatchObject({
      category,
      iconKey,
    });
  });

  it('uses Memory as the provider label without changing canonical identity', () => {
    expect(
      resolveToolPresentation(
        toolData({
          isMcp: true,
          mcpServerName: 'gbrain',
          mcpToolName: 'query',
          serverName: 'gbrain',
          toolName: 'query',
        }),
      ),
    ).toMatchObject({
      category: 'memory',
      providerLabel: 'Memory',
      identity: { serverName: 'gbrain', toolName: 'query' },
    });
  });

  it('uses meaningful receipt language for consequential task actions', () => {
    expect(
      resolveToolPresentation(toolData({ toolName: 'launch_task' })),
    ).toMatchObject({ verb: 'Started', object: 'Coding Task' });
    expect(
      resolveToolPresentation(
        toolData({ toolName: 'launch_task', status: 'failed' }),
      ),
    ).toMatchObject({ verb: 'Failed to Start', object: 'Coding Task' });
  });
});

describe('tool presentation policy', () => {
  it('keeps consequential receipts outside collapsed activity', () => {
    expect(
      resolveToolPresentationPolicy(
        toolMessage({ toolName: 'save_memory', kind: 'memory' }),
      ).activityMode,
    ).toBe('keep-visible');
  });

  it('keeps delegated task cards visible in narration mode only on card-enabled surfaces', () => {
    const message = toolMessage({
      toolName: 'launch_task',
      kind: 'task',
      output: JSON.stringify({ success: true, taskId: 'task-1' }),
    });

    expect(
      resolveToolPresentationPolicy(message, {
        delegatedTaskCardsEnabled: true,
        displayMode: 'narration',
      }),
    ).toMatchObject({
      renderAs: 'delegated-task-card',
      rowVisibility: 'visible',
      activityMode: 'keep-visible',
    });
    expect(
      resolveToolPresentationPolicy(message, {
        delegatedTaskCardsEnabled: false,
      }).renderAs,
    ).toBe('row');
  });

  it('keeps ordinary exploration hidden in narration mode', () => {
    expect(
      resolveToolPresentationPolicy(
        toolMessage({ toolName: 'read_file', kind: 'read' }),
        { displayMode: 'narration' },
      ).rowVisibility,
    ).toBe('hidden');
  });
});
