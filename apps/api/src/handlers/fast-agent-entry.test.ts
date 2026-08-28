import {
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
