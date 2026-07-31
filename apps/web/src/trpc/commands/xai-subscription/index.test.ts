import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockDisconnectXaiSubscription,
  mockGetXaiSubscriptionStatus,
  mockIsXaiSubscriptionConnected,
  mockPollXaiDeviceAuth,
  mockStartXaiDeviceAuth,
  mockAutoAddConnectedSubscriptionTaskModels,
} = vi.hoisted(() => ({
  mockDisconnectXaiSubscription: vi.fn(),
  mockGetXaiSubscriptionStatus: vi.fn(),
  mockIsXaiSubscriptionConnected: vi.fn(),
  mockPollXaiDeviceAuth: vi.fn(),
  mockStartXaiDeviceAuth: vi.fn(),
  mockAutoAddConnectedSubscriptionTaskModels: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  disconnectXaiSubscription: mockDisconnectXaiSubscription,
  getXaiSubscriptionStatus: mockGetXaiSubscriptionStatus,
  isXaiSubscriptionConnected: mockIsXaiSubscriptionConnected,
  pollXaiDeviceAuth: mockPollXaiDeviceAuth,
  startXaiDeviceAuth: mockStartXaiDeviceAuth,
}));

vi.mock('../task-models', () => ({
  autoAddConnectedSubscriptionTaskModels:
    mockAutoAddConnectedSubscriptionTaskModels,
}));

import {
  disconnectXaiSubscriptionCommand,
  pollXaiDeviceAuthCommand,
  startXaiDeviceAuthCommand,
} from './index';

const adminAuth = {
  userId: 'user-1',
  isAdmin: true,
} as never;

const nonAdminAuth = {
  userId: 'user-2',
  isAdmin: false,
} as never;

describe('xai subscription commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects non-admin operators', async () => {
    await expect(startXaiDeviceAuthCommand(nonAdminAuth)).rejects.toThrow(
      'Unauthorized',
    );
    await expect(
      pollXaiDeviceAuthCommand(nonAdminAuth, { deviceCode: 'device-1' }),
    ).rejects.toThrow('Unauthorized');
    await expect(
      disconnectXaiSubscriptionCommand(nonAdminAuth),
    ).rejects.toThrow('Unauthorized');
  });

  it('never returns access or refresh tokens from poll success', async () => {
    mockPollXaiDeviceAuth.mockResolvedValue({
      status: 'success',
      record: {
        refresh: 'refresh-secret',
        access: 'access-secret',
        expires: Date.now() + 60_000,
        status: 'connected',
        connectedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const result = await pollXaiDeviceAuthCommand(adminAuth, {
      deviceCode: 'device-1',
    });

    expect(result).toEqual({ status: 'success' });
    expect(result).not.toHaveProperty('record');
    expect(result).not.toHaveProperty('access');
    expect(result).not.toHaveProperty('refresh');
    expect(JSON.stringify(result)).not.toContain('access-secret');
    expect(JSON.stringify(result)).not.toContain('refresh-secret');
    expect(mockAutoAddConnectedSubscriptionTaskModels).toHaveBeenCalledWith(
      'xai-subscription',
    );
  });

  it('forwards pending and failed poll results without token fields', async () => {
    mockPollXaiDeviceAuth.mockResolvedValueOnce({
      status: 'pending',
      intervalMs: 7_000,
    });
    await expect(
      pollXaiDeviceAuthCommand(adminAuth, { deviceCode: 'device-1' }),
    ).resolves.toEqual({ status: 'pending', intervalMs: 7_000 });

    mockPollXaiDeviceAuth.mockResolvedValueOnce({
      status: 'failed',
      error: 'xAI device authorization was denied.',
    });
    await expect(
      pollXaiDeviceAuthCommand(adminAuth, { deviceCode: 'device-1' }),
    ).resolves.toEqual({
      status: 'failed',
      error: 'xAI device authorization was denied.',
    });
    expect(mockAutoAddConnectedSubscriptionTaskModels).not.toHaveBeenCalled();
  });
});
