const { mockSetBrainEnabled } = vi.hoisted(() => ({
  mockSetBrainEnabled: vi.fn(async () => undefined),
}));

vi.mock('@roomote/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/db/server')>()),
  setBrainEnabled: mockSetBrainEnabled,
}));

import type { UserAuthSuccess } from '@/types';

import { setMemoryEnabledCommand } from './index';

function auth(isAdmin: boolean): UserAuthSuccess {
  return { isAdmin } as UserAuthSuccess;
}

beforeEach(() => {
  mockSetBrainEnabled.mockClear();
});

describe('setMemoryEnabledCommand', () => {
  it('is admin-only', async () => {
    await expect(
      setMemoryEnabledCommand(auth(false), { enabled: true }),
    ).rejects.toThrow('Unauthorized');
    expect(mockSetBrainEnabled).not.toHaveBeenCalled();
  });

  it('persists the explicit choice and echoes it back', async () => {
    await expect(
      setMemoryEnabledCommand(auth(true), { enabled: true }),
    ).resolves.toEqual({ enabled: true });
    expect(mockSetBrainEnabled).toHaveBeenLastCalledWith(true);

    await expect(
      setMemoryEnabledCommand(auth(true), { enabled: false }),
    ).resolves.toEqual({ enabled: false });
    expect(mockSetBrainEnabled).toHaveBeenLastCalledWith(false);
  });
});
