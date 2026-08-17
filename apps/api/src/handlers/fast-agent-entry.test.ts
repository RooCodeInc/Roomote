const mocks = vi.hoisted(() => ({
  env: { R_COMMUNICATIONS_FAST_MODE_SETTING_ENABLED: false },
  findUser: vi.fn(),
}));

vi.mock('@roomote/env', () => ({ Env: mocks.env }));
vi.mock('@roomote/db/server', () => ({
  db: { query: { users: { findFirst: mocks.findUser } } },
  eq: vi.fn(),
  users: { id: 'users.id' },
}));

import { hasCommunicationsFastModeDefault } from './fast-agent-entry';

describe('hasCommunicationsFastModeDefault', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.R_COMMUNICATIONS_FAST_MODE_SETTING_ENABLED = false;
  });

  it('does not read the user preference when the deployment setting is disabled', async () => {
    await expect(hasCommunicationsFastModeDefault('user-1')).resolves.toBe(
      false,
    );
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it('returns the stored preference when the deployment setting is enabled', async () => {
    mocks.env.R_COMMUNICATIONS_FAST_MODE_SETTING_ENABLED = true;
    mocks.findUser.mockResolvedValue({
      metadata: { communications_fast_mode_default: true },
    });

    await expect(hasCommunicationsFastModeDefault('user-1')).resolves.toBe(
      true,
    );
  });
});
