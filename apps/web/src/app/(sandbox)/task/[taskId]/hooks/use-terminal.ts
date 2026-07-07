import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

/**
 * Factory that returns a WebSocket URL given the current terminal dimensions.
 * Returning `null` signals that the connection is not ready yet.
 */
export type GetWebSocketUrl = (cols: number, rows: number) => string | null;

interface UseTerminalOptions {
  /** Background color for the terminal (default: 'transparent') */
  backgroundColor?: string;
  /** Command string to send as input once the WebSocket opens. */
  initialInput?: string;
  /** Called when the shell process exits. */
  onSessionExit?: (exitCode: number) => void;
  /** Called for every WebSocket message received from the server. */
  onMessage?: (message: {
    type: string;
    data?: string;
    exitCode?: number;
    message?: string;
  }) => void;
}

/**
 * Manages an xterm.js terminal connected to a remote server via WebSocket.
 *
 * The terminal and WebSocket are created once when `getWebSocketUrl` returns a
 * non-null value and persist across tab switches and panel toggles. When the
 * connection drops, the hook exposes `disconnected` and a `reconnect`
 * callback so the UI can show a manual reconnect button.
 */
export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  getWebSocketUrl: GetWebSocketUrl,
  options: UseTerminalOptions = {},
) {
  const {
    backgroundColor = '#000000',
    initialInput,
    onSessionExit,
    onMessage,
  } = options;
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(true);

  const connectRef = useRef<(() => void) | null>(null);
  const getWebSocketUrlRef = useRef(getWebSocketUrl);
  getWebSocketUrlRef.current = getWebSocketUrl;

  const initialInputRef = useRef(initialInput);
  initialInputRef.current = initialInput;
  const onSessionExitRef = useRef(onSessionExit);
  onSessionExitRef.current = onSessionExit;
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const [disconnected, setDisconnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [exited, setExited] = useState(false);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Create terminal and WebSocket once when getWebSocketUrl returns a URL.
  useEffect(() => {
    const container = containerRef.current;

    // Probe with dummy dimensions to check if the URL is available yet.
    if (!container || !getWebSocketUrl(80, 24)) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: { background: backgroundColor },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    let opened = false;
    let intentionalClose = false;
    let initialInputSent = false;

    // Helper to fit the terminal and notify the server of the new size.
    function fitAndResize() {
      // FitAddon needs a visible, non-zero-size container.
      if (
        container === null ||
        container.offsetWidth === 0 ||
        container.offsetHeight === 0
      ) {
        return;
      }

      fitAddon.fit();

      const ws = wsRef.current;

      if (ws && ws.readyState === WebSocket.OPEN) {
        const { cols, rows } = terminal;
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    }

    function connect() {
      setDisconnected(false);
      setConnecting(true);
      setExited(false);
      fitAndResize();

      const url = getWebSocketUrlRef.current(terminal.cols, terminal.rows);

      if (!url) {
        setConnecting(false);
        setDisconnected(true);
        return;
      }

      const ws = new WebSocket(url);

      wsRef.current = ws;

      ws.onopen = () => {
        setConnecting(false);

        if (!initialInputSent && initialInputRef.current) {
          ws.send(
            JSON.stringify({ type: 'input', data: initialInputRef.current }),
          );

          initialInputSent = true;
        }
      };

      ws.onmessage = (event) => {
        let msg: {
          type: string;
          data?: string;
          exitCode?: number;
          message?: string;
        };

        try {
          msg = JSON.parse(event.data);

          if (msg.type === 'output' && msg.data) {
            terminal.write(msg.data);
          } else if (msg.type === 'exit') {
            terminal.write(
              `\r\n[Process exited with code ${msg.exitCode}]\r\n`,
            );
            setExited(true);
            onSessionExitRef.current?.(
              typeof msg.exitCode === 'number' ? msg.exitCode : 0,
            );
          } else if (msg.type === 'error') {
            terminal.write(`\r\n[Error: ${msg.message}]\r\n`);
          }
        } catch {
          // Malformed message, ignore.
          return;
        }

        onMessageRef.current?.(msg);
      };

      ws.onclose = () => {
        setConnecting(false);

        if (!intentionalClose && mountedRef.current) {
          terminal.write('\r\n[Disconnected]\r\n');
          setDisconnected(true);
        }
      };

      ws.onerror = () => {
        // `onclose` will fire after this.
      };
    }

    connectRef.current = connect;

    // Defer terminal.open() and connect() until the container is visible.
    // xterm.js cannot initialise its renderer in a zero-size container.
    function openIfReady() {
      if (
        opened ||
        !container ||
        container.offsetWidth === 0 ||
        container.offsetHeight === 0
      ) {
        return;
      }

      opened = true;
      terminal.open(container);
      fitAddon.fit();
      connect();
    }

    // Defer into a rAF so React strict-mode's mount-cleanup-remount cycle
    // doesn't create a WebSocket that is closed before it's established.
    const initialOpenFrame = requestAnimationFrame(() => openIfReady());

    // Terminal input → WebSocket.
    const inputDisposable = terminal.onData((data) => {
      const ws = wsRef.current;

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Resize handling — also triggers deferred open when container becomes visible.
    const resizeObserver = new ResizeObserver(() => {
      openIfReady();
      fitAndResize();
    });
    resizeObserver.observe(container);

    // Cleanup.
    return () => {
      intentionalClose = true;
      connectRef.current = null;
      cancelAnimationFrame(initialOpenFrame);

      resizeObserver.disconnect();
      inputDisposable.dispose();

      wsRef.current?.close();
      wsRef.current = null;

      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
    // getWebSocketUrl is stored in a ref; the effect re-runs only when
    // the factory starts/stops returning a URL (tested via the probe above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backgroundColor, containerRef, !!getWebSocketUrl(80, 24)]);

  const reconnect = useCallback(() => connectRef.current?.(), []);

  const getScrollback = useCallback(() => {
    const terminal = terminalRef.current;

    if (!terminal) {
      return '';
    }

    const buffer = terminal.buffer.active;
    const lines: string[] = [];

    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);

      if (line) {
        lines.push(line.translateToString(true));
      }
    }

    return lines.join('\n');
  }, []);

  const clearScrollback = useCallback(() => terminalRef.current?.clear(), []);

  const focus = useCallback(() => {
    const focusWhenReady = (attempt = 0) => {
      const terminal = terminalRef.current;

      if (!terminal) {
        return;
      }

      // Focus is accepted only after `open()` has attached the DOM element.
      if (!terminal.element) {
        if (attempt < 10) {
          requestAnimationFrame(() => focusWhenReady(attempt + 1));
        }

        return;
      }

      terminal.focus();
    };

    focusWhenReady();
  }, []);

  return {
    disconnected,
    connecting,
    exited,
    reconnect,
    getScrollback,
    clearScrollback,
    focus,
  };
}
