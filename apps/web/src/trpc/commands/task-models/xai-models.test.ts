import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockIsXaiSubscriptionConnected,
  mockGetPersistedEnvironmentVariableNames,
  mockDbSelect,
  mockDbTransaction,
  mockFetchModelsDevCatalog,
} = vi.hoisted(() => ({
  mockIsXaiSubscriptionConnected: vi.fn(),
  mockGetPersistedEnvironmentVariableNames: vi.fn(),
  mockDbSelect: vi.fn(),
  mockDbTransaction: vi.fn(),
  mockFetchModelsDevCatalog: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: mockDbSelect,
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

function mockUnlockedRead(rows: unknown[]) {
  mockDbSelect.mockImplementation(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => rows),
      })),
    })),
  }));
}

describe('syncConnectedXaiTaskModels', () => {
  const txUpdateWhere = vi.fn(async () => undefined);
  const txUpdateSet = vi.fn(() => ({ where: txUpdateWhere }));

  function mockLockedTransaction(rows: unknown[]) {
    const forUpdate = vi.fn(async () => rows);

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
          update: vi.fn(() => ({ set: txUpdateSet })),
        }),
    );

    return forUpdate;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsXaiSubscriptionConnected.mockResolvedValue(false);
    mockGetPersistedEnvironmentVariableNames.mockResolvedValue([]);
    mockFetchModelsDevCatalog.mockResolvedValue(null);
    mockUnlockedRead([]);
  });

  it('does nothing when xAI is not connected', async () => {
    await expect(syncConnectedXaiTaskModels()).resolves.toBe(0);
    expect(mockFetchModelsDevCatalog).not.toHaveBeenCalled();
    expect(mockDbTransaction).not.toHaveBeenCalled();
  });

  it('does not materialize implicit defaults when settings were never persisted', async () => {
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
          },
        },
      },
      gatewayModelsByLowerSlug: {},
    });
    mockUnlockedRead([]);

    await expect(syncConnectedXaiTaskModels()).resolves.toBe(0);
    expect(mockDbTransaction).not.toHaveBeenCalled();

    mockUnlockedRead([{ taskModelSettings: null }]);

    await expect(syncConnectedXaiTaskModels()).resolves.toBe(0);
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

    const persistedTaskModelSettings = {
      models: [
        {
          id: 'xai/grok-4.6',
          displayName: 'Grok 4.6',
          family: 'Grok',
        },
      ],
      allowedModelIds: ['xai/grok-4.6'],
      defaultModelId: 'xai/grok-4.6',
      // The baseline predates grok-4.7, so it counts as newly published.
      catalogSyncedModelIds: ['xai/grok-4.6'],
    };

    mockUnlockedRead([{ taskModelSettings: persistedTaskModelSettings }]);
    mockLockedTransaction([{ taskModelSettings: persistedTaskModelSettings }]);

    await expect(syncConnectedXaiTaskModels()).resolves.toBe(1);

    expect(txUpdateSet).toHaveBeenCalledWith(
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
          catalogSyncedModelIds: expect.arrayContaining([
            'xai/grok-4.6',
            'xai/grok-4.7',
          ]),
        }),
      }),
    );
    expect(txUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        taskModelSettings: expect.objectContaining({
          models: expect.not.arrayContaining([
            expect.objectContaining({ id: 'xai/grok-imagine-image' }),
          ]),
        }),
      }),
    );
  });

  it('records a baseline on the first sync instead of pulling in the back-catalog', async () => {
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
            'grok-4.3': {
              name: 'Grok 4.3',
              modalities: { output: ['text'] },
            },
            'grok-build-0.1': {
              name: 'Grok Build 0.1',
              modalities: { output: ['text'] },
            },
          },
        },
      },
      gatewayModelsByLowerSlug: {},
    });

    const persistedTaskModelSettings = {
      models: [
        {
          id: 'xai/grok-4.6',
          displayName: 'Grok 4.6',
          family: 'Grok',
        },
      ],
      allowedModelIds: ['xai/grok-4.6'],
      defaultModelId: 'xai/grok-4.6',
    };

    mockUnlockedRead([{ taskModelSettings: persistedTaskModelSettings }]);
    mockLockedTransaction([{ taskModelSettings: persistedTaskModelSettings }]);

    await expect(syncConnectedXaiTaskModels()).resolves.toBe(0);

    expect(txUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        taskModelSettings: expect.objectContaining({
          models: [expect.objectContaining({ id: 'xai/grok-4.6' })],
          allowedModelIds: ['xai/grok-4.6'],
          catalogSyncedModelIds: expect.arrayContaining([
            'xai/grok-4.6',
            'xai/grok-4.3',
            'xai/grok-build-0.1',
          ]),
        }),
      }),
    );
  });

  it('does not re-enable a Grok model the operator disabled', async () => {
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

    const persistedTaskModelSettings = {
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
    };

    mockUnlockedRead([{ taskModelSettings: persistedTaskModelSettings }]);
    mockLockedTransaction([{ taskModelSettings: persistedTaskModelSettings }]);

    // The first sync records the catalog ids it saw (so later deletions
    // stick) but adds nothing and keeps the disabled model disabled.
    await expect(syncConnectedXaiTaskModels()).resolves.toBe(0);

    expect(txUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        taskModelSettings: expect.objectContaining({
          allowedModelIds: ['xai/grok-4.6'],
          catalogSyncedModelIds: expect.arrayContaining([
            'xai/grok-4.6',
            'xai/grok-4.5',
          ]),
        }),
      }),
    );
  });

  it('does not re-add a Grok model the operator deleted', async () => {
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

    // grok-4.5 was synced before and then deleted from the model list.
    mockUnlockedRead([
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
          catalogSyncedModelIds: ['xai/grok-4.6', 'xai/grok-4.5'],
        },
      },
    ]);

    await expect(syncConnectedXaiTaskModels()).resolves.toBe(0);
    // Nothing to change, so the steady state never takes the row lock.
    expect(mockDbTransaction).not.toHaveBeenCalled();
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

    mockUnlockedRead([
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
          catalogSyncedModelIds: ['xai/grok-4.6'],
        },
      },
    ]);

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
      catalogSyncedModelIds: ['xai/grok-4.6', 'xai/grok-4.5'],
    };
    const forUpdate = mockLockedTransaction([
      { taskModelSettings: lockedAfterSettingsSave },
    ]);

    await expect(syncConnectedXaiTaskModels()).resolves.toBe(1);

    expect(forUpdate).toHaveBeenCalledWith('update');
    expect(txUpdateSet).toHaveBeenCalledWith(
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
    expect(txUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        taskModelSettings: expect.objectContaining({
          allowedModelIds: expect.not.arrayContaining(['xai/grok-4.6']),
        }),
      }),
    );
  });

  it('never throws: a failing connectivity check degrades to a no-op', async () => {
    mockIsXaiSubscriptionConnected.mockRejectedValue(
      new Error('connection reset'),
    );

    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(syncConnectedXaiTaskModels()).resolves.toBe(0);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('never throws: a failing transaction degrades to a no-op', async () => {
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
          },
        },
      },
      gatewayModelsByLowerSlug: {},
    });
    mockUnlockedRead([
      {
        taskModelSettings: {
          models: [],
          allowedModelIds: [],
          defaultModelId: 'xai/grok-4.6',
        },
      },
    ]);
    mockDbTransaction.mockRejectedValue(new Error('connection reset'));

    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(syncConnectedXaiTaskModels()).resolves.toBe(0);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
