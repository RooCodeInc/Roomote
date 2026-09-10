const { findFirst, insert, values, onConflictDoUpdate } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  insert: vi.fn(),
  values: vi.fn(),
  onConflictDoUpdate: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: { deploymentSettings: { findFirst } },
    insert,
  },
  deploymentSettings: { id: 'deployment_settings.id' },
  eq: vi.fn(),
}));

vi.mock('../setup/shared', () => ({
  assertAdmin: (auth: { isAdmin: boolean }) => {
    if (!auth.isAdmin) throw new Error('Unauthorized');
  },
}));

import type { UserAuthSuccess } from '@/types';

import {
  getExperimentalSettingsCommand,
  setOpenCodeCodeModeCommand,
} from './index';

const adminAuth = { userId: 'admin', isAdmin: true } as UserAuthSuccess;
const memberAuth = { userId: 'member', isAdmin: false } as UserAuthSuccess;

describe('experimental settings commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insert.mockReturnValue({ values });
    values.mockReturnValue({ onConflictDoUpdate });
    onConflictDoUpdate.mockResolvedValue(undefined);
  });

  it('defaults Code Mode off and reads a persisted opt-in', async () => {
    findFirst.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      metadata: { opencode_code_mode: true },
    });

    await expect(getExperimentalSettingsCommand(adminAuth)).resolves.toEqual({
      openCodeCodeModeEnabled: false,
    });
    await expect(getExperimentalSettingsCommand(adminAuth)).resolves.toEqual({
      openCodeCodeModeEnabled: true,
    });
  });

  it('persists the validated boolean without dropping other metadata', async () => {
    findFirst.mockResolvedValue({ metadata: { keep_me: 'value' } });

    await expect(
      setOpenCodeCodeModeCommand(adminAuth, { enabled: true }),
    ).resolves.toEqual({ openCodeCodeModeEnabled: true });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'default',
        metadata: { keep_me: 'value', opencode_code_mode: true },
      }),
    );
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'deployment_settings.id',
        set: expect.objectContaining({
          metadata: { keep_me: 'value', opencode_code_mode: true },
        }),
      }),
    );
  });

  it('rejects non-admin reads and writes', async () => {
    await expect(getExperimentalSettingsCommand(memberAuth)).rejects.toThrow(
      'Unauthorized',
    );
    await expect(
      setOpenCodeCodeModeCommand(memberAuth, { enabled: true }),
    ).rejects.toThrow('Unauthorized');
    expect(findFirst).not.toHaveBeenCalled();
  });
});
