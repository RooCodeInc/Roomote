const {
  mockBootstrapWebRuntimeEnv,
  mockResolveComputeProviderSelection,
  mockResolveDefaultComputeProvider,
  runtimeState,
} = vi.hoisted(() => ({
  mockBootstrapWebRuntimeEnv: vi.fn().mockResolvedValue(undefined),
  mockResolveComputeProviderSelection: vi.fn().mockResolvedValue({
    defaultComputeProvider: 'modal',
    availableComputeProviders: ['modal', 'docker'],
  }),
  mockResolveDefaultComputeProvider: vi.fn().mockResolvedValue('roomote'),
  runtimeState: { cloudEnabled: false },
}));

vi.mock('@roomote/db/server', () => ({
  resolveComputeProviderSelection: mockResolveComputeProviderSelection,
  resolveDefaultComputeProvider: mockResolveDefaultComputeProvider,
}));

vi.mock('@/lib/server/env', () => ({
  Env: { R_CLOUD_ENABLED: 'cloud-setting' },
  isRoomoteCloudEnabled: () => runtimeState.cloudEnabled,
}));

vi.mock('@/lib/server/bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: mockBootstrapWebRuntimeEnv,
}));

import { resolveTaskLaunchConfig } from './task-launch-config';

describe('resolveTaskLaunchConfig', () => {
  beforeEach(() => {
    runtimeState.cloudEnabled = false;
    vi.clearAllMocks();
  });

  it('returns configured provider options outside cloud mode', async () => {
    await expect(resolveTaskLaunchConfig()).resolves.toEqual({
      defaultComputeProvider: 'modal',
      availableComputeProviders: ['modal', 'docker'],
    });
    expect(mockBootstrapWebRuntimeEnv).toHaveBeenCalledOnce();
    expect(mockResolveComputeProviderSelection).toHaveBeenCalledOnce();
  });

  it('avoids scanning picker options when cloud hides the picker', async () => {
    runtimeState.cloudEnabled = true;

    await expect(resolveTaskLaunchConfig()).resolves.toEqual({
      defaultComputeProvider: 'roomote',
      availableComputeProviders: ['roomote'],
    });
    expect(mockResolveDefaultComputeProvider).toHaveBeenCalledOnce();
    expect(mockResolveComputeProviderSelection).not.toHaveBeenCalled();
  });
});
