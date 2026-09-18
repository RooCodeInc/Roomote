'use client';

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';

import {
  Activity,
  Button,
  ExternalLink,
  Loader2,
  SquareDashedMousePointer,
  Play,
} from '@/components/system';

import { SidePanelHeader } from './SidePanelHeader';

interface DesktopStreamSession {
  controlUrl: string;
  streamUrl: string;
}

/** How long to wait for the first decoded frame before giving up. */
export const STREAM_START_TIMEOUT_MS = 30_000;

/**
 * Live-edge tracking. The stream is a progressive fragmented MP4, so the
 * browser happily buffers ahead and never catches up on its own: every stall
 * adds permanent latency. Keep playback close to the newest buffered data.
 */
const LIVE_EDGE_CHECK_INTERVAL_MS = 500;
/** Lag above which the player jumps straight to the live edge. */
const LIVE_EDGE_SEEK_THRESHOLD_S = 0.6;
/** Lag above which the player speeds up slightly to drift back to the edge. */
const LIVE_EDGE_CATCH_UP_THRESHOLD_S = 0.3;
/** How far behind the newest buffered data a seek lands, to avoid stalling. */
export const LIVE_EDGE_TARGET_S = 0.15;
const LIVE_EDGE_CATCH_UP_RATE = 1.1;

/**
 * Nudge a playing video toward its buffered live edge. Returns the current
 * lag in seconds, or null when nothing is buffered yet.
 */
export function trackLiveEdge(
  video: Pick<
    HTMLVideoElement,
    'buffered' | 'currentTime' | 'paused' | 'playbackRate'
  >,
): number | null {
  const { buffered } = video;
  if (video.paused || buffered.length === 0) {
    return null;
  }
  const liveEdge = buffered.end(buffered.length - 1);
  const lag = liveEdge - video.currentTime;
  if (lag > LIVE_EDGE_SEEK_THRESHOLD_S) {
    video.currentTime = Math.max(0, liveEdge - LIVE_EDGE_TARGET_S);
    video.playbackRate = 1;
  } else if (lag > LIVE_EDGE_CATCH_UP_THRESHOLD_S) {
    video.playbackRate = LIVE_EDGE_CATCH_UP_RATE;
  } else if (video.playbackRate !== 1) {
    video.playbackRate = 1;
  }
  return lag;
}

// MediaError code constants, inlined because the global is not defined in
// every runtime (jsdom, server rendering).
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

function describeMediaError(
  error: Pick<MediaError, 'code'> | null | undefined,
): string {
  switch (error?.code) {
    case MEDIA_ERR_NETWORK:
      return 'Remote desktop stream could not be reached';
    case MEDIA_ERR_DECODE:
      return 'Remote desktop stream could not be decoded';
    case MEDIA_ERR_SRC_NOT_SUPPORTED:
      return 'Remote desktop stream is unavailable or already being watched by the maximum number of viewers';
    default:
      return 'Remote desktop playback failed';
  }
}

type ControlEvent =
  | { type: 'pointer_move'; x: number; y: number }
  | { type: 'pointer_button'; button: number; down: boolean }
  | { type: 'wheel'; delta_x: number; delta_y: number }
  | { type: 'key'; code: string; down: boolean }
  | { type: 'release_all' }
  | { type: 'resize'; width: number; height: number }
  | { type: 'hand_back' }
  | { type: 'paste'; text: string }
  | { type: 'clipboard_read' };

/** Matches the service's clipboard limit. */
const MAX_CLIPBOARD_BYTES = 128 * 1024;
/** Time for the sandbox application to own the clipboard after a copy. */
const CLIPBOARD_READ_DELAY_MS = 150;

/**
 * The sandbox desktop is Linux, where Control drives the shortcuts that
 * Command drives on a Mac. Sending Command as Control makes copy, cut, paste,
 * select all, undo, and the rest work the way the viewer's hands expect.
 */
export function remoteKeyCode(code: string, isMac: boolean): string {
  if (!isMac) {
    return code;
  }
  if (code === 'MetaLeft') {
    return 'ControlLeft';
  }
  if (code === 'MetaRight') {
    return 'ControlRight';
  }
  return code;
}

/**
 * A sandbox restored from an older environment snapshot runs an older desktop
 * service, which rejects events added since as unknown variants. Those events
 * are optional, so that is a missing feature to mention once, not an error.
 */
const NEWER_EVENT_REJECTED =
  /unknown variant `(paste|clipboard_read|hand_back)`/;

function isMacPlatform(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad/.test(navigator.platform)
  );
}

