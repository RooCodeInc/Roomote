import { useRef } from 'react';
import { act, render } from '@testing-library/react';

const { fitMock } = vi.hoisted(() => ({
  fitMock: vi.fn(),
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    buffer = { active: { length: 0 } };

    loadAddon() {}
    open() {}
    write() {}
    dispose() {}
    clear() {}
    focus() {}
    onData() {
      return { dispose: vi.fn() };
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = fitMock;
  },
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {},
}));

import { useTerminal } from '../use-terminal';

class WebSocketMock {
  static OPEN = 1;
  readyState = WebSocketMock.OPEN;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  close() {}
  send() {}
}

describe('useTerminal', () => {
  let resizeCallback: ResizeObserverCallback;
  let nextFrameId: number;
  let frameCallbacks: Map<number, FrameRequestCallback>;

  beforeEach(() => {
    fitMock.mockClear();
    nextFrameId = 1;
    frameCallbacks = new Map();

    vi.stubGlobal('WebSocket', WebSocketMock);
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const id = nextFrameId++;
        frameCallbacks.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => frameCallbacks.delete(id)),
    );
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }

        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function flushAnimationFrames() {
    const callbacks = [...frameCallbacks.values()];
    frameCallbacks.clear();
    callbacks.forEach((callback) => callback(performance.now()));
  }

  function TerminalHarness() {
    const containerRef = useRef<HTMLDivElement>(null);

    useTerminal(containerRef, () => 'ws://sandbox.test/ws/terminal');

    return (
      <div
        ref={(node) => {
          containerRef.current = node;
          if (node) {
            Object.defineProperties(node, {
              offsetWidth: { configurable: true, value: 800 },
              offsetHeight: { configurable: true, value: 600 },
            });
          }
        }}
      />
    );
  }

  it('defers and coalesces terminal fits triggered by ResizeObserver', () => {
    render(<TerminalHarness />);

    act(() => flushAnimationFrames());
    expect(fitMock).toHaveBeenCalledTimes(1);

    act(() => {
      resizeCallback([], {} as ResizeObserver);
      resizeCallback([], {} as ResizeObserver);
    });

    expect(fitMock).toHaveBeenCalledTimes(1);
    expect(frameCallbacks).toHaveLength(1);

    act(() => flushAnimationFrames());
    expect(fitMock).toHaveBeenCalledTimes(2);
  });
});
