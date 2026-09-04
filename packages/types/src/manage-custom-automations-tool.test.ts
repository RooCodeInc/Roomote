import { describe, expect, it } from 'vitest';

import {
  MANAGE_CUSTOM_AUTOMATIONS_ACTIONS,
  MANAGE_CUSTOM_AUTOMATIONS_TOOL,
  buildManageCustomAutomationsRequest,
  compactManageCustomAutomationsResult,
  manageCustomAutomationsInputSchema,
} from './manage-custom-automations-tool';

describe('manage custom automations tool contract', () => {
  it('keeps every supported action in the shared Zod schema', () => {
    for (const action of MANAGE_CUSTOM_AUTOMATIONS_ACTIONS) {
      expect(manageCustomAutomationsInputSchema.parse({ action })).toEqual({
        action,
      });
    }
  });

  it('publishes the canonical descriptor and field descriptions', () => {
    expect(MANAGE_CUSTOM_AUTOMATIONS_TOOL.name).toBe(
      'manage_custom_automations',
    );
    expect(MANAGE_CUSTOM_AUTOMATIONS_TOOL.description).toContain(
      'Admin-only management of deployment custom automations.',
    );
    expect(MANAGE_CUSTOM_AUTOMATIONS_TOOL.description).toContain(
      'run the automation in Fast mode',
    );
    expect(MANAGE_CUSTOM_AUTOMATIONS_TOOL.description).toContain(
      'report it as queued or started, never completed',
    );
    expect(
      MANAGE_CUSTOM_AUTOMATIONS_TOOL.inputSchema.environmentId.description,
    ).toContain('Fast mode without an initial sandbox task');
    expect(
      MANAGE_CUSTOM_AUTOMATIONS_TOOL.inputSchema.schedule.description,
    ).toContain('off, every_hour, every_6_hours, daily, weekly');
    expect(
      MANAGE_CUSTOM_AUTOMATIONS_TOOL.inputSchema.prompt.description,
    ).toContain('Do not mention internal tool names or parameters.');
  });

  it('compacts list records to operational fields', () => {
    expect(
      compactManageCustomAutomationsResult('list', {
        automations: [
          {
            id: 'automation-1',
            name: 'Daily report',
            prompt: 'A very long prompt',
            enabled: true,
            scheduleMode: 'cron',
            cronExpression: '0 9 * * 1-5',
            model: 'openai/gpt-5.6-luna',
            reasoningEffort: 'high',
            environmentId: 'environment-1',
            target: {
              provider: 'slack',
              targetKind: 'slack_channel',
              externalRef: 'channel-1',
              metadata: { workspaceId: 'workspace-1' },
            },
            createdByUser: { id: 'user-1', email: 'admin@example.com' },
            lastError: 'previous failure',
            lastLaunchedTask: { id: 'task-1' },
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    ).toEqual({
      automations: [
        {
          id: 'automation-1',
          name: 'Daily report',
          enabled: true,
          schedule: '0 9 * * 1-5',
          model: 'openai/gpt-5.6-luna',
          reasoningEffort: 'high',
          environmentId: 'environment-1',
          targetProvider: 'slack',
          targetMode: 'channel',
          targetChannelId: 'channel-1',
          lastError: 'previous failure',
        },
      ],
    });
  });

  it('bounds persisted errors in list results', () => {
    const lastError = 'x'.repeat(1_000);
    const result = compactManageCustomAutomationsResult('list', {
      automations: [
        {
          id: 'automation-1',
          name: 'Daily report',
          enabled: true,
          scheduleMode: 'daily',
          lastError,
        },
      ],
    });

    expect(result).toEqual({
      automations: [
        {
          id: 'automation-1',
          name: 'Daily report',
          enabled: true,
          schedule: 'daily',
          lastError: `${'x'.repeat(497)}...`,
        },
      ],
    });
  });

  it('compacts every other action without losing follow-up fields', () => {
    const automation = {
      id: 'automation-1',
      name: 'Daily report',
      prompt: 'A very long prompt',
      enabled: false,
      scheduleMode: 'daily',
      cronExpression: null,
      model: null,
      reasoningEffort: 'high',
      environmentId: '__fast__',
      target: {
        provider: 'telegram',
        targetKind: 'telegram_user',
        externalRef: 'private-user-id',
      },
      lastError: 'previous failure',
    };
    const resolution = {
      status: 'ambiguous',
      cronExpression: null,
      summary: 'Needs a time',
      clarification: 'What time should this run?',
      timeZone: 'America/New_York',
      nextRunAt: null,
      inferenceUsage: { tokens: 500 },
    };

    expect(
      compactManageCustomAutomationsResult('list_models', {
        models: [
          {
            id: 'openai/gpt-5.6-luna',
            displayName: 'GPT 5.6 Luna',
            family: 'GPT',
            metadata: {
              contextWindow: 1_000_000,
              inputPricePerToken: 1,
              supportsReasoning: true,
            },
          },
        ],
        defaultModelId: 'openai/gpt-5.6-luna',
        providerConfig: { secret: 'not-for-the-model' },
      }),
    ).toEqual({
      models: [
        {
          id: 'openai/gpt-5.6-luna',
          displayName: 'GPT 5.6 Luna',
          supportsReasoning: true,
        },
      ],
      defaultModelId: 'openai/gpt-5.6-luna',
    });
    expect(
      compactManageCustomAutomationsResult('resolve_schedule', resolution),
    ).toEqual({
      status: 'ambiguous',
      cronExpression: null,
      summary: 'Needs a time',
      clarification: 'What time should this run?',
      timeZone: 'America/New_York',
      nextRunAt: null,
    });
    for (const action of ['create', 'update'] as const) {
      expect(
        compactManageCustomAutomationsResult(action, {
          automation,
          resolution,
          auditHistory: ['large'],
        }),
      ).toEqual({
        automation: {
          id: 'automation-1',
          name: 'Daily report',
          enabled: false,
          schedule: 'daily',
          model: null,
          reasoningEffort: 'high',
          environmentId: '__fast__',
          targetProvider: 'telegram',
          targetMode: 'direct_message',
        },
        resolution: {
          status: 'ambiguous',
          cronExpression: null,
          summary: 'Needs a time',
          clarification: 'What time should this run?',
          timeZone: 'America/New_York',
          nextRunAt: null,
        },
      });
    }
    expect(
      compactManageCustomAutomationsResult('delete', {
        deleted: { id: 'automation-1', name: 'Daily report', prompt: 'large' },
      }),
    ).toEqual({ deleted: { id: 'automation-1', name: 'Daily report' } });
    expect(
      compactManageCustomAutomationsResult('run_now', {
        outcome: 'launched',
        taskId: 'task-1',
        automation,
      }),
    ).toEqual({ outcome: 'launched', taskId: 'task-1' });
    expect(
      compactManageCustomAutomationsResult('create', {
        status: 'ambiguous',
        clarification: 'What time should this run?',
        resolution,
        candidateAutomations: [automation],
      }),
    ).toEqual({
      resolutionStatus: 'ambiguous',
      clarification: 'What time should this run?',
      resolution: {
        status: 'ambiguous',
        cronExpression: null,
        summary: 'Needs a time',
        clarification: 'What time should this run?',
        timeZone: 'America/New_York',
        nextRunAt: null,
      },
    });
    expect(
      compactManageCustomAutomationsResult('run_now', {
        outcome: 'failed',
        error: 'Automation is disabled.',
        automation,
      }),
    ).toEqual({ outcome: 'failed', error: 'Automation is disabled.' });
  });

  it('preserves explicit reasoning-effort clears while omitting unspecified values', () => {
    expect(
      buildManageCustomAutomationsRequest({
        action: 'update',
        automationId: 'automation-1',
        reasoningEffort: null,
      }),
    ).toEqual({
      ok: true,
      request: {
        path: '/automation-1',
        method: 'PATCH',
        body: { reasoningEffort: null },
      },
    });

    expect(
      buildManageCustomAutomationsRequest({
        action: 'update',
        automationId: 'automation-1',
      }),
    ).toEqual({
      ok: true,
      request: {
        path: '/automation-1',
        method: 'PATCH',
        body: {},
      },
    });
  });

  it('accepts only canonical reasoning-effort values', () => {
    expect(
      manageCustomAutomationsInputSchema.parse({
        action: 'create',
        reasoningEffort: 'xhigh',
      }).reasoningEffort,
    ).toBe('xhigh');
    expect(() =>
      manageCustomAutomationsInputSchema.parse({
        action: 'create',
        reasoningEffort: 'turbo',
      }),
    ).toThrow();
  });
});
