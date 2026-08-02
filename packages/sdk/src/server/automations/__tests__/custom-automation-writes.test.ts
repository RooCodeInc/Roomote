import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  countCustomAutomations,
  createCustomAutomation,
  environmentFindFirst,
  getCustomAutomationById,
  listConnectedCommunicationProviders,
  resolveCustomAutomationSchedule,
  resolveDeploymentTimeZone,
  updateCustomAutomation,
  validateCronExpression,
} = vi.hoisted(() => ({
  countCustomAutomations: vi.fn(),
  createCustomAutomation: vi.fn(),
  environmentFindFirst: vi.fn(),
  getCustomAutomationById: vi.fn(),
  listConnectedCommunicationProviders: vi.fn(),
  resolveCustomAutomationSchedule: vi.fn(),
  resolveDeploymentTimeZone: vi.fn(),
  updateCustomAutomation: vi.fn(),
  validateCronExpression: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  countCustomAutomations,
  createCustomAutomation,
  db: { query: { environments: { findFirst: environmentFindFirst } } },
  environments: { id: 'environments.id' },
  eq: vi.fn((...args: unknown[]) => args),
  getCustomAutomationById,
  updateCustomAutomation,
}));

vi.mock('../custom-automation-schedule', () => ({
  resolveCustomAutomationSchedule,
  resolveDeploymentTimeZone,
  validateCronExpression,
}));

vi.mock('../destination', () => ({ listConnectedCommunicationProviders }));

import {
  createCustomAutomationWrite,
  updateCustomAutomationWrite,
  type CreateCustomAutomationWriteInput,
} from '../custom-automation-writes';
import {
  CustomAutomationWriteError,
  DUPLICATE_CUSTOM_AUTOMATION_NAME_MESSAGE,
} from '../custom-automation-errors';

