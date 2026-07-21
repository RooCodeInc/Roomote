import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      environments: { findFirst: vi.fn() },
      slackInstallations: { findFirst: vi.fn() },
    },
  },
  environments: {},
  eq: vi.fn((...args: unknown[]) => args),
  getCustomAutomationById: vi.fn(),
  getCustomAutomationFrequency: vi.fn(),
  isCustomAutomationPreviousRunActive: vi.fn(),
  listEnabledCustomAutomations: vi.fn(),
  recordCustomAutomationRunOutcome: vi.fn(),
  slackInstallations: {},
}));

vi.mock('../destination', () => ({
  buildDestinationTaskPayloadFields: vi.fn(() => ({})),
  listConnectedCommunicationProviders: vi.fn(async () => ['slack']),
}));

vi.mock('../scheduling-utils', () => ({
  isRunDue: vi.fn(),
  resolveSlackWorkspaceTimezone: vi.fn(async () => 'UTC'),
}));

import { enqueueTask } from '@roomote/cloud-agents/server';
import {
  db,
  getCustomAutomationById,
  getCustomAutomationFrequency,
  isCustomAutomationPreviousRunActive,
  listEnabledCustomAutomations,
  recordCustomAutomationRunOutcome,
} from '@roomote/db/server';
import { TaskPayloadKind } from '@roomote/types';

import {
  customAutomationsJob,
  runCustomAutomationNow,
} from '../custom-automations';
import { isRunDue } from '../scheduling-utils';

const automation = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Flaky tests',
  prompt: 'Find flaky tests and propose fixes.',
  enabled: true,
  scheduleMode: 'daily',
  environmentId: '22222222-2222-2222-2222-222222222222',
  target: {
    provider: 'slack',
    targetKind: 'slack_channel',
    externalRef: 'C123',
  },
  createdByUserId: null,
  lastRunAt: null,
  lastSucceededAt: null,
  lastFailedAt: null,
  lastError: null,
  lastLaunchedTaskId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('customAutomationsJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listEnabledCustomAutomations).mockResolvedValue([
      automation as never,
    ]);
    vi.mocked(getCustomAutomationFrequency).mockReturnValue('daily');
    vi.mocked(isCustomAutomationPreviousRunActive).mockResolvedValue(false);
    vi.mocked(isRunDue).mockReturnValue(true);
    vi.mocked(db.query.environments.findFirst).mockResolvedValue({
      id: automation.environmentId,
    } as never);
    vi.mocked(db.query.slackInstallations.findFirst).mockResolvedValue(
      undefined,
    );
    vi.mocked(enqueueTask).mockResolvedValue({
      taskId: 'task_abc',
    } as never);
  });

  it('launches a StandardTask for due automations', async () => {
    const result = await customAutomationsJob();

    expect(result.launchedTaskId).toBe('task_abc');
    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: TaskPayloadKind.StandardTask,
          payload: expect.objectContaining({
            environmentId: automation.environmentId,
            description: automation.prompt,
            repo: '',
          }),
        }),
        initiator: {
          kind: 'automation',
          key: 'custom_automation',
          actor: {
            externalId: automation.id,
            displayName: automation.name,
          },
        },
        title: automation.name,
        workflow: 'standard',
        surface: 'system',
        trigger: 'schedule',
        channels: { slackChannelId: 'C123' },
      }),
    );
    expect(recordCustomAutomationRunOutcome).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        id: automation.id,
        status: 'succeeded',
        lastLaunchedTaskId: 'task_abc',
      }),
    );
  });

  it('skips when previous run is still active', async () => {
    vi.mocked(isCustomAutomationPreviousRunActive).mockResolvedValue(true);

    const result = await customAutomationsJob();

    expect(result.launchedTaskId).toBeNull();
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it('skips when not due', async () => {
    vi.mocked(isRunDue).mockReturnValue(false);

    const result = await customAutomationsJob();

    expect(result.launchedTaskId).toBeNull();
    expect(enqueueTask).not.toHaveBeenCalled();
  });
});

describe('runCustomAutomationNow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCustomAutomationById).mockResolvedValue(automation as never);
    vi.mocked(getCustomAutomationFrequency).mockReturnValue('daily');
    vi.mocked(isCustomAutomationPreviousRunActive).mockResolvedValue(false);
    vi.mocked(db.query.environments.findFirst).mockResolvedValue({
      id: automation.environmentId,
    } as never);
    vi.mocked(enqueueTask).mockResolvedValue({
      taskId: 'task_manual',
    } as never);
  });

  it('launches with manual trigger', async () => {
    const result = await runCustomAutomationNow(automation.id);

    expect(result).toEqual({
      outcome: 'launched',
      taskId: 'task_manual',
    });
    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'manual',
      }),
    );
  });

  it('skips manual run when previous task is still active', async () => {
    vi.mocked(isCustomAutomationPreviousRunActive).mockResolvedValue(true);

    const result = await runCustomAutomationNow(automation.id);

    expect(result).toEqual({
      outcome: 'skipped',
      reason: 'Previous run is still active.',
    });
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it('fails when automation is disabled', async () => {
    vi.mocked(getCustomAutomationById).mockResolvedValue({
      ...automation,
      enabled: false,
    } as never);

    const result = await runCustomAutomationNow(automation.id);

    expect(result.outcome).toBe('failed');
    expect(enqueueTask).not.toHaveBeenCalled();
  });
});
