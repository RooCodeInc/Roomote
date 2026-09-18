import type React from 'react';

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
  remoteKeyCode,
  trackLiveEdge,
} from './DesktopStreamClient';

vi.mock('./SidePanelHeader', () => ({
  SidePanelHeader: ({
    title,
    actions,
  }: {
    title: string;
    actions?: React.ReactNode;
  }) => (
    <div>
      <div>{title}</div>
      {actions}
    </div>
  ),
}));

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

/** Control is implicit in the UI, so tests read it off the desktop itself. */
function controlIsOn() {
  return waitFor(() =>
    expect(screen.getByLabelText('Remote desktop')).toHaveAttribute(
      'data-control-state',
      'on',
    ),
  );
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
      'getVideoPlaybackQuality',
      {
        configurable: true,
        value: () => ({ totalVideoFrames: 0, droppedVideoFrames: 0 }),
      },
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
        onClose={() => {}}
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
    await controlIsOn();

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
        onClose={() => {}}
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
          onClose={() => {}}
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

  it('pops the desktop out into its own window and hands over control', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    render(
      <DesktopStreamClient
        previewUrl="https://desktop.preview.test"
        runId={123}
        onClose={() => {}}
        popoutHref="/task/abc/shared-desktop/popout"
      />,
    );
    const start = await screen.findByRole('button', {
      name: 'Start remote desktop',
    });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    await controlIsOn();

    fireEvent.click(
      screen.getByRole('button', { name: 'Pop out Shared Desktop' }),
    );
    expect(open).toHaveBeenCalledWith(
      '/task/abc/shared-desktop/popout',
      'roomote-shared-desktop-123',
      expect.stringContaining('popup=yes'),
    );
    // The panel gives up control so the new window can take it cleanly.
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    await screen.findByRole('button', { name: 'Take control' });
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
        onClose={() => {}}
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
        onClose={() => {}}
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
        onClose={() => {}}
      />,
    );
    const start = await screen.findByRole('button', {
      name: 'Start remote desktop',
    });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    await controlIsOn();

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
    await screen.findByText('Another viewer has control');

    fireEvent.pointerDown(video, {
      button: 0,
      clientX: 100,
      clientY: 100,
      pointerId: 1,
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => FakeWebSocket.instances[1]!.open());
    await controlIsOn();
  });

  it('offers Take control only when another viewer holds the desktop', async () => {
    render(
      <DesktopStreamClient
        previewUrl="https://desktop.preview.test"
        runId={123}
        onClose={() => {}}
      />,
    );
    const start = await screen.findByRole('button', {
      name: 'Start remote desktop',
    });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    await controlIsOn();
    expect(screen.queryByRole('button', { name: 'Take control' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Release control' }),
    ).toBeNull();

    act(() => {
      first.emit('message', {
        data: '{"error":"another viewer took control of the desktop"}',
      } as MessageEvent);
      first.close();
    });
    await screen.findByRole('button', { name: 'Take control' });
    // A superseded viewer does not fight the other one on its own.
    expect(FakeWebSocket.instances).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => FakeWebSocket.instances[1]!.open());
    await controlIsOn();
    expect(screen.queryByRole('button', { name: 'Take control' })).toBeNull();
  });

  it('shows when the viewer is driving and hands back to the agent', async () => {
    render(
      <DesktopStreamClient
        previewUrl="https://desktop.preview.test"
        runId={123}
        onClose={() => {}}
      />,
    );
    const start = await screen.findByRole('button', {
      name: 'Start remote desktop',
    });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    await controlIsOn();
    fireEvent.loadedData(screen.getByLabelText('Remote desktop'));
    expect(screen.queryByText(/You're driving/)).toBeNull();

    act(() =>
      socket.emit('message', { data: '{"driving":true}' } as MessageEvent),
    );
    await screen.findByText(/You're driving/);

    fireEvent.click(screen.getByRole('button', { name: 'Hand back' }));
    expect(socket.sent.map((payload) => JSON.parse(payload).type)).toContain(
      'hand_back',
    );
    expect(screen.queryByText(/You're driving/)).toBeNull();

    // The service also ends it on its own once the viewer goes idle.
    act(() =>
      socket.emit('message', { data: '{"driving":true}' } as MessageEvent),
    );
    await screen.findByText(/You're driving/);
    act(() =>
      socket.emit('message', { data: '{"driving":false}' } as MessageEvent),
    );
    await waitFor(() =>
      expect(screen.queryByText(/You're driving/)).toBeNull(),
    );
  });

  it('pastes the local clipboard into the sandbox and copies back out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', {
      ...navigator,
      platform: 'MacIntel',
      clipboard: { writeText },
    });
    try {
      render(
        <DesktopStreamClient
          previewUrl="https://desktop.preview.test"
          runId={123}
          onClose={() => {}}
        />,
      );
      const start = await screen.findByRole('button', {
        name: 'Start remote desktop',
      });
      await waitFor(() => expect(start).toBeEnabled());
      fireEvent.click(start);
      const socket = FakeWebSocket.instances[0]!;
      act(() => socket.open());
      await controlIsOn();
      const video = screen.getByLabelText('Remote desktop');
      const sent = () => socket.sent.map((payload) => JSON.parse(payload));
      socket.sent = [];

      // Command is sent as Control; the V itself is left to the paste event.
      fireEvent.keyDown(video, { code: 'MetaLeft', metaKey: true });
      fireEvent.keyDown(video, { code: 'KeyV', metaKey: true });
      fireEvent.paste(video, {
        clipboardData: { getData: () => 'hello from my laptop' },
      });
      expect(sent()).toEqual([
        expect.objectContaining({
          type: 'key',
          code: 'ControlLeft',
          down: true,
        }),
        expect.objectContaining({
          type: 'paste',
          text: 'hello from my laptop',
        }),
      ]);

      socket.sent = [];
      fireEvent.keyDown(video, { code: 'KeyC', metaKey: true });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(sent().map((event) => event.type)).toEqual([
        'key',
        'clipboard_read',
      ]);
      act(() =>
        socket.emit('message', {
          data: '{"clipboard":"copied in the sandbox"}',
        } as MessageEvent),
      );
      expect(writeText).toHaveBeenCalledWith('copied in the sandbox');
    } finally {
      vi.useRealTimers();
    }
  });

  it('only remaps Command on a Mac', () => {
    expect(remoteKeyCode('MetaLeft', true)).toBe('ControlLeft');
    expect(remoteKeyCode('MetaRight', true)).toBe('ControlRight');
    expect(remoteKeyCode('KeyA', true)).toBe('KeyA');
    expect(remoteKeyCode('MetaLeft', false)).toBe('MetaLeft');
  });

  it('reconnects control and reloads the stream after an unexpected drop', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(
        <DesktopStreamClient
          previewUrl="https://desktop.preview.test"
          runId={123}
          onClose={() => {}}
        />,
      );
      const start = await screen.findByRole('button', {
        name: 'Start remote desktop',
      });
      await waitFor(() => expect(start).toBeEnabled());
      fireEvent.click(start);
      const first = FakeWebSocket.instances[0]!;
      act(() => first.open());
      await controlIsOn();
      const video = screen.getByLabelText('Remote desktop');
      fireEvent.loadedData(video);

      // Service restart: control closes without a supersession message.
      act(() => first.close());
      await screen.findByRole('button', { name: 'Take control' });
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(FakeWebSocket.instances).toHaveLength(2);

      // The stream errors too: it reloads instead of failing.
      Object.defineProperty(video, 'error', {
        configurable: true,
        value: { code: 2 },
      });
      fireEvent.error(video);
      expect(
        screen.queryByRole('button', { name: 'Start remote desktop' }),
      ).toBeNull();
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(video.getAttribute('src')).toContain('restart=');
    } finally {
      vi.useRealTimers();
    }
  });

  it('hides the stream statistics behind a header toggle', async () => {
    render(
      <DesktopStreamClient
        previewUrl="https://desktop.preview.test"
        runId={123}
        onClose={() => {}}
      />,
    );
    await screen.findByRole('button', { name: 'Start remote desktop' });
    expect(screen.queryByTestId('stream-stats')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'Show stream statistics' }),
    );
    expect(screen.getByTestId('stream-stats')).toHaveTextContent('kbps');
    expect(window.localStorage.getItem('roomote.shared-desktop.stats')).toBe(
      '1',
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Hide stream statistics' }),
    );
    expect(screen.queryByTestId('stream-stats')).toBeNull();
  });

  it('shows its own toolbar in the standalone pop-out window', async () => {
    render(
      <DesktopStreamClient
        previewUrl="https://desktop.preview.test"
        runId={123}
        standalone
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Show stream statistics' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Pop out Shared Desktop' }),
    ).toBeNull();
    // The pop-out starts on its own so it can take over control from the
    // panel that opened it without another click.
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.instances[0]!.open());
    await controlIsOn();
  });
});