const existing = {
  id: 'automation-1',
  name: 'Daily scan',
  prompt: 'Scan the repository.',
  enabled: false,
  scheduleMode: 'daily',
  cronExpression: null,
  model: 'anthropic/claude-sonnet-5',
  environmentId: 'environment-1',
  target: {
    provider: 'slack',
    targetKind: 'slack_channel',
    externalRef: 'C123',
  },
  createdByUserId: 'user-1',
  lastRunAt: null,
  lastSucceededAt: null,
  lastFailedAt: null,
  lastError: null,
  lastLaunchedTaskId: null,
  launchClaimedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

function createInput(
  schedule: CreateCustomAutomationWriteInput['schedule'],
): CreateCustomAutomationWriteInput {
  return {
    name: '  Daily   scan  ',
    prompt: '  Scan the repository.  ',
    enabled: true,
    schedule,
    model: ' anthropic/claude-sonnet-5 ',
    environmentId: 'environment-1',
    target: {
      provider: 'slack',
      channelId: ' C123 ',
    },
    createdByUserId: 'user-1',
  };
}

describe('custom automation writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    countCustomAutomations.mockResolvedValue(0);
    environmentFindFirst.mockResolvedValue({ id: 'environment-1' });
    listConnectedCommunicationProviders.mockResolvedValue(['slack']);
    resolveDeploymentTimeZone.mockResolvedValue({ timeZone: 'UTC' });
    validateCronExpression.mockImplementation((value: string) =>
      value.trim().replace(/\s+/g, ' '),
    );
    createCustomAutomation.mockImplementation(async (input) => ({
      ...existing,
      ...input,
      id: 'created-1',
    }));
    getCustomAutomationById.mockResolvedValue(existing);
    updateCustomAutomation.mockImplementation(async (_id, input) => ({
      ...existing,
      ...input,
    }));
  });

  it.each([
    ['REST schedule text', { schedule: 'daily', userId: 'user-1' }],
    ['web resolved schedule', { scheduleMode: 'daily' }],
  ])('normalizes equivalent create input from %s', async (_label, schedule) => {
    const result = await createCustomAutomationWrite(createInput(schedule));

    expect(result.status).toBe('saved');
    expect(createCustomAutomation).toHaveBeenCalledWith({
      name: 'Daily scan',
      prompt: 'Scan the repository.',
      enabled: true,
      scheduleMode: 'daily',
      cronExpression: null,
      model: 'anthropic/claude-sonnet-5',
      environmentId: 'environment-1',
      target: {
        provider: 'slack',
        targetKind: 'slack_channel',
        externalRef: 'C123',
      },
      createdByUserId: 'user-1',
    });
  });

  it('owns partial update merging and explicit target clearing', async () => {
    await updateCustomAutomationWrite(existing.id, {
      prompt: ' Updated prompt ',
      target: null,
    });

    expect(updateCustomAutomation).toHaveBeenCalledWith(existing.id, {
      name: existing.name,
      prompt: 'Updated prompt',
      enabled: false,
      scheduleMode: 'daily',
      cronExpression: null,
      model: existing.model,
      environmentId: existing.environmentId,
      target: {},
    });
  });

  it('validates cron schedules and supports clearing a model override', async () => {
    await updateCustomAutomationWrite(existing.id, {
      schedule: {
        scheduleMode: 'cron',
        cronExpression: ' 0  9 * * 1-5 ',
      },
      model: null,
    });

    expect(validateCronExpression).toHaveBeenCalledWith(
      ' 0  9 * * 1-5 ',
      'UTC',
    );
    expect(updateCustomAutomation).toHaveBeenCalledWith(
      existing.id,
      expect.objectContaining({
        scheduleMode: 'cron',
        cronExpression: '0 9 * * 1-5',
        model: null,
      }),
    );
  });

  it('returns an ambiguous natural-language schedule without writing', async () => {
    resolveCustomAutomationSchedule.mockResolvedValue({
      status: 'ambiguous',
      cronExpression: null,
      summary: 'Needs a time',
      clarification: 'What time should this run?',
      timeZone: 'UTC',
      nextRunAt: null,
    });

    const result = await createCustomAutomationWrite(
      createInput({ schedule: 'every weekday' }),
    );

    expect(result).toMatchObject({
      status: 'ambiguous',
      clarification: 'What time should this run?',
    });
    expect(createCustomAutomation).not.toHaveBeenCalled();
  });

  it('maps only the name uniqueness constraint to a stable domain error', async () => {
    createCustomAutomation.mockRejectedValue(
      Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'custom_automations_name_unique_idx',
      }),
    );

    await expect(
      createCustomAutomationWrite(createInput({ scheduleMode: 'daily' })),
    ).rejects.toMatchObject({
      code: 'duplicate_name',
      message: DUPLICATE_CUSTOM_AUTOMATION_NAME_MESSAGE,
    });
  });

  it.each([
    ['REST schedule text', { schedule: 'daily', userId: 'user-1' }],
    ['web resolved schedule', { scheduleMode: 'daily' }],
  ])(
    'rejects the same invalid model contract from %s',
    async (_label, schedule) => {
      await expect(
        createCustomAutomationWrite({
          ...createInput(schedule),
          model: 'no-provider-prefix',
        }),
      ).rejects.toMatchObject({
        code: 'invalid_input',
        message: 'Model must use provider/model format.',
      });
    },
  );

  it.each([
    [
      'missing cron',
      { schedule: { scheduleMode: 'cron' } },
      'Cron expression is required for a cron schedule.',
    ],
    [
      'missing destination channel',
      { target: { provider: 'slack' } },
      'Choose a destination channel',
    ],
  ])(
    'rejects %s with a typed validation error',
    async (_label, patch, message) => {
      const promise = createCustomAutomationWrite({
        ...createInput({ scheduleMode: 'daily' }),
        ...(patch as Partial<CreateCustomAutomationWriteInput>),
      });

      await expect(promise).rejects.toBeInstanceOf(CustomAutomationWriteError);
      await expect(promise).rejects.toThrow(message);
    },
  );
});
