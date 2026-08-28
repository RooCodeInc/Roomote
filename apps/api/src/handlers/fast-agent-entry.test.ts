const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: { query: { users: { findFirst: mocks.findUser } } },
  eq: vi.fn(),
  users: { id: 'users.id' },
}));

import { hasCommunicationsFastModeDefault } from './fast-agent-entry';

describe('hasCommunicationsFastModeDefault', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the stored preference', async () => {
    mocks.findUser.mockResolvedValue({
      metadata: { communications_fast_mode_default: true },
    });

    await expect(hasCommunicationsFastModeDefault('user-1')).resolves.toBe(
      true,
    );
  });

  it('defaults to enabled when no preference is stored', async () => {
    mocks.findUser.mockResolvedValue({ metadata: {} });

    await expect(hasCommunicationsFastModeDefault('user-1')).resolves.toBe(
      true,
    );
  });

  it('honors an explicit opt-out', async () => {
    mocks.findUser.mockResolvedValue({
      metadata: { communications_fast_mode_default: false },
    });

    await expect(hasCommunicationsFastModeDefault('user-1')).resolves.toBe(
      false,
    );
  });
});
