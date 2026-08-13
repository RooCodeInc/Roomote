import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockIsXaiSubscriptionConnected,
  mockGetPersistedEnvironmentVariableNames,
  mockDbTransaction,
  mockFetchModelsDevCatalog,
} = vi.hoisted(() => ({
  mockIsXaiSubscriptionConnected: vi.fn(),
  mockGetPersistedEnvironmentVariableNames: vi.fn(),
  mockDbTransaction: vi.fn(),
  mockFetchModelsDevCatalog: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    transaction: mockDbTransaction,
  },
  deploymentSettings: {
    id: 'id',
    taskModelSettings: 'taskModelSettings',
  },
  eq: vi.fn(),
  isXaiSubscriptionConnected: mockIsXaiSubscriptionConnected,
}));

vi.mock('../environment-variables', () => ({
  getPersistedEnvironmentVariableNames:
    mockGetPersistedEnvironmentVariableNames,
}));

vi.mock('./models-dev', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./models-dev')>();
  return {
    ...actual,
    fetchModelsDevCatalog: mockFetchModelsDevCatalog,
  };
});

import { syncConnectedXaiTaskModels } from './xai-models';

describe('syncConnectedXaiTaskModels', () => {
  const txInsertValues = vi.fn(() => ({
    onConflictDoUpdate: vi.fn(),
  }));

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsXaiSubscriptionConnected.mockResolvedValue(false);
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([]);
    mockFetchModelsDevCatalog.mockResolvedValue(null);
  });

  it('does nothing when xAI is not connected', async () => {
    await expect(syncConnectedXaiTaskModels()).resolves.toBe(0);
    expect(mockFetchModelsDevCatalog).not.toHaveBeenCalled();
    expect(mockDbTransaction).not.toHaveBeenCalled();
  });

  it('persists and enables newly published Grok chat models', async () => {
    mockIsXaiSubscriptionConnected.mockResolvedValue(true);
    mockFetchModelsDevCatalog.mockResolvedValue({
      models: {},
      providers: {
        xai: {
          models: {
            'grok-4.6': {
              name: 'Grok 4.6',
              modalities: { output: ['text'] },
            },
            'grok-4.7': {
              name: 'Grok 4.7',
              modalities: { output: ['text'] },
            },
            'grok-imagine-image': {
              name: 'Grok Imagine Image',
              modalities: { output: ['image'] },
            },
          },
        },
      },
      gatewayModelsByLowerSlug: {},
    });

    mockDbTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          select: vi.fn(() => ({
            from: vi.fn(() => ({
              where: vi.fn(() => ({
                limit: vi.fn(() => ({
                  for: vi.fn(async () => [
                    {
                      taskModelSettings: {
                        models: [
                          {
                            id: 'xai/grok-4.6',
                            displayName: 'Grok 4.6',
                            family: 'Grok',
                          },
                        ],
                        allowedModelIds: ['xai/grok-4.6'],
                        defaultModelId: 'xai/grok-4.6',
                      },
                    },
                  ]),
                })),
              })),
            })),
          })),
          insert: vi.fn(() => ({ values: txInsertValues })),
        }),
    );

    await expect(syncConnectedXaiTaskModels()).resolves.toBe(1);

    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        taskModelSettings: expect.objectContaining({
          allowedModelIds: expect.arrayContaining([
            'xai/grok-4.6',
            'xai/grok-4.7',
          ]),
          models: expect.arrayContaining([
            expect.objectContaining({ id: 'xai/grok-4.6' }),
            expect.objectContaining({ id: 'xai/grok-4.7' }),
          ]),
        }),
      }),
    );
    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        taskModelSettings: expect.objectContaining({
          models: expect.not.arrayContaining([
            expect.objectContaining({ id: 'xai/grok-imagine-image' }),
          ]),
        }),
      }),
    );
  });

  it('does not re-enable a Grok model the operator already removed', async () => {
    mockIsXaiSubscriptionConnected.mockResolvedValue(true);
    mockFetchModelsDevCatalog.mockResolvedValue({
      models: {},
      providers: {
        xai: {
          models: {
            'grok-4.6': {
              name: 'Grok 4.6',
              modalities: { output: ['text'] },
            },
            'grok-4.5': {
              name: 'Grok 4.5',
              modalities: { output: ['text'] },
            },
          },
        },
      },
      gatewayModelsByLowerSlug: {},
    });

    mockDbTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          select: vi.fn(() => ({
            from: vi.fn(() => ({
              where: vi.fn(() => ({
                limit: vi.fn(() => ({
                  for: vi.fn(async () => [
                    {
                      taskModelSettings: {
                        models: [
                          {
                            id: 'xai/grok-4.6',
                            displayName: 'Grok 4.6',
                            family: 'Grok',
                          },
                          {
                            id: 'xai/grok-4.5',
                            displayName: 'Grok 4.5',
                            family: 'Grok',
                          },
                        ],
                        allowedModelIds: ['xai/grok-4.6'],
                        defaultModelId: 'xai/grok-4.6',
                      },
                    },
                  ]),
                })),
              })),
            })),
          })),
          insert: vi.fn(() => ({ values: txInsertValues })),
        }),
    );

    await expect(syncConnectedXaiTaskModels()).resolves.toBe(0);
    expect(txInsertValues).not.toHaveBeenCalled();
  });

  it('merges new Grok models onto the locked settings row, not a stale unlocked snapshot', async () => {
    mockIsXaiSubscriptionConnected.mockResolvedValue(true);
    mockFetchModelsDevCatalog.mockResolvedValue({
      models: {},
      providers: {
        xai: {
          models: {
            'grok-4.6': {
              name: 'Grok 4.6',
              modalities: { output: ['text'] },
            },
            'grok-4.7': {
              name: 'Grok 4.7',
              modalities: { output: ['text'] },
            },
          },
        },
      },
      gatewayModelsByLowerSlug: {},
    });

    const lockedAfterSettingsSave = {
      models: [
        {
          id: 'xai/grok-4.6',
          displayName: 'Grok 4.6',
          family: 'Grok',
        },
        {
          id: 'xai/grok-4.5',
          displayName: 'Grok 4.5',
          family: 'Grok',
        },
      ],
      allowedModelIds: ['xai/grok-4.5'],
      defaultModelId: 'xai/grok-4.5',
    };
    const forUpdate = vi.fn(async () => [
      { taskModelSettings: lockedAfterSettingsSave },
    ]);

    mockDbTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          select: vi.fn(() => ({
            from: vi.fn(() => ({
              where: vi.fn(() => ({
                limit: vi.fn(() => ({
                  for: forUpdate,
                })),
              })),
            })),
          })),
          insert: vi.fn(() => ({ values: txInsertValues })),
        }),
    );

    await expect(syncConnectedXaiTaskModels()).resolves.toBe(1);

    expect(forUpdate).toHaveBeenCalledWith('update');
    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        taskModelSettings: expect.objectContaining({
          defaultModelId: 'xai/grok-4.5',
          allowedModelIds: expect.arrayContaining([
            'xai/grok-4.5',
            'xai/grok-4.7',
          ]),
        }),
      }),
    );
    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        taskModelSettings: expect.objectContaining({
          allowedModelIds: expect.not.arrayContaining(['xai/grok-4.6']),
        }),
      }),
    );
  });
});
