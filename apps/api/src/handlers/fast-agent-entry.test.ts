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

import {
  hasCommunicationsFastModeDefault,
  shouldShowFastAgentProcessingReaction,
} from './fast-agent-entry';

describe('shouldShowFastAgentProcessingReaction', () => {
  it('shows the reaction when default mode creates a session', () => {
    expect(
      shouldShowFastAgentProcessingReaction({
        entryMode: 'default',
        hasExistingSession: false,
      }),
    ).toBe(true);
  });

  it('skips the reaction for an active default session', () => {
    expect(
      shouldShowFastAgentProcessingReaction({
        entryMode: 'default',
        hasExistingSession: true,
      }),
    ).toBe(false);
  });

  it('shows the wake reaction for explicit entry to an existing session', () => {
    expect(
      shouldShowFastAgentProcessingReaction({
        entryMode: 'explicit',
        hasExistingSession: true,
      }),
    ).toBe(true);
  });
});

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
