/**
 * Browser-side anonymous analytics tracker.
 *
 * This module is only ever loaded through a dynamic import guarded by the
 * deployment's anonymous-analytics setting (see TelemetryProvider and
 * useTelemetry): when analytics is disabled, none of this code reaches the
 * browser. Events are relayed to the app backend (`/api/telemetry`), which
 * enforces the setting again server-side before forwarding to Ping.
 */

import {
  MAX_TELEMETRY_BATCH_SIZE,
  PAGEVIEW_EVENT,
  type TelemetryEventProperties,
} from '@roomote/telemetry';

import { normalizePath } from './normalize-path';

const ENDPOINT = '/api/telemetry';
const FLUSH_INTERVAL_MS = 5_000;

interface QueuedEvent {
  event: string;
  properties?: TelemetryEventProperties;
  timestamp: string;
}

const queue: QueuedEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lifecycleListenersInstalled = false;

function drainQueueBody(): string | null {
  if (queue.length === 0) {
    return null;
  }
  const events = queue.splice(0, queue.length);
  return JSON.stringify({ events });
}

function flushWithBeacon(): void {
  const body = drainQueueBody();
  if (!body) {
    return;
  }

  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    navigator.sendBeacon(
      ENDPOINT,
      new Blob([body], { type: 'application/json' }),
    );
    return;
  }

  void fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {});
}

async function flush(): Promise<void> {
  const body = drainQueueBody();
  if (!body) {
    return;
  }

  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    });
  } catch {
    // Telemetry is fire-and-forget: dropped on failure, never retried.
  }
}

function scheduleFlush(): void {
  if (flushTimer !== null) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_INTERVAL_MS);
}

function installLifecycleListeners(): void {
  if (lifecycleListenersInstalled || typeof window === 'undefined') {
    return;
  }
  lifecycleListenersInstalled = true;

  window.addEventListener('pagehide', flushWithBeacon);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushWithBeacon();
    }
  });
}

/**
 * Queues an arbitrary anonymous analytics event. Only callable from code
 * paths already gated by the analytics setting (see useTelemetry).
 *
 * @public
 */
export function capture(
  event: string,
  properties?: TelemetryEventProperties,
): void {
  installLifecycleListeners();

  queue.push({
    event,
    properties,
    timestamp: new Date().toISOString(),
  });

  if (queue.length >= MAX_TELEMETRY_BATCH_SIZE) {
    void flush();
    return;
  }

  scheduleFlush();
}

/**
 * Tracks a page view for the given concrete pathname. The path is reduced
 * to a route pattern (and the query string dropped unless allowlisted)
 * before it is queued.
 */
export function trackPageview(rawPathname: string, rawSearch: string): void {
  const { path, search } = normalizePath(rawPathname, rawSearch);
  const properties: TelemetryEventProperties = { path };
  if (search) {
    properties.search = search;
  }
  capture(PAGEVIEW_EVENT, properties);
}
