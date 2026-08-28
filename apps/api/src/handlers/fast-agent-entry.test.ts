const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: { query: { users: { findFirst: mocks.findUser } } },
  eq: vi.fn(),
  users: { id: 'users.id' },
}));

import {
  hasCommunicationsFastModeDefault,
  resolveFastAgentEntryMode,
} from './fast-agent-entry';

describe('resolveFastAgentEntryMode', () => {
  it('uses Fast for an available configured default', () => {
    expect(
      resolveFastAgentEntryMode({
        explicitInvocation: false,
        userDefaultEnabled: true,
        fastAvailable: true,
      }),
    ).toBe('default');
  });

  it('keeps coding behavior when Fast is unavailable', () => {
    expect(
      resolveFastAgentEntryMode({
        explicitInvocation: false,
        userDefaultEnabled: true,
        fastAvailable: false,
      }),
    ).toBeNull();
  });
});

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

  it('returns false when the stored preference is not enabled', async () => {
    mocks.findUser.mockResolvedValue({ metadata: {} });

    await expect(hasCommunicationsFastModeDefault('user-1')).resolves.toBe(
      false,
    );
  });
});
