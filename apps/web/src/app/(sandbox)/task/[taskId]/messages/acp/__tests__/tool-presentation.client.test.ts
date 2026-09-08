import type { AcpToolResultPayload } from '@roomote/types';

import {
  resolveToolPresentation,
  summarizeToolGroup,
} from '../tool-presentation';
import { resolveToolPresentationPolicy } from '../tool-presentation-policy';
import type { AcpToolResultUiMessage } from '../types';

function toolData(
  overrides: Partial<AcpToolResultPayload> & { rawInput?: unknown } = {},
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
    ['request_user_input', 'list'],
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

  it('humanizes summaries received from a child session as hearing back from a task', () => {
    expect(
      resolveToolPresentation(
        toolData({
          isMcp: true,
          serverName: 'roomote',
          toolName: 'manage_tasks',
          rawInput: {
            arguments: { action: 'get_summary', sessionId: 'session-1' },
          },
        } as never),
      ),
    ).toMatchObject({ verb: 'Heard back from', object: 'task' });
  });

  it('humanizes requests for user input', () => {
    expect(
      resolveToolPresentation(toolData({ toolName: 'request_user_input' })),
    ).toMatchObject({
      verb: 'Asked for',
      object: 'human guidance',
      iconKey: 'list',
    });
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
    ['get_summary', 'Heard back from', 'task'],
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

  it('never uses native fallback titles for headers or identity', () => {
    expect(
      resolveToolPresentation(
        toolData({
          title: 'Read /sandbox/repos/RooCodeInc/Roomote/apps/web/package.json',
          toolName: null,
        }),
      ),
    ).toMatchObject({
      displayName: 'Tool',
      verb: 'Completed',
      object: 'tool call',
      identity: { toolName: null },
      groupKey: 'kind:tool',
    });
  });

  it.each([
    [
      'read',
      { filePath: '/sandbox/repos/project/src/app.ts' },
      'Reading',
      'Read',
      'Failed to Read',
      'project/src/app.ts',
    ],
    [
      'read_file',
      { file_path: 'src/app.ts' },
      'Reading',
      'Read',
      'Failed to Read',
      'src/app.ts',
    ],
    [
      'spill_read',
      { path: 'src/app.ts' },
      'Reading',
      'Read',
      'Failed to Read',
      'src/app.ts',
    ],
    [
      'apply_patch',
      { patchText: '*** Delete File: a\n*** Delete File: b' },
      'Editing',
      'Edited',
      'Failed to Edit',
      '2 files',
    ],
    [
      'skill',
      { name: 'capture-visual-proof' },
      'Loading',
      'Loaded',
      'Failed to Load',
      'skill capture-visual-proof',
    ],
    [
      'load_skill',
      { name: 'capture-visual-proof' },
      'Loading',
      'Loaded',
      'Failed to Load',
      'skill capture-visual-proof',
    ],
  ] as const)(
    'presents native %s in all phases',
    (toolName, rawInput, running, completed, failed, object) => {
      for (const [status, verb] of [
        ['in_progress', running],
        ['completed', completed],
        ['failed', failed],
      ] as const) {
        const data = {
          ...toolData({ toolName }),
          rawInput,
          status,
          title: 'Success. Updated the following files: D /sandbox/repos/a',
        };
        expect(resolveToolPresentation(data)).toMatchObject({ verb, object });
        expect(resolveToolPresentation(data, true).verb).toBe(
          status === 'failed' ? failed : running,
        );
      }
    },
  );

  it.each([
    ['read', 'Read', 'file', 'read'],
    ['apply_patch', 'Edited', '', 'edit'],
    ['skill', 'Loaded', 'skill', 'generic'],
  ])(
    'presents historical %s without inventing identity',
    (kind, verb, object, category) => {
      expect(
        resolveToolPresentation(
          toolData({ kind, title: 'Loaded skill: arbitrary output' }),
        ),
      ).toMatchObject({
        verb,
        object,
        category,
        identity: { toolName: null },
        groupKey: `kind:${kind}`,
      });
    },
  );

  it('uses stored arguments for historical reads and nested skill calls', () => {
    expect(
      resolveToolPresentation(
        toolData({
          kind: 'read',
          rawInput: { filePath: '/sandbox/repos/project/a.ts' },
        }),
      ).object,
    ).toBe('project/a.ts');
    expect(
      resolveToolPresentation(
        toolData({
          toolName: 'skill',
          rawInput: { arguments: { name: '  capture-visual-proof\n' } },
        }),
      ).object,
    ).toBe('skill capture-visual-proof');
  });

  it('sanitizes before truncating paths and handles malformed arguments', () => {
    const filePath = `/sandbox/repos/${'a'.repeat(100)}`;
    expect(
      resolveToolPresentation(
        toolData({ toolName: 'read', rawInput: { filePath } }),
      ).object,
    ).toBe(`${'a'.repeat(77)}...`);
    for (const rawInput of [
      null,
      [],
      'bad',
      { filePath: 42, file_path: ' ', path: null },
    ]) {
      expect(
        resolveToolPresentation(toolData({ toolName: 'read', rawInput }))
          .object,
      ).toBe('file');
    }
  });

  it('keeps canonical identity ahead of historical kind and safe unknown language', () => {
    for (const [status, verb] of [
      ['in_progress', 'Running'],
      ['completed', 'Completed'],
      ['failed', 'Failed'],
    ] as const) {
      expect(
        resolveToolPresentation(
          toolData({
            toolName: 'custom_formatter',
            kind: 'read',
            status,
            title: 'Success. output',
          }),
        ),
      ).toMatchObject({ verb, object: 'Custom Formatter call' });
    }
    expect(
      resolveToolPresentation(
        toolData({ isMcp: true, toolName: 'read', mcpServerName: 'example' }),
      ),
    ).toMatchObject({ object: 'Read call', providerLabel: 'Example' });
  });

  it.each([
    [
      '*** Begin Patch\n*** Update File: /sandbox/repos/project/src/app.ts\n@@\n-old\n+new\n*** End Patch',
      'project/src/app.ts',
    ],
    ['*** Add File: new.ts\n+content', 'new.ts'],
    ['*** Delete File: old.ts', 'old.ts'],
    ['*** Update File: old.ts\n*** Move to: new.ts\n@@\n-a\n+b', 'new.ts'],
    [
      '*** Update File: same.ts\n@@\n-a\n+b\n*** Update File: same.ts\n@@\n-c\n+d',
      'same.ts',
    ],
    ['*** Delete File: old.ts\r\n*** Add File: new.ts\r\n+content', '2 files'],
    [
      '*** Update File: real.ts\n@@\n+*** Add File: not-a-target.ts\n-*** Delete File: also-not-a-target.ts',
      'real.ts',
    ],
    ['Success. Updated the following files: D output-only.ts', ''],
    ['*** Update File:   \n', ''],
  ])(
    'derives patch targets only from input operation headers',
    (patchText, object) => {
      for (const [status, verb] of [
        ['in_progress', 'Editing'],
        ['completed', 'Edited'],
        ['failed', 'Failed to Edit'],
      ] as const) {
        const data = toolData({
          kind: 'apply_patch',
          status,
          rawInput: { patchText },
          title: 'wrong.ts',
          output: 'Success. Updated wrong.ts',
        });
        expect(resolveToolPresentation(data)).toMatchObject({ verb, object });
        expect(data.output).toBe('Success. Updated wrong.ts');
      }
    },
  );

  it.each(['Add', 'Update', 'Delete'])(
    'distinguishes space-prefixed context from a real %s operation after an update hunk',
    (operation) => {
      // OpenCode v1.18.10 parseUpdateFileChunks stops at an unprefixed ***;
      // unchanged context starts with a space, including header-like content.
      const prefix =
        '*** Begin Patch\n*** Update File: real.ts\n@@\n-old\n+new\n';
      const header = `*** ${operation} File: example.ts`;
      const suffix =
        operation === 'Add'
          ? '\n+content'
          : operation === 'Update'
            ? '\n@@\n-a\n+b'
            : '';
      const present = (patchText: string) =>
        resolveToolPresentation(
          toolData({
            toolName: 'apply_patch',
            rawInput: { patchText },
          }),
        );

      expect(present(`${prefix} ${header}\n*** End Patch`)).toMatchObject({
        verb: 'Edited',
        object: 'real.ts',
      });
      expect(
        present(`${prefix}${header}${suffix}\n*** End Patch`),
      ).toMatchObject({ verb: 'Edited', object: '2 files' });
    },
  );

  it('uses structured native edit paths and nested patch arguments', () => {
    for (const key of ['filePath', 'file_path', 'path']) {
      expect(
        resolveToolPresentation(
          toolData({
            toolName: 'edit',
            rawInput: { [key]: '/sandbox/repos/project/file.ts' },
          }),
        ),
      ).toMatchObject({ verb: 'Edited', object: 'project/file.ts' });
    }
    expect(
      resolveToolPresentation(
        toolData({
          toolName: 'apply_patch',
          rawInput: { arguments: { patchText: '*** Delete File: old.ts' } },
        }),
      ).object,
    ).toBe('old.ts');
    expect(
      resolveToolPresentation(
        toolData({
          toolName: 'apply_patch',
          rawInput: {
            patchText: `*** Update File: /sandbox/repos/${'a'.repeat(100)}`,
          },
        }),
      ).object,
    ).toBe(`${'a'.repeat(77)}...`);
  });

  it.each([
    undefined,
    null,
    'invalid',
    [],
    { patchText: 3 },
    { filePath: false },
  ])('keeps unavailable edit targets safe', (rawInput) => {
    for (const toolName of ['apply_patch', 'edit']) {
      expect(
        resolveToolPresentation(
          toolData({
            toolName,
            rawInput,
            title: 'fake.ts',
            output: 'D fake.ts',
          }),
        ),
      ).toMatchObject({ verb: 'Edited', object: '' });
    }
  });

  it('counts edit calls rather than assuming each patch changes one file', () => {
    expect(summarizeToolGroup('edit', 2, 'Apply Patch')).toEqual({
      action: 'Edited',
      objectSummary: '2 edits',
    });
    expect(
      summarizeToolGroup(
        'generic',
        2,
        resolveToolPresentation(toolData({ title: 'Success. output' }))
          .displayName,
      ),
    ).toEqual({ action: 'Used', objectSummary: '2 tool calls' });
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
