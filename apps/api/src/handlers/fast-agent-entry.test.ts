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
  startAcceptedFastAgentTurn,
} from './fast-agent-entry';

describe('startAcceptedFastAgentTurn', () => {
  it('rejects lock contention before acceptance', async () => {
    await expect(
      startAcceptedFastAgentTurn({
        run: async ({ onRejected }) => onRejected(),
        onError: vi.fn(),
      }),
    ).resolves.toEqual({ accepted: false, reason: 'Fast session is busy.' });
  });

  it('rejects startup failures before acceptance', async () => {
    const onError = vi.fn();
    const error = new Error('startup failed');
    await expect(
      startAcceptedFastAgentTurn({
        run: async () => {
          throw error;
        },
        onError,
      }),
    ).resolves.toEqual({ accepted: false, reason: 'startup failed' });
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('rejects a processor that exits without an acceptance decision', async () => {
    await expect(
      startAcceptedFastAgentTurn({
        run: async () => undefined,
        onError: vi.fn(),
      }),
    ).resolves.toEqual({
      accepted: false,
      reason: 'Fast session did not accept the request.',
    });
  });

  it('keeps an accepted result when completion later fails', async () => {
    const onError = vi.fn();
    const error = new Error('completion failed');
    await expect(
      startAcceptedFastAgentTurn({
        run: async ({ onAccepted }) => {
          onAccepted();
          throw error;
        },
        onError,
      }),
    ).resolves.toEqual({ accepted: true });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));
  });
});

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
