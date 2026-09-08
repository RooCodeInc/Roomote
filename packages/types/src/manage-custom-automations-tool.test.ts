import { describe, expect, it } from 'vitest';

import {
  MANAGE_CUSTOM_AUTOMATIONS_ACTIONS,
  MANAGE_CUSTOM_AUTOMATIONS_TOOL,
  buildManageCustomAutomationsRequest,
  compactManageCustomAutomationsResult,
  manageCustomAutomationsInputSchema,
  automationWebhookConfigSchema,
} from './manage-custom-automations-tool';

describe('manage custom automations tool contract', () => {
  it.each([undefined, false, true])(
    'preserves removal opt-in %s',
    (forceLocalRemoval) => {
      const input = manageCustomAutomationsInputSchema.parse({
        action: 'webhook_remove',
        automationId: 'a',
        forceLocalRemoval,
      });
      expect(buildManageCustomAutomationsRequest(input)).toEqual({
        ok: true,
        request: {
          path: '/a/webhook',
          method: 'DELETE',
          ...(forceLocalRemoval === undefined
            ? {}
            : { body: { forceLocalRemoval } }),
        },
      });
    },
  );

  it.each(['true', 1, null])(
    'rejects non-boolean removal opt-in %j',
    (forceLocalRemoval) => {
      expect(
        manageCustomAutomationsInputSchema.safeParse({
          action: 'webhook_remove',
          forceLocalRemoval,
        }).success,
      ).toBe(false);
    },
  );

  it('restricts emergency forget to webhook_remove and documents orphan cleanup', () => {
    for (const action of MANAGE_CUSTOM_AUTOMATIONS_ACTIONS.filter(
      (action) => action !== 'webhook_remove',
    )) {
      for (const forceLocalRemoval of [false, true]) {
        expect(
          manageCustomAutomationsInputSchema.safeParse({
            action,
            forceLocalRemoval,
          }).success,
        ).toBe(false);
        expect(
          buildManageCustomAutomationsRequest({ action, forceLocalRemoval }).ok,
        ).toBe(false);
      }
    }
    expect(
      MANAGE_CUSTOM_AUTOMATIONS_TOOL.inputSchema.forceLocalRemoval.description,
    ).toContain('Admin-only emergency forget');
    expect(
      MANAGE_CUSTOM_AUTOMATIONS_TOOL.inputSchema.forceLocalRemoval.description,
    ).toContain('orphan requiring external cleanup');
  });

  it('defaults webhook configuration without subscribing to edits', () => {
    expect(automationWebhookConfigSchema.parse({})).toEqual({
      events: ['note.generated', 'note.access_granted'],
      folderIds: [],
      scopes: ['workspace'],
      maxRunsPerDay: 20,
      enabled: true,
    });
  });

  it.each([
    { events: [] },
    { events: ['generated'] },
    { scopes: [] },
    { scopes: ['workspace', 'personal'] },
    { scopes: ['unknown'] },
    { folderIds: ['invalid'] },
    { maxRunsPerDay: 0 },
    { maxRunsPerDay: 101 },
    { maxRunsPerDay: 1.5 },
  ])('rejects invalid webhook configuration %j', (input) => {
    expect(automationWebhookConfigSchema.safeParse(input).success).toBe(false);
  });

  it('builds webhook configuration from safe fields only', () => {
    expect(
      buildManageCustomAutomationsRequest({
        action: 'webhook_configure',
        automationId: 'a/b',
        prompt: 'not a filter',
        enabled: false,
        events: ['note.edited'],
      }),
    ).toEqual({
      ok: true,
      request: {
        path: '/a%2Fb/webhook',
        method: 'POST',
        body: {
          events: ['note.edited'],
          folderIds: [],
          scopes: ['workspace'],
          maxRunsPerDay: 20,
          enabled: false,
        },
      },
    });
  });

  it.each([
    ['webhook_inspect', 'GET', '/a%2Fb/webhook'],
    ['webhook_remove', 'DELETE', '/a%2Fb/webhook'],
    ['webhook_retry', 'POST', '/a%2Fb/webhook/deliveries/d%2Fe/retry'],
  ] as const)(
    'maps %s consistently for both MCP transports',
    (action, method, path) => {
      expect(
        buildManageCustomAutomationsRequest({
          action,
          automationId: 'a/b',
          deliveryId: 'd/e',
        }),
      ).toEqual({ ok: true, request: { method, path } });
      expect(buildManageCustomAutomationsRequest({ action }).ok).toBe(false);
    },
  );

  it('requires retry delivery IDs and validates configure inputs before transport', () => {
    expect(
      buildManageCustomAutomationsRequest({
        action: 'webhook_retry',
        automationId: 'a',
      }).ok,
    ).toBe(false);
    expect(
      buildManageCustomAutomationsRequest({
        action: 'webhook_configure',
        automationId: 'a',
        maxRunsPerDay: -1,
      }).ok,
    ).toBe(false);
    expect(
      buildManageCustomAutomationsRequest({ action: 'webhook_configure' }).ok,
    ).toBe(false);
  });

  it('preserves the service-safe subscription and delivery projection', () => {
    const payload = {
      subscription: { id: 's', status: 'active' },
      deliveries: [{ id: 'd', status: 'failed' }],
    };
    expect(
      compactManageCustomAutomationsResult('webhook_inspect', payload),
    ).toEqual(payload);
  });
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
      'Members can create and manage their own custom automations',
    );
    expect(MANAGE_CUSTOM_AUTOMATIONS_TOOL.description).toContain(
      'admins can manage all custom automations, including those without a creator',
    );
    expect(MANAGE_CUSTOM_AUTOMATIONS_TOOL.description).toContain(
      'The server enforces ownership',
    );
    expect(MANAGE_CUSTOM_AUTOMATIONS_TOOL.description).toContain(
      'Built-in automations and deployment settings remain admin-only',
    );
    expect(MANAGE_CUSTOM_AUTOMATIONS_TOOL.description).not.toContain(
      'Admin-only management of deployment custom automations',
    );
    expect(MANAGE_CUSTOM_AUTOMATIONS_TOOL.description).toContain(
      "inspect one automation's configured prompt by exact ID",
    );
    expect(MANAGE_CUSTOM_AUTOMATIONS_TOOL.description).toContain(
      'List results omit prompts',
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

  it('returns only the identified automation and prompt for inspection', () => {
    expect(
      compactManageCustomAutomationsResult('inspect', {
        automation: {
          id: 'automation-1',
          name: 'Daily report',
          prompt: 'Inspect this stored prompt.',
          enabled: true,
          scheduleMode: 'daily',
          environmentId: 'environment-1',
          createdByUser: { email: 'admin@example.com' },
          lastError: 'previous failure',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    ).toEqual({
      automation: {
        id: 'automation-1',
        name: 'Daily report',
        prompt: 'Inspect this stored prompt.',
      },
    });
  });

  it('builds a bounded inspection request and requires an automation ID', () => {
    expect(
      buildManageCustomAutomationsRequest({
        action: 'inspect',
        automationId: 'automation/1',
      }),
    ).toEqual({
      ok: true,
      request: { path: '/automation%2F1', method: 'GET' },
    });
    expect(buildManageCustomAutomationsRequest({ action: 'inspect' })).toEqual({
      ok: false,
      error: 'automationId is required for inspect',
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
