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

  it('uses Memory language without exposing the internal provider identity', () => {
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
      providerLabel: undefined,
      verb: 'Searched',
      object: 'my memory',
      identity: { serverName: 'gbrain', toolName: 'query' },
    });
  });

  it.each([
    ['query', 'Searched', 'my memory'],
    ['search', 'Searched', 'my memory'],
    ['entity', 'Looked Up', 'a memory'],
    ['get_page', 'Read', 'a memory'],
    ['list_pages', 'Listed', 'memories'],
    ['synthesize', 'Summarized', 'my memory'],
    ['recall', 'Recalled From', 'my memory'],
  ] as const)(
    'uses natural Memory wording for %s',
    (toolName, verb, object) => {
      expect(
        resolveToolPresentation(
          toolData({
            isMcp: true,
            serverName: 'gbrain',
            toolName,
          }),
        ),
      ).toMatchObject({ verb, object, iconKey: 'memory' });
    },
  );

  it('describes Session-targeted manage_tasks actions accurately', () => {
    expect(
      resolveToolPresentation(
        toolData({
          isMcp: true,
          serverName: 'roomote',
          toolName: 'manage_tasks',
          rawInput: {
            arguments: { action: 'send_message', sessionId: 'session-1' },
          },
        } as never),
      ),
    ).toMatchObject({ verb: 'Sent', object: 'message to session' });
  });

  it('describes saved memories with an optional subject', () => {
    expect(
      resolveToolPresentation(
        toolData({
          toolName: 'save_memory',
          rawInput: {
            arguments: { memory: 'Bruno prefers Memory in UI copy.' },
          },
        } as never),
      ),
    ).toMatchObject({
      verb: 'Added',
      object: 'a memory about Bruno prefers Memory in UI copy.',
      iconKey: 'memory',
    });
    expect(
      resolveToolPresentation(toolData({ toolName: 'save_memory' })),
    ).toMatchObject({ verb: 'Added', object: 'a memory' });
    expect(
      resolveToolPresentation(
        toolData({
          isMcp: true,
          serverName: 'roomote',
          toolName: 'save_task_memory',
          rawInput: { outcome: 'Documented the conversation renderer.' },
        } as never),
      ),
    ).toMatchObject({
      verb: 'Added',
      object: 'a memory about Documented the conversation renderer.',
      providerLabel: undefined,
      iconKey: 'memory',
    });
  });

  it.each([
    ['start', 'Started', 'session'],
    ['search', 'Searched', 'sessions'],
    ['get_summary', 'Received', 'summary from task'],
    ['get_messages', 'Received', 'message from task'],
    ['send_message', 'Sent', 'message to task'],
    ['search_tasks', 'Searched', 'tasks'],
    ['get_compute_logs', 'Received', 'logs from task'],
    ['launch', 'Started', 'task'],
    ['cancel', 'Cancelled', 'task'],
    ['list_environments', 'Listed', 'environments'],
    ['list_models', 'Listed', 'models'],
    ['update_models', 'Updated', 'task model'],
  ] as const)(
    'uses natural manage_tasks wording for %s',
    (action, verb, object) => {
      expect(
        resolveToolPresentation(
          toolData({
            isMcp: true,
            serverName: 'roomote',
            toolName: 'manage_tasks',
            rawInput: { arguments: { action } },
          } as never),
        ),
      ).toMatchObject({ verb, object, providerLabel: undefined });
    },
  );

  it('suppresses only first-party Roomote attribution', () => {
    expect(
      resolveToolPresentation(
        toolData({
          isMcp: true,
          serverName: 'roomote',
          toolName: 'manage_goal',
        }),
      ).providerLabel,
    ).toBeUndefined();
    expect(
      resolveToolPresentation(
        toolData({ isMcp: true, serverName: 'gbrain', toolName: 'query' }),
      ).providerLabel,
    ).toBeUndefined();
    expect(
      resolveToolPresentation(
        toolData({
          isMcp: true,
          serverName: 'custom-roomote',
          toolName: 'run',
        }),
      ).providerLabel,
    ).toBe('Custom Roomote');
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
    ).toMatchObject({ verb: 'Started', object: 'coding task' });
    expect(
      resolveToolPresentation(
        toolData({ toolName: 'launch_task', status: 'failed' }),
      ),
    ).toMatchObject({ verb: 'Failed to Start', object: 'coding task' });
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
  it.each([
    'inspect_images',
    'report_to_parent_session',
    'send_task_message',
    'receive_task_report',
  ])('keeps %s expandable and standalone in every phase', (toolName) => {
    for (const status of ['in_progress', 'completed', 'failed'] as const) {
      expect(
        resolveToolPresentationPolicy(toolMessage({ toolName, status }), {
          displayMode: 'narration',
          showInternalMessages: false,
        }),
      ).toMatchObject({
        rowVisibility: 'visible',
        detailMode: 'expandable',
        activityMode: 'keep-visible',
        groupingMode: 'standalone',
      });
    }
  });

  it.each([
    ['in_progress', 'Sending'],
    ['completed', 'Sent'],
    ['failed', 'Failed to Send'],
  ] as const)('presents parent reports in phase %s', (status, verb) => {
    expect(
      resolveToolPresentation(
        toolData({ toolName: 'report_to_parent_session', status }),
      ),
    ).toMatchObject({
      verb,
      object: 'report to Session',
      category: 'communication',
    });
  });

  it.each(['read', 'read_file', 'spill_read', 'load_skill'])(
    'keeps ordinary %s details hidden',
    (toolName) => {
      expect(
        resolveToolPresentationPolicy(toolMessage({ toolName })).detailMode,
      ).toBe('none');
    },
  );

  it('keeps consequential receipts outside collapsed activity', () => {
    expect(
      resolveToolPresentationPolicy(
        toolMessage({ toolName: 'save_memory', kind: 'memory' }),
      ).activityMode,
    ).toBe('keep-visible');
  });

  it('collapses settled chat reply receipts outside narration mode', () => {
    const message = toolMessage({
      toolName: 'send_chat_reply',
      kind: 'communication',
    });

    expect(resolveToolPresentationPolicy(message).activityMode).toBe(
      'collapsible',
    );
    expect(
      resolveToolPresentationPolicy(message, { displayMode: 'narration' })
        .activityMode,
    ).toBe('keep-visible');
    expect(
      resolveToolPresentationPolicy(
        toolMessage({
          toolName: 'send_chat_reply',
          kind: 'communication',
          status: 'failed',
        }),
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

  it('hides integration tool discovery outside internal transcript debugging', () => {
    const message = toolMessage({
      title: 'find_integration_tools',
      toolName: 'find_integration_tools',
      kind: 'search',
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
