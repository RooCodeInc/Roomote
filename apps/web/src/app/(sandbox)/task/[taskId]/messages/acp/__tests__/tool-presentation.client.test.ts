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

  it.each([
    ['manage_custom_automations', 'task'],
    ['get_about_me', 'roomote'],
    ['describe_video', 'video'],
    ['manage_goal', 'target'],
    ['manage_tasks', 'list-checks'],
    ['manage_source_control', 'pull-request'],
    ['manage_environments', 'environment'],
    ['save_task_memory', 'memory'],
    ['request_environment_variables', 'terminal'],
    ['report_platform_issue', 'alert'],
    ['submit_automation_work_items', 'task'],
    ['list_chat_channels', 'messages'],
    ['get_chat_channel_messages', 'messages'],
    ['get_chat_message_context', 'messages'],
  ] as const)('uses the %s icon for %s', (toolName, iconKey) => {
    expect(resolveToolPresentation(toolData({ toolName }))).toMatchObject({
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

  it('uses a known MCP integration’s catalog label and icon', () => {
    expect(
      resolveToolPresentation(
        toolData({
          isMcp: true,
          mcpServerName: 'sentry',
          mcpToolName: 'search_issues',
          serverName: 'sentry',
          toolName: 'search_issues',
        }),
      ),
    ).toMatchObject({
      integrationIcon: 'sentry',
      providerLabel: 'Sentry',
    });
  });

  it('keeps explicit tool icons ahead of an MCP integration icon', () => {
    expect(
      resolveToolPresentation(
        toolData({
          isMcp: true,
          mcpServerName: 'sentry',
          mcpToolName: 'manage_goal',
          serverName: 'sentry',
          toolName: 'manage_goal',
        }),
      ),
    ).toMatchObject({ iconKey: 'target', integrationIcon: undefined });
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

  it('sanitizes native fallback titles without using them for identity', () => {
    expect(
      resolveToolPresentation(
        toolData({
          title: 'Read /sandbox/repos/RooCodeInc/Roomote/apps/web/package.json',
          toolName: null,
        }),
      ),
    ).toMatchObject({
      displayName: 'Read RooCodeInc/Roomote/apps/web/package.json',
      object: 'Read RooCodeInc/Roomote/apps/web/package.json',
      identity: { toolName: null },
      groupKey: 'kind:tool',
    });
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

  it('hides ignore_event as internal lifecycle handling', () => {
    const message = toolMessage({
      title: 'ignore_event',
      toolName: 'ignore_event',
      kind: 'communication',
    });

    expect(
      resolveToolPresentationPolicy(message, {
        showInternalMessages: false,
      }).rowVisibility,
    ).toBe('debug-only');
    expect(
      resolveToolPresentationPolicy(message, {
        showInternalMessages: true,
      }).rowVisibility,
    ).toBe('visible');
  });
});
