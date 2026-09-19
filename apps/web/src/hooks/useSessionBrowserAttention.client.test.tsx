import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

vi.mock('./useBrowserNotificationsExperiment', () => ({
  useBrowserNotificationsExperiment: () => ({ enabled: true }),
}));

import { useSessionBrowserAttention } from './useSessionBrowserAttention';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  private listeners = new Map<string, (event: MessageEvent) => void>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, listener: EventListener) {
    this.listeners.set(name, listener as (event: MessageEvent) => void);
  }
  removeEventListener() {}
  close() {}
  emit(data: object) {
    this.listeners.get('attention')?.(
      new MessageEvent('attention', { data: JSON.stringify(data) }),
    );
  }
}

const requestPermission = vi.fn();
const notificationConstructor = vi.fn();

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = requestPermission;
  onclick: (() => void) | null = null;
  close = vi.fn();

  constructor(title: string, options?: NotificationOptions) {
    notificationConstructor(title, options);
  }
}

function TestComponent() {
  const { prompt } = useSessionBrowserAttention(
    '00000000-0000-4000-8000-000000000001',
  );
  return prompt;
}

describe('useSessionBrowserAttention', () => {
  beforeEach(() => {
    localStorage.clear();
    FakeEventSource.instances = [];
    FakeNotification.permission = 'default';
    requestPermission.mockReset().mockResolvedValue('granted');
    notificationConstructor.mockReset();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('Notification', FakeNotification);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  });

  it('never asks on mount and requests permission only from the contextual action', async () => {
    render(<TestComponent />);
    expect(requestPermission).not.toHaveBeenCalled();

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => {
      FakeEventSource.instances.at(-1)!.emit({
        notificationId: '00000000-0000-4000-8000-000000000002',
        eventKey: 'fast:result_ready:first',
        mode: 'prompt',
        title: 'Roomote',
        body: 'The response is ready.',
        href: '/sessions/00000000-0000-4000-8000-000000000001',
        offerExpiresAt: null,
      });
    });

    const button = await screen.findByRole('button', {
      name: 'Enable notifications',
    });
    expect(requestPermission).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(requestPermission).toHaveBeenCalledOnce());
  });

  it('creates and acknowledges a granted background notification', async () => {
    FakeNotification.permission = 'granted';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    vi.mocked(document.hasFocus).mockReturnValue(false);
    render(<TestComponent />);

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => {
      FakeEventSource.instances.at(-1)!.emit({
        notificationId: '00000000-0000-4000-8000-000000000002',
        eventKey: 'fast:result_ready:first',
        mode: 'notify',
        title: 'Roomote',
        body: 'The actual response content.',
        href: '/sessions/00000000-0000-4000-8000-000000000001',
        offerExpiresAt: new Date(Date.now() + 10_000).toISOString(),
      });
    });

    await waitFor(() =>
      expect(notificationConstructor).toHaveBeenCalledWith('Roomote', {
        body: 'The actual response content.',
        tag: 'fast:result_ready:first',
      }),
    );
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/00000000-0000-4000-8000-000000000001/attention',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"action":"accepted"'),
      }),
    );
  });
});