/** Upper bound on remote pixels so encode cost stays near 1080p. */
const MAX_REMOTE_PIXELS = 1920 * 1080;
const MIN_REMOTE_WIDTH = 320;
const MIN_REMOTE_HEIGHT = 200;
/** Ignore panel size changes smaller than this, in remote pixels. */
const RESIZE_MIN_DELTA_PX = 8;
const RESIZE_DEBOUNCE_MS = 300;

interface RemoteSize {
  width: number;
  height: number;
}

/**
 * Remote screen size that fills the panel: the panel's CSS box, reduced
 * proportionally when that exceeds the pixel budget, and rounded to even
 * dimensions for the encoder. CSS pixels are used deliberately: the sandbox
 * renders at 1x, so matching device pixels on a high-DPI display would make
 * every remote control half its intended size.
 */
export function computeRemoteSize(panel: {
  width: number;
  height: number;
}): RemoteSize | null {
  let { width, height } = panel;
  if (width < MIN_REMOTE_WIDTH || height < MIN_REMOTE_HEIGHT) {
    return null;
  }
  const pixels = width * height;
  if (pixels > MAX_REMOTE_PIXELS) {
    const scale = Math.sqrt(MAX_REMOTE_PIXELS / pixels);
    width *= scale;
    height *= scale;
  }
  return {
    width: Math.max(MIN_REMOTE_WIDTH, Math.floor(width / 2) * 2),
    height: Math.max(MIN_REMOTE_HEIGHT, Math.floor(height / 2) * 2),
  };
}

interface RemotePoint {
  x: number;
  y: number;
}

export function mapPointerToRemote(params: {
  clientX: number;
  clientY: number;
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;
  videoWidth: number;
  videoHeight: number;
}): RemotePoint | null {
  const { clientX, clientY, rect, videoWidth, videoHeight } = params;
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    videoWidth <= 0 ||
    videoHeight <= 0
  ) {
    return null;
  }

  const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight);
  const renderedWidth = videoWidth * scale;
  const renderedHeight = videoHeight * scale;
  const left = rect.left + (rect.width - renderedWidth) / 2;
  const top = rect.top + (rect.height - renderedHeight) / 2;
  if (
    clientX < left ||
    clientX > left + renderedWidth ||
    clientY < top ||
    clientY > top + renderedHeight
  ) {
    return null;
  }

  return {
    x: (clientX - left) / renderedWidth,
    y: (clientY - top) / renderedHeight,
  };
}

/** Why the control channel is not connected, shown in the footer. */
type ControlState = 'off' | 'connecting' | 'on' | 'released' | 'taken';

const RECONNECT_DELAY_MS = 1_500;
const MAX_AUTO_RECOVERIES = 20;
/** Per-browser preference for the diagnostics readout in the footer. */
const STATS_STORAGE_KEY = 'roomote.shared-desktop.stats';

