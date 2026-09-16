import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import {
  DesktopStreamClient,
  LIVE_EDGE_TARGET_S,
  STREAM_START_TIMEOUT_MS,
  computeRemoteSize,
  mapPointerToRemote,
  trackLiveEdge,
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

  it('keeps playback at the live edge of the progressive stream', () => {
    const ranges = (end: number) =>
      ({ length: 1, start: () => 0, end: () => end }) as unknown as TimeRanges;

    const farBehind = {
      buffered: ranges(10),
      currentTime: 6,
      paused: false,
      playbackRate: 1,
    };
    expect(trackLiveEdge(farBehind)).toBeCloseTo(4);
    expect(farBehind.currentTime).toBeCloseTo(10 - LIVE_EDGE_TARGET_S);
    expect(farBehind.playbackRate).toBe(1);

    const slightlyBehind = {
      buffered: ranges(10),
      currentTime: 9.6,
      paused: false,
      playbackRate: 1,
    };
    expect(trackLiveEdge(slightlyBehind)).toBeCloseTo(0.4);
    expect(slightlyBehind.currentTime).toBe(9.6);
    expect(slightlyBehind.playbackRate).toBeGreaterThan(1);

    const caughtUp = {
      buffered: ranges(10),
      currentTime: 9.9,
      paused: false,
      playbackRate: 1.1,
    };
    expect(trackLiveEdge(caughtUp)).toBeCloseTo(0.1);
    expect(caughtUp.playbackRate).toBe(1);

    expect(
      trackLiveEdge({
        buffered: ranges(10),
        currentTime: 0,
        paused: true,
        playbackRate: 1,
      }),
    ).toBeNull();
  });

  it('offers a fullscreen toggle for the desktop frame', async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    });
    render(
      <DesktopStreamClient
        previewUrl="https://desktop.preview.test"
        runId={123}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
    await waitFor(() => expect(requestFullscreen).toHaveBeenCalledTimes(1));
  });

  it('sizes the remote screen to the panel within the pixel budget', () => {
    expect(computeRemoteSize({ width: 641, height: 481 })).toEqual({
      width: 640,
      height: 480,
    });
    const capped = computeRemoteSize({ width: 3200, height: 2000 });
    expect(capped).not.toBeNull();
    expect(capped!.width * capped!.height).toBeLessThanOrEqual(1920 * 1080);
    expect(capped!.width / capped!.height).toBeCloseTo(1.6, 1);
    expect(computeRemoteSize({ width: 100, height: 100 })).toBeNull();
  });

  it('asks the sandbox to match the panel size and reconnects after the resize', async () => {
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
    const video = screen.getByLabelText('Remote desktop');
    Object.defineProperty(video.parentElement!, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    });
    fireEvent.click(start);

    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    const resize = socket.sent
      .map((payload) => JSON.parse(payload))
      .find((event) => event.type === 'resize');
    expect(resize).toMatchObject({ type: 'resize', width: 800, height: 600 });

    // The stream waits for the sandbox to confirm the size, and an encoder
    // stopping for the resize is not reported as a failure.
    expect(video).not.toHaveAttribute('src');
    Object.defineProperty(video, 'error', {
      configurable: true,
      value: { code: 2 },
    });
    fireEvent.error(video);
    expect(screen.queryByRole('alert')).toBeNull();

    act(() =>
      socket.emit('message', {
        data: '{"resized":{"width":800,"height":600}}',
      } as MessageEvent),
    );
    expect(video.getAttribute('src')).toContain('restart=');
    expect(video.getAttribute('src')).toContain('stream.mp4');
  });

  it('starts the stream without control when the control channel is rejected', async () => {
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
    const video = screen.getByLabelText('Remote desktop');
    expect(video).not.toHaveAttribute('src');

    act(() => FakeWebSocket.instances[0]!.close());
    expect(video.getAttribute('src')).toContain('stream.mp4');
  });

  it('reclaims control with a click after another viewer took it over', async () => {
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
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
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
      hasPointerCapture: { configurable: true, value: vi.fn(() => false) },
    });
    fireEvent.loadedData(video);

    act(() =>
      first.emit('message', {
        data: '{"error":"another viewer took control of the desktop"}',
      } as MessageEvent),
    );
    act(() => first.close());
    await screen.findByText('Control disconnected');

    fireEvent.pointerDown(video, {
      button: 0,
      clientX: 100,
      clientY: 100,
      pointerId: 1,
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => FakeWebSocket.instances[1]!.open());
    await screen.findByText('Control connected');
  });
});
