import { startSandboxLiveAutoRecovery } from '../services/sandbox-live-auto-recovery';

function setDocumentVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

describe('startSandboxLiveAutoRecovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setDocumentVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconnects when the browser comes back online', () => {
    const triggerReconnect = vi.fn();
    const cleanup = startSandboxLiveAutoRecovery({
      isEligible: () => true,
      triggerReconnect,
    });

    window.dispatchEvent(new Event('online'));

    expect(triggerReconnect).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('reconnects when the tab becomes visible again', () => {
    const triggerReconnect = vi.fn();
    const cleanup = startSandboxLiveAutoRecovery({
      isEligible: () => true,
      triggerReconnect,
    });

    document.dispatchEvent(new Event('visibilitychange'));

    expect(triggerReconnect).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('does not reconnect when the tab is hidden', () => {
    setDocumentVisibility('hidden');

    const triggerReconnect = vi.fn();
    const cleanup = startSandboxLiveAutoRecovery({
      isEligible: () => true,
      triggerReconnect,
    });

    document.dispatchEvent(new Event('visibilitychange'));

    expect(triggerReconnect).not.toHaveBeenCalled();
    cleanup();
  });

  it('does not reconnect while ineligible', () => {
    const triggerReconnect = vi.fn();
    const cleanup = startSandboxLiveAutoRecovery({
      isEligible: () => false,
      triggerReconnect,
    });

    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(120_000);

    expect(triggerReconnect).not.toHaveBeenCalled();
    cleanup();
  });

  it('throttles rapid triggers into a single attempt', () => {
    const triggerReconnect = vi.fn();
    const cleanup = startSandboxLiveAutoRecovery({
      isEligible: () => true,
      triggerReconnect,
    });

    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));

    expect(triggerReconnect).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_000);
    window.dispatchEvent(new Event('online'));

    expect(triggerReconnect).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('retries on the slow background interval while still disconnected', () => {
    const triggerReconnect = vi.fn();
    const cleanup = startSandboxLiveAutoRecovery({
      isEligible: () => true,
      triggerReconnect,
    });

    vi.advanceTimersByTime(60_000);
    expect(triggerReconnect).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    expect(triggerReconnect).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('stops listening after cleanup', () => {
    const triggerReconnect = vi.fn();
    const cleanup = startSandboxLiveAutoRecovery({
      isEligible: () => true,
      triggerReconnect,
    });

    cleanup();

    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(120_000);

    expect(triggerReconnect).not.toHaveBeenCalled();
  });
});