function readStatsPreference(): boolean {
  try {
    return window.localStorage.getItem(STATS_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeStatsPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(STATS_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // Preference storage is a convenience only.
  }
}

export function DesktopStreamClient({
  previewUrl,
  runId,
  onClose,
  popoutHref,
  standalone = false,
}: {
  previewUrl: string;
  runId: number;
  onClose?: () => void;
  /** Standalone page for this desktop; shown as a pop-out in the header. */
  popoutHref?: string;
  /**
   * Render a minimal toolbar of its own and start the desktop as soon as
   * the session is ready (used by the pop-out window, which must take over
   * control from the panel that opened it without another click).
   */
  standalone?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const pendingPointerRef = useRef<RemotePoint | null>(null);
  const pointerFrameRef = useRef<number | null>(null);
  const videoFrameRef = useRef<number | null>(null);
  const startTimeoutRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const renderedFramesRef = useRef(0);
  const sampleFramesRef = useRef(0);
  const sampleTimeRef = useRef(performance.now());
  const decodedBytesRef = useRef(0);
  const [session, setSession] = useState<DesktopStreamSession | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [controlReady, setControlReady] = useState(false);
  const [controlState, setControlState] = useState<ControlState>('off');
  /**
   * The sandbox service's view of whether this viewer is driving: they
   * clicked, scrolled, or typed recently, so the agent's page actions wait.
   */
  const [driving, setDriving] = useState(false);
  const [showStats, setShowStats] = useState(false);
  useEffect(() => {
    setShowStats(readStatsPreference());
  }, []);
  /** True after the viewer explicitly released control: no auto-reconnect. */
  const releasedRef = useRef(false);
  const controlReconnectTimerRef = useRef<number | null>(null);
  const streamRetryTimerRef = useRef<number | null>(null);
  const recoveryAttemptsRef = useRef(0);
  const streamRetriesRef = useRef(0);
  const unmountedRef = useRef(false);
  /** The sandbox's desktop service predates clipboard transfer. */
  const clipboardUnsupportedRef = useRef(false);
  /** Mirrors controlState === 'on' for handlers that run outside render. */
  const controlOnRef = useRef(false);
  /** Pending visibility-change retry, removed on unmount. */
  const visibilityRetryRef = useRef<(() => void) | null>(null);
  const [renderedFps, setRenderedFps] = useState<number | null>(null);
  const [startupMs, setStartupMs] = useState<number | null>(null);
  const [decodedBitrateKbps, setDecodedBitrateKbps] = useState<number | null>(
    null,
  );
  const [droppedFrames, setDroppedFrames] = useState(0);
  const [liveLagMs, setLiveLagMs] = useState<number | null>(null);
  const [remoteSize, setRemoteSize] = useState<RemoteSize | null>(null);
  const [sentEvents, setSentEvents] = useState(0);
  // Counted in a ref and published on the stats interval: a state update per
  // pointer move would schedule a render at display refresh rate.
  const sentEventsRef = useRef(0);
  const sentRemoteSizeRef = useRef<RemoteSize | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  /** Set while the server restarts the encoder after a resize. */
  const restartPendingRef = useRef(false);
  /** Set between Start and the first stream load. */
  const pendingInitialPlayRef = useRef(false);
  const sessionRef = useRef<DesktopStreamSession | null>(null);
  sessionRef.current = session;

  const sendControl = (event: ControlEvent) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ ...event, sent_at_ms: Date.now() }));
      sentEventsRef.current += 1;
    }
  };

  const releaseAll = () => {
    pendingPointerRef.current = null;
    sendControl({ type: 'release_all' });
  };

  useEffect(() => {
    if (!isPlaying) {
      return;
    }
    const interval = window.setInterval(() => {
      const video = videoRef.current;
      if (!video) {
        return;
      }
      const lag = trackLiveEdge(video);
      setLiveLagMs(lag === null ? null : lag * 1000);
    }, LIVE_EDGE_CHECK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [isPlaying]);

  const clearStartTimeout = () => {
    if (startTimeoutRef.current !== null) {
      window.clearTimeout(startTimeoutRef.current);
      startTimeoutRef.current = null;
    }
  };

  /** Tear down a stream that failed before or after playback began. */
  const clearControlReconnectTimer = () => {
    if (controlReconnectTimerRef.current !== null) {
      window.clearTimeout(controlReconnectTimerRef.current);
      controlReconnectTimerRef.current = null;
    }
  };

  const clearStreamRetryTimer = () => {
    if (streamRetryTimerRef.current !== null) {
      window.clearTimeout(streamRetryTimerRef.current);
      streamRetryTimerRef.current = null;
    }
  };

  const clearVisibilityRetry = () => {
    if (visibilityRetryRef.current) {
      document.removeEventListener(
        'visibilitychange',
        visibilityRetryRef.current,
      );
      visibilityRetryRef.current = null;
    }
  };

  const failStream = (message: string) => {
    clearStartTimeout();
    clearStreamRetryTimer();
    clearVisibilityRetry();
    pendingInitialPlayRef.current = false;
    restartPendingRef.current = false;
    releaseAll();
    socketRef.current?.close();
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    if (videoFrameRef.current !== null) {
      videoRef.current?.cancelVideoFrameCallback(videoFrameRef.current);
      videoFrameRef.current = null;
    }
    setSessionError(message);
    setIsStarting(false);
    setIsPlaying(false);
  };

  useEffect(() => {
    const abortController = new AbortController();
    const url = `/api/auth/desktop-stream?${new URLSearchParams({
      preview_url: previewUrl,
      task_run_id: String(runId),
    }).toString()}`;
    setSession(null);
    setSessionError(null);

    void fetch(url, { signal: abortController.signal })
      .then(async (response) => {
        const body = (await response.json()) as DesktopStreamSession & {
          error?: string;
        };
        if (!response.ok) {
          throw new Error(body.error ?? 'Failed to authorize remote desktop');
        }
        setSession(body);
      })
      .catch((error: unknown) => {
        if (!abortController.signal.aborted) {
          setSessionError(
            error instanceof Error
              ? error.message
              : 'Failed to load remote desktop',
          );
        }
      });

    return () => abortController.abort();
  }, [previewUrl, runId]);

  useEffect(() => {
    const release = () => {
      pendingPointerRef.current = null;
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({ type: 'release_all', sent_at_ms: Date.now() }),
        );
      }
    };
    const handleBlur = () => release();
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        release();
      }
    };
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  useEffect(() => {
    if (!isPlaying) {
      return;
    }
    const interval = window.setInterval(() => {
      const now = performance.now();
      const elapsed = now - sampleTimeRef.current;
      if (elapsed > 0) {
        setRenderedFps(
          ((renderedFramesRef.current - sampleFramesRef.current) * 1000) /
            elapsed,
        );
        const decodedBytes =
          (
            videoRef.current as HTMLVideoElement & {
              webkitVideoDecodedByteCount?: number;
            }
          )?.webkitVideoDecodedByteCount ?? 0;
        if (decodedBytes >= decodedBytesRef.current) {
          setDecodedBitrateKbps(
            ((decodedBytes - decodedBytesRef.current) * 8) / elapsed,
          );
        }
        decodedBytesRef.current = decodedBytes;
        setSentEvents(sentEventsRef.current);
        setDroppedFrames(
          videoRef.current?.getVideoPlaybackQuality().droppedVideoFrames ?? 0,
        );
      }
      sampleFramesRef.current = renderedFramesRef.current;
      sampleTimeRef.current = now;
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [isPlaying]);

  useEffect(() => {
    const video = videoRef.current;
    return () => {
      unmountedRef.current = true;
      if (controlReconnectTimerRef.current !== null) {
        window.clearTimeout(controlReconnectTimerRef.current);
      }
      if (streamRetryTimerRef.current !== null) {
        window.clearTimeout(streamRetryTimerRef.current);
      }
      if (visibilityRetryRef.current) {
        document.removeEventListener(
          'visibilitychange',
          visibilityRetryRef.current,
        );
      }
      pendingPointerRef.current = null;
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({ type: 'release_all', sent_at_ms: Date.now() }),
        );
      }
      socketRef.current?.close(1000, 'remote desktop closed');
      if (startTimeoutRef.current !== null) {
        window.clearTimeout(startTimeoutRef.current);
      }
      video?.pause();
      video?.removeAttribute('src');
      video?.load();
      if (pointerFrameRef.current !== null) {
        cancelAnimationFrame(pointerFrameRef.current);
      }
      if (videoFrameRef.current !== null) {
        video?.cancelVideoFrameCallback(videoFrameRef.current);
      }
    };
  }, []);

  /**
   * Ask the sandbox to resize its screen to the panel's current size.
   * Returns whether a request was sent. Resizing travels over the control
   * socket, so only the viewer who holds control can change the screen;
   * everyone else sees the desktop at the controller's size.
   */
  const sendPanelSize = (): boolean => {
    const container = videoRef.current?.parentElement;
    const socket = socketRef.current;
    if (
      !container ||
      !controlOnRef.current ||
      socket?.readyState !== WebSocket.OPEN
    ) {
      return false;
    }
    const rect = container.getBoundingClientRect();
    const size = computeRemoteSize(rect);
    if (!size) {
      return false;
    }
    const last = sentRemoteSizeRef.current;
    if (
      last &&
      Math.abs(last.width - size.width) < RESIZE_MIN_DELTA_PX &&
      Math.abs(last.height - size.height) < RESIZE_MIN_DELTA_PX
    ) {
      return false;
    }
    sentRemoteSizeRef.current = size;
    // The server ends the current encoder as part of the resize; that must
    // not be mistaken for a playback failure.
    restartPendingRef.current = true;
    sendControl({ type: 'resize', ...size });
    return true;
  };

  /** Load (or reload) the stream at the sandbox's current screen size. */
  const loadStream = () => {
    const video = videoRef.current;
    const streamUrl = sessionRef.current?.streamUrl;
    if (!video || !streamUrl) {
      return;
    }
    pendingInitialPlayRef.current = false;
    // Replacing the source aborts the previous load without an error event,
    // so anything that fails from here on is a real playback problem.
    restartPendingRef.current = false;
    const url = new URL(streamUrl, window.location.href);
    url.searchParams.set('restart', String(Date.now()));
    video.src = url.toString();
    const play = () =>
      video.play().catch((error: unknown) => {
        // Browsers pause video-only media in background tabs and reject
        // play() with an AbortError. Keep the source and retry once the
        // tab is visible again instead of tearing the stream down.
        if (error instanceof DOMException && error.name === 'AbortError') {
          // Do not let the startup timeout fail a deliberately deferred
          // stream; re-arm it once playback is attempted again.
          clearStartTimeout();
          clearVisibilityRetry();
          const retry = () => {
            if (document.visibilityState === 'visible') {
              clearVisibilityRetry();
              startTimeoutRef.current = window.setTimeout(() => {
                startTimeoutRef.current = null;
                failStream(
                  'Remote desktop did not start in time. The sandbox desktop service may not be running.',
                );
              }, STREAM_START_TIMEOUT_MS);
              void play();
            }
          };
          visibilityRetryRef.current = retry;
          document.addEventListener('visibilitychange', retry);
          return;
        }
        failStream(
          error instanceof Error
            ? error.message
            : 'Remote desktop playback failed',
        );
      });
    void play();
  };

  useEffect(() => {
    const container = videoRef.current?.parentElement;
    if (!container || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
      }
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = null;
        sendPanelSize();
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
      }
    };
    // sendPanelSize reads refs only, so it does not need to be a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connectControl = (controlUrl: string) => {
    socketRef.current?.close();
    const socket = new WebSocket(controlUrl);
    socketRef.current = socket;
    sentRemoteSizeRef.current = null;
    releasedRef.current = false;
    setControlState('connecting');
    let supersededByOther = false;
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          error?: string;
          ready?: boolean;
          resized?: RemoteSize;
          driving?: boolean;
          clipboard?: string;
        };
        if (typeof message.driving === 'boolean') {
          setDriving(message.driving);
        }
        if (typeof message.clipboard === 'string' && message.clipboard) {
          navigator.clipboard?.writeText(message.clipboard).catch(() => {
            setSessionError(
              'Copied in the sandbox, but this browser blocked clipboard access',
            );
          });
        }
        if (message.ready) {
          setControlReady(true);
          setControlState('on');
          controlOnRef.current = true;
          recoveryAttemptsRef.current = 0;
          videoRef.current?.focus();
          // Match the panel before the first stream starts so the encoder
          // does not start at the default size only to restart at once.
          if (!sendPanelSize() && pendingInitialPlayRef.current) {
            loadStream();
          }
        }
        if (message.resized) {
          setRemoteSize(message.resized);
          const video = videoRef.current;
          const sizeChanged =
            !video ||
            video.videoWidth !== message.resized.width ||
            video.videoHeight !== message.resized.height;
          if (pendingInitialPlayRef.current) {
            loadStream();
          } else if (restartPendingRef.current) {
            // The server only restarts the encoder when the size actually
            // changed; otherwise the current stream is still valid.
            if (sizeChanged) {
              loadStream();
            } else {
              restartPendingRef.current = false;
            }
          }
        }
        if (message.error && NEWER_EVENT_REJECTED.test(message.error)) {
          const clipboardEvent = !message.error.includes('`hand_back`');
          if (clipboardEvent && !clipboardUnsupportedRef.current) {
            clipboardUnsupportedRef.current = true;
            setSessionError(
              'Copy and paste need a newer sandbox image. Refresh this environment\u2019s snapshot to enable them.',
            );
          }
          return;
        }
        if (message.error) {
          restartPendingRef.current = false;
          if (/another viewer took control/i.test(message.error)) {
            // Do not fight the other viewer; the header button or a click
            // on the desktop takes control back deliberately.
            supersededByOther = true;
            setControlState('taken');
          } else {
            setSessionError(message.error);
          }
          if (pendingInitialPlayRef.current) {
            loadStream();
          }
        }
      } catch {
        setSessionError('Remote desktop control returned an invalid response');
      }
    });
    socket.addEventListener('close', () => {
      setControlReady(false);
      setDriving(false);
      controlOnRef.current = false;
      const wasCurrent = socketRef.current === socket;
      if (wasCurrent) {
        socketRef.current = null;
      }
      // Video still works without control, so never hold the stream back.
      if (pendingInitialPlayRef.current) {
        loadStream();
      }
      if (!wasCurrent || unmountedRef.current) {
        return;
      }
      if (supersededByOther) {
        setControlState('taken');
      } else if (releasedRef.current) {
        setControlState('released');
      } else {
        // Lost involuntarily (service restart, proxy hiccup): come back on
        // our own while the desktop is open.
        setControlState('off');
        if (recoveryAttemptsRef.current < MAX_AUTO_RECOVERIES) {
          recoveryAttemptsRef.current += 1;
          clearControlReconnectTimer();
          controlReconnectTimerRef.current = window.setTimeout(() => {
            controlReconnectTimerRef.current = null;
            const url = sessionRef.current?.controlUrl;
            if (url && !releasedRef.current && !unmountedRef.current) {
              connectControl(url);
            }
          }, RECONNECT_DELAY_MS);
        }
      }
    });
    socket.addEventListener('error', () => {
      // The close handler decides whether to reconnect or report.
    });
  };

  /** Let the agent act again at once instead of after the idle window. */
  const handBack = () => {
    sendControl({ type: 'hand_back' });
    setDriving(false);
    videoRef.current?.focus();
  };

  /**
   * Give up input control on purpose; the stream keeps playing. Used to hand
   * the desktop to the pop-out window.
   */
  const releaseControl = () => {
    releasedRef.current = true;
    clearControlReconnectTimer();
    releaseAll();
    setControlState('released');
    socketRef.current?.close(1000, 'control released');
  };

  /** Claim (or reclaim) input control. */
  const takeControl = () => {
    const url = sessionRef.current?.controlUrl;
    if (!url) {
      return;
    }
    setSessionError(null);
    recoveryAttemptsRef.current = 0;
    connectControl(url);
  };

  /**
   * The stream dropped while it was playing (service restart, encoder
   * evicted, proxy hiccup). Reload it a few times before giving up, so a
   * hiccup never strands the viewer on a Start button.
   */
  const recoverStream = (message: string, refused = false) => {
    // A refused stream (the desktop is already at its viewer limit) is not
    // a hiccup worth hammering; give it one more try, then stop.
    const limit = refused ? 1 : MAX_AUTO_RECOVERIES;
    if (
      !isPlaying ||
      unmountedRef.current ||
      streamRetriesRef.current >= limit
    ) {
      failStream(message);
      return;
    }
    streamRetriesRef.current += 1;
    setSessionError(`${message}; reconnecting`);
    clearStreamRetryTimer();
    streamRetryTimerRef.current = window.setTimeout(() => {
      streamRetryTimerRef.current = null;
      if (unmountedRef.current) {
        return;
      }
      setSessionError(null);
      loadStream();
    }, RECONNECT_DELAY_MS);
  };

  const start = () => {
    const video = videoRef.current;
    if (!video || !session) {
      return;
    }
    setIsStarting(true);
    setSessionError(null);
    startedAtRef.current = performance.now();
    renderedFramesRef.current = 0;
    sampleFramesRef.current = 0;
    sampleTimeRef.current = performance.now();
    decodedBytesRef.current = 0;
    clearStartTimeout();
    startTimeoutRef.current = window.setTimeout(() => {
      startTimeoutRef.current = null;
      failStream(
        'Remote desktop did not start in time. The sandbox desktop service may not be running.',
      );
    }, STREAM_START_TIMEOUT_MS);
    // The control channel negotiates the screen size first; the stream loads
    // once the sandbox confirms it (or immediately if control is unavailable).
    pendingInitialPlayRef.current = true;
    connectControl(session.controlUrl);
  };

  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!standalone || !session || autoStartedRef.current) {
      return;
    }
    autoStartedRef.current = true;
    start();
    // `start` is recreated every render; the ref guards against re-running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [standalone, session]);

  const pointForEvent = (
    event:
      | ReactPointerEvent<HTMLVideoElement>
      | ReactWheelEvent<HTMLVideoElement>,
  ) => {
    const video = videoRef.current;
    if (!video) {
      return null;
    }
    return mapPointerToRemote({
      clientX: event.clientX,
      clientY: event.clientY,
      rect: video.getBoundingClientRect(),
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
    });
  };

  const sendPointerPosition = (point: RemotePoint) => {
    pendingPointerRef.current = point;
    if (pointerFrameRef.current !== null) {
      return;
    }
    pointerFrameRef.current = requestAnimationFrame(() => {
      pointerFrameRef.current = null;
      const pending = pendingPointerRef.current;
      if (pending) {
        sendControl({ type: 'pointer_move', ...pending });
      }
    });
  };

  const handlePointerButton = (
    event: ReactPointerEvent<HTMLVideoElement>,
    down: boolean,
  ) => {
    const point = pointForEvent(event);
    if (!point) {
      return;
    }
    if (!controlReady) {
      // Another viewer took control: clicking the desktop takes it back.
      // After an explicit release, only the header button reconnects.
      if (
        down &&
        isPlaying &&
        !releasedRef.current &&
        sessionRef.current &&
        socketRef.current?.readyState !== WebSocket.OPEN &&
        socketRef.current?.readyState !== WebSocket.CONNECTING
      ) {
        takeControl();
      }
      return;
    }
    event.preventDefault();
    sendPointerPosition(point);
    sendControl({ type: 'pointer_button', button: event.button, down });
    if (down) {
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
    } else if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const frameCallback = () => {
    renderedFramesRef.current += 1;
    videoFrameRef.current =
      videoRef.current?.requestVideoFrameCallback(frameCallback) ?? null;
  };

  // Control is implicit while this viewer has it: clicking or typing takes
  // over from the agent and stopping hands back. The button only appears when
  // there is something to take, from another viewer or after a handoff.
  const canTakeControl =
    controlState === 'taken' ||
    controlState === 'released' ||
    (controlState === 'off' && isPlaying);

  const headerActions = (
    <>
      {canTakeControl ? (
        <Button
          variant="outline"
          size="sm"
          disabled={!session}
          onClick={takeControl}
        >
          Take control
        </Button>
      ) : null}
      {popoutHref ? (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Pop out Shared Desktop"
          title="Pop out"
          onClick={() => {
            const container = videoRef.current?.parentElement;
            const width = Math.max(
              640,
              Math.round(container?.clientWidth ?? 1280),
            );
            const height = Math.max(
              400,
              Math.round(container?.clientHeight ?? 800),
            );
            // Hand control to the new window rather than fighting it.
            if (controlOnRef.current) {
              releaseControl();
            }
            window.open(
              popoutHref,
              `roomote-shared-desktop-${runId}`,
              `popup=yes,width=${width},height=${height}`,
            );
          }}
        >
          <ExternalLink />
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="icon"
        aria-label={
          showStats ? 'Hide stream statistics' : 'Show stream statistics'
        }
        aria-pressed={showStats}
        title={showStats ? 'Hide stream statistics' : 'Show stream statistics'}
        className={showStats ? 'text-primary' : undefined}
        onClick={() => {
          const next = !showStats;
          setShowStats(next);
          writeStatsPreference(next);
        }}
      >
        <Activity />
      </Button>
    </>
  );

  return (
    <div className="relative flex size-full flex-col overflow-hidden bg-zinc-950">
      {onClose ? (
        <SidePanelHeader
          title="Shared Desktop"
          onClose={onClose}
          actions={headerActions}
        />
      ) : standalone ? (
        <div className="flex items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-1.5">
          <span className="text-sm font-medium text-zinc-100">
            Shared Desktop
          </span>
          <div className="flex items-center gap-1">{headerActions}</div>
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        <video
          ref={videoRef}
          aria-label="Remote desktop"
          data-control-state={controlState}
          // No audio track is streamed; muted also keeps autoplay allowed in
          // the pop-out window.
          muted
          // The sandbox cursor is not painted into the video; the local cursor
          // is the pointer, so it never trails behind the stream.
          className="size-full cursor-default object-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
          playsInline
          tabIndex={0}
          onBlur={releaseAll}
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if (!controlReady) return;
            const shortcut = event.metaKey || event.ctrlKey;
            if (
              shortcut &&
              event.code === 'KeyV' &&
              !clipboardUnsupportedRef.current
            ) {
              // Let the browser fire `paste`, which carries the clipboard
              // text without a permission prompt; onPaste sends it on.
              return;
            }
            event.preventDefault();
            sendControl({
              type: 'key',
              code: remoteKeyCode(event.code, isMacPlatform()),
              down: true,
            });
            if (
              shortcut &&
              !event.repeat &&
              !clipboardUnsupportedRef.current &&
              (event.code === 'KeyC' || event.code === 'KeyX')
            ) {
              window.setTimeout(
                () => sendControl({ type: 'clipboard_read' }),
                CLIPBOARD_READ_DELAY_MS,
              );
            }
          }}
          onKeyUp={(event) => {
            if (!controlReady) return;
            event.preventDefault();
            sendControl({
              type: 'key',
              code: remoteKeyCode(event.code, isMacPlatform()),
              down: false,
            });
          }}
          onPaste={(event) => {
            if (!controlReady || clipboardUnsupportedRef.current) return;
            const text = event.clipboardData.getData('text/plain');
            if (!text) return;
            event.preventDefault();
            if (new Blob([text]).size > MAX_CLIPBOARD_BYTES) {
              setSessionError(
                'That is too much text to paste into the sandbox',
              );
              return;
            }
            sendControl({ type: 'paste', text });
          }}
          onError={() => {
            if (restartPendingRef.current) {
              // The previous encoder was stopped for a resize; the new
              // stream is already loading.
              return;
            }
            const mediaError = videoRef.current?.error;
            recoverStream(
              describeMediaError(mediaError),
              mediaError?.code === MEDIA_ERR_SRC_NOT_SUPPORTED,
            );
          }}
          onEnded={() => {
            recoverStream('Remote desktop stream ended');
          }}
          onLoadedMetadata={() => {
            const video = videoRef.current;
            if (video && video.videoWidth > 0 && video.videoHeight > 0) {
              setRemoteSize({
                width: video.videoWidth,
                height: video.videoHeight,
              });
            }
          }}
          onLoadedData={() => {
            restartPendingRef.current = false;
            streamRetriesRef.current = 0;
            clearStartTimeout();
            setStartupMs(performance.now() - startedAtRef.current);
            setIsStarting(false);
            setIsPlaying(true);
            if (videoRef.current) {
              trackLiveEdge(videoRef.current);
            }
            videoFrameRef.current =
              videoRef.current?.requestVideoFrameCallback(frameCallback) ??
              null;
          }}
          onPointerDown={(event) => handlePointerButton(event, true)}
          onPointerMove={(event) => {
            const point = pointForEvent(event);
            if (point && controlReady) sendPointerPosition(point);
          }}
          onPointerUp={(event) => handlePointerButton(event, false)}
          onWheel={(event) => {
            const point = pointForEvent(event);
            if (!point || !controlReady) return;
            event.preventDefault();
            sendPointerPosition(point);
            sendControl({
              type: 'wheel',
              delta_x: event.deltaX,
              delta_y: event.deltaY,
            });
          }}
        />

        {isPlaying && controlState === 'on' && driving ? (
          <div className="absolute top-2 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded bg-zinc-950/80 py-1 pr-1 pl-2 text-xs text-zinc-200">
            <span>You&apos;re driving. The agent waits until you stop.</span>
            <Button
              variant="secondary"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={handBack}
            >
              Hand back
            </Button>
          </div>
        ) : null}
        {isPlaying && controlState !== 'on' && controlState !== 'off' ? (
          <div className="pointer-events-none absolute top-2 left-2 rounded bg-zinc-950/80 px-2 py-1 text-xs text-zinc-200">
            {controlState === 'connecting'
              ? 'Connecting control'
              : controlState === 'released'
                ? 'Control handed to another window'
                : 'Another viewer has control'}
          </div>
        ) : null}
        {isPlaying && sessionError ? (
          <div
            role="alert"
            className="pointer-events-none absolute top-2 right-2 left-2 mx-auto w-fit max-w-[90%] truncate rounded bg-zinc-950/80 px-2 py-1 text-xs text-destructive"
          >
            {sessionError}
          </div>
        ) : null}
        {showStats ? (
          <div
            data-testid="stream-stats"
            className="pointer-events-none absolute right-2 bottom-2 rounded bg-zinc-950/80 px-2 py-1 font-mono text-xs text-zinc-300 tabular-nums"
          >
            {renderedFps === null ? '-' : `${renderedFps.toFixed(1)} fps`}
            {' · '}
            {decodedBitrateKbps === null
              ? '- kbps'
              : `${decodedBitrateKbps.toFixed(0)} kbps`}
            {' · '}
            {droppedFrames} dropped
            {' · '}
            {liveLagMs === null
              ? '-'
              : `${liveLagMs.toFixed(0)} ms behind live`}
            {remoteSize ? ` · ${remoteSize.width}×${remoteSize.height}` : ''}
            {' · '}
            {startupMs === null
              ? '-'
              : `${startupMs.toFixed(0)} ms first frame`}
            {' · '}
            {sentEvents} events
          </div>
        ) : null}
        {!isPlaying ? (
          <div className="absolute inset-0 grid place-items-center bg-zinc-950/85 p-6 text-center">
            <div className="max-w-sm space-y-4">
              <div className="mx-auto flex size-12 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900">
                <SquareDashedMousePointer className="size-5 text-zinc-200" />
              </div>
              <div className="space-y-1">
                <p className="font-semibold text-zinc-100">
                  Interactive remote desktop
                </p>
                <p className="text-sm text-zinc-400">
                  Click the desktop to send mouse and keyboard input.
                </p>
              </div>
              <Button onClick={start} disabled={!session || isStarting}>
                {isStarting ? <Loader2 className="animate-spin" /> : <Play />}
                {isStarting ? 'Starting...' : 'Start remote desktop'}
              </Button>
              {sessionError ? (
                <p role="alert" className="text-sm text-destructive">
                  {sessionError}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
