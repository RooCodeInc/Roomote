import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import {
  DesktopStreamClient,
  STREAM_START_TIMEOUT_MS,
  mapPointerToRemote,
} from './DesktopStreamClient';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', {} as MessageEvent);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('message', { data: '{"ready":true}' } as MessageEvent);
  }

  emit(type: string, event: MessageEvent) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe('DesktopStreamClient', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('PointerEvent', MouseEvent);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'load', {
      configurable: true,
      value: vi.fn(),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            controlUrl: 'wss://desktop.preview.test/control?token=preview',
            streamUrl: 'https://desktop.preview.test/stream.mp4?token=preview',
          }),
        ok: true,
      }),
    );
    Object.defineProperty(
      HTMLVideoElement.prototype,
      'requestVideoFrameCallback',
      {
        configurable: true,
        value: vi.fn(() => 1),
      },
    );
    Object.defineProperty(
      HTMLVideoElement.prototype,
      'cancelVideoFrameCallback',
      {
        configurable: true,
        value: vi.fn(),
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('maps pointer coordinates around object-contain letterboxing', () => {
    expect(
      mapPointerToRemote({
        clientX: 500,
        clientY: 300,
        rect: { left: 0, top: 0, width: 1000, height: 600 },
        videoWidth: 1600,
        videoHeight: 900,
      }),
    ).toEqual({ x: 0.5, y: 0.5 });
    expect(
      mapPointerToRemote({
        clientX: 500,
        clientY: 10,
        rect: { left: 0, top: 0, width: 1000, height: 600 },
        videoWidth: 1600,
        videoHeight: 900,
      }),
    ).toBeNull();
  });

  it('sends pointer and keyboard input and releases held input on blur', async () => {
    const view = render(
      <DesktopStreamClient
        previewUrl="https://desktop.preview.test"
        runId={123}
      />,
    );
    const start = await screen.findByRole('button', {
      name: 'Start remote desktop',
    });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);

    const socket = FakeWebSocket.instances[0];
    expect(socket?.url).toContain('/control');
    act(() => socket?.open());
    await screen.findByText('Control connected');

    const video = screen.getByLabelText('Remote desktop');
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 1280 },
      videoHeight: { configurable: true, value: 720 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
      },
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    fireEvent.loadedData(video);
    fireEvent.pointerMove(video, { clientX: 640, clientY: 360 });
    fireEvent.pointerDown(video, {
      button: 0,
      clientX: 640,
      clientY: 360,
      pointerId: 1,
    });
    fireEvent.keyDown(video, { code: 'KeyA' });
    fireEvent.keyUp(video, { code: 'KeyA' });
    fireEvent.blur(video);

    expect(socket?.sent.map((payload) => JSON.parse(payload))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'pointer_move', x: 0.5, y: 0.5 }),
        expect.objectContaining({
          type: 'pointer_button',
          button: 0,
          down: true,
        }),
        expect.objectContaining({ type: 'key', code: 'KeyA', down: true }),
        expect.objectContaining({ type: 'key', code: 'KeyA', down: false }),
        expect.objectContaining({ type: 'release_all' }),
      ]),
    );
    view.unmount();
    expect(socket?.readyState).toBe(FakeWebSocket.CLOSED);
    expect(video).not.toHaveAttribute('src');
  });

  it('recovers from a media error so the stream can be restarted', async () => {
    render(
      <DesktopStreamClient
        previewUrl="https://desktop.preview.test"
        runId={123}
      />,
    );
    const start = await screen.findByRole('button', {
      name: 'Start remote desktop',
    });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    expect(screen.getByRole('button', { name: 'Starting...' })).toBeDisabled();

    const video = screen.getByLabelText('Remote desktop');
    Object.defineProperty(video, 'error', {
      configurable: true,
      value: { code: 4 },
    });
    fireEvent.error(video);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Remote desktop stream is unavailable',
    );
    expect(
      screen.getByRole('button', { name: 'Start remote desktop' }),
    ).toBeEnabled();
    expect(FakeWebSocket.instances[0]?.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it('gives up when no frame arrives before the start timeout', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(
        <DesktopStreamClient
          previewUrl="https://desktop.preview.test"
          runId={123}
        />,
      );
      const start = await screen.findByRole('button', {
        name: 'Start remote desktop',
      });
      await waitFor(() => expect(start).toBeEnabled());
      fireEvent.click(start);

      act(() => {
        vi.advanceTimersByTime(STREAM_START_TIMEOUT_MS + 1);
      });

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'did not start in time',
      );
      expect(
        screen.getByRole('button', { name: 'Start remote desktop' }),
      ).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });
});
