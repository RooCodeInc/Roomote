'use client';

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';

import {
  Button,
  Loader2,
  Maximize2,
  SquareDashedMousePointer,
  Play,
} from '@/components/system';

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
      return 'Remote desktop stream is unavailable';
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
  | { type: 'resize'; width: number; height: number };

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

export function DesktopStreamClient({
  previewUrl,
  runId,
}: {
  previewUrl: string;
  runId: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
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
  const [renderedFps, setRenderedFps] = useState<number | null>(null);
  const [startupMs, setStartupMs] = useState<number | null>(null);
  const [decodedBitrateKbps, setDecodedBitrateKbps] = useState<number | null>(
    null,
  );
  const [droppedFrames, setDroppedFrames] = useState(0);
  const [liveLagMs, setLiveLagMs] = useState<number | null>(null);
  const [remoteSize, setRemoteSize] = useState<RemoteSize | null>(null);
  const [sentEvents, setSentEvents] = useState(0);
  const sentRemoteSizeRef = useRef<RemoteSize | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  /** Set while the server restarts the encoder after a resize. */
  const restartPendingRef = useRef(false);
  /** Set between Start and the first stream load. */
  const pendingInitialPlayRef = useRef(false);
  const sessionRef = useRef<DesktopStreamSession | null>(null);
  sessionRef.current = session;
  const [isFullscreen, setIsFullscreen] = useState(false);

  const sendControl = (event: ControlEvent) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ ...event, sent_at_ms: Date.now() }));
      setSentEvents((count) => count + 1);
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

  useEffect(() => {
    const handleFullscreenChange = () => {
      const active = document.fullscreenElement === containerRef.current;
      setIsFullscreen(active);
      if (active) {
        videoRef.current?.focus();
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () =>
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void containerRef.current?.requestFullscreen?.();
    }
  };

  const clearStartTimeout = () => {
    if (startTimeoutRef.current !== null) {
      window.clearTimeout(startTimeoutRef.current);
      startTimeoutRef.current = null;
    }
  };

  /** Tear down a stream that failed before or after playback began. */
  const failStream = (message: string) => {
    clearStartTimeout();
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
   * Returns whether a request was sent.
   */
  const sendPanelSize = (): boolean => {
    const container = videoRef.current?.parentElement;
    const socket = socketRef.current;
    if (!container || socket?.readyState !== WebSocket.OPEN) {
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
          const retry = () => {
            if (document.visibilityState === 'visible') {
              document.removeEventListener('visibilitychange', retry);
              void play();
            }
          };
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
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          error?: string;
          ready?: boolean;
          resized?: RemoteSize;
        };
        if (message.ready) {
          setControlReady(true);
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
        if (message.error) {
          restartPendingRef.current = false;
          setSessionError(message.error);
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
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      // Video still works without control, so never hold the stream back.
      if (pendingInitialPlayRef.current) {
        loadStream();
      }
    });
    socket.addEventListener('error', () => {
      setSessionError('Remote desktop control could not connect');
    });
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
      // Control was never established or was taken over by another viewer.
      // Clicking the desktop reclaims it.
      if (
        down &&
        isPlaying &&
        sessionRef.current &&
        socketRef.current?.readyState !== WebSocket.OPEN &&
        socketRef.current?.readyState !== WebSocket.CONNECTING
      ) {
        setSessionError(null);
        connectControl(sessionRef.current.controlUrl);
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

  return (
    <div
      ref={containerRef}
      className="relative flex size-full flex-col overflow-hidden bg-zinc-950"
    >
      <div className="relative min-h-0 flex-1">
        <video
          ref={videoRef}
          aria-label="Remote desktop"
          // The sandbox cursor is not painted into the video; the local cursor
          // is the pointer, so it never trails behind the stream.
          className="size-full cursor-default object-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
          playsInline
          tabIndex={0}
          onBlur={releaseAll}
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if (!controlReady) return;
            event.preventDefault();
            sendControl({ type: 'key', code: event.code, down: true });
          }}
          onKeyUp={(event) => {
            if (!controlReady) return;
            event.preventDefault();
            sendControl({ type: 'key', code: event.code, down: false });
          }}
          onError={() => {
            if (restartPendingRef.current) {
              // The previous encoder was stopped for a resize; the new
              // stream is already loading.
              return;
            }
            failStream(describeMediaError(videoRef.current?.error));
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

      <div className="flex min-h-10 items-center justify-between gap-3 border-t border-zinc-800 bg-zinc-900 px-3 text-xs text-zinc-400">
        <span className="min-w-0 truncate">
          {controlReady
            ? `Control connected · ${sentEvents} events sent`
            : 'Control disconnected'}
          {isPlaying && sessionError ? (
            <span role="alert" className="text-destructive">
              {' · '}
              {sessionError}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          <span className="font-mono tabular-nums">
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
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            <Maximize2 />
          </Button>
        </span>
      </div>
    </div>
  );
}
