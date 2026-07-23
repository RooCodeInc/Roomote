/**
 * Server-side anonymous analytics capture and Ping service client.
 *
 * Design rules:
 * - Telemetry must never throw into product code paths and never block them.
 * - Events are droppable: no persistence, no retries, short timeouts.
 * - Nothing leaves the process unless the environment gate allows it, and
 *   analytics events additionally require the admin-controlled opt-out
 *   setting to be enabled.
 */

import { Env, isRoomoteCloudEnabled } from '@roomote/env';
import {
  db,
  deploymentSettings,
  eq,
  getInstanceAnalyticsId,
  getUserAnalyticsId,
} from '@roomote/db/server';
import { isAnonymousAnalyticsEnabledFromMetadata } from '@roomote/feature-flags';

import {
  MAX_TELEMETRY_BATCH_SIZE,
  TELEMETRY_EVENT_NAME_PATTERN,
  type PingEvent,
  type PingEventsRequest,
  type PingInstanceReportRequest,
  type PingVersionCheckRequest,
  type PingVersionCheckResponse,
  type TelemetryEventProperties,
} from '../index';

const LOG_PREFIX = '[telemetry]';
const REQUEST_TIMEOUT_MS = 5_000;
const FLUSH_INTERVAL_MS = 10_000;

export interface TelemetryEnvInput {
  appEnv: string | undefined;
  releaseVersion: string | undefined;
  forceTelemetry: string | undefined;
  pingBaseUrl: string | undefined;
}

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

/**
 * Pure environment gate: telemetry (analytics and version checks alike) may
 * only leave production releases. Development and preview send nothing unless
 * force-enabled with an explicitly configured Ping endpoint. Builds without a
 * RELEASE_VERSION also stay silent unless force-enabled.
 */
export function isTelemetryEnvAllowedFor(input: TelemetryEnvInput): boolean {
  if (isTruthyFlag(input.forceTelemetry)) {
    return input.appEnv === 'production' || Boolean(input.pingBaseUrl?.trim());
  }

  const releaseVersion = input.releaseVersion?.trim();
  if (!releaseVersion) {
    return false;
  }

  return input.appEnv === 'production';
}

export function getTelemetryConfigurationNotice(
  input: TelemetryEnvInput,
): string | null {
  if (input.appEnv !== 'development' && input.appEnv !== 'preview') {
    return null;
  }

  const forceEnabled = isTruthyFlag(input.forceTelemetry);
  const pingEndpointConfigured = Boolean(input.pingBaseUrl?.trim());

  if (pingEndpointConfigured && !forceEnabled) {
    return (
      'R_PING_BASE_URL is configured, but Ping telemetry is disabled outside production. ' +
      'Set ROOMOTE_FORCE_TELEMETRY=true to enable it.'
    );
  }

  if (forceEnabled && !pingEndpointConfigured) {
    return (
      'ROOMOTE_FORCE_TELEMETRY is enabled, but R_PING_BASE_URL is not configured. ' +
      'Set an explicit Ping endpoint to enable telemetry outside production.'
    );
  }

  return null;
}

function readTelemetryEnv(): TelemetryEnvInput {
  return {
    appEnv: Env.APP_ENV,
    releaseVersion: Env.RELEASE_VERSION,
    forceTelemetry: Env.ROOMOTE_FORCE_TELEMETRY,
    // Env supplies a production Ping default, but forced non-production
    // telemetry must opt in to an endpoint rather than using that default.
    pingBaseUrl: process.env.R_PING_BASE_URL,
  };
}

const emittedConfigurationNotices = new Set<string>();

export function logTelemetryConfigurationNotice(
  input: TelemetryEnvInput,
): void {
  const notice = getTelemetryConfigurationNotice(input);
  if (notice && !emittedConfigurationNotices.has(notice)) {
    emittedConfigurationNotices.add(notice);
    console.info(`${LOG_PREFIX} ${notice}`);
  }
}

export function isTelemetryEnvAllowed(): boolean {
  const input = readTelemetryEnv();
  logTelemetryConfigurationNotice(input);
  return isTelemetryEnvAllowedFor(input);
}

function getAppVersion(): string | undefined {
  return Env.RELEASE_VERSION?.trim() || undefined;
}

function getPingBaseUrl(): string {
  return Env.R_PING_BASE_URL.replace(/\/+$/, '');
}

/**
 * Whether anonymous analytics is active: the environment gate allows
 * telemetry AND the admin-controlled deployment setting is enabled
 * (opt-out: absent means enabled).
 */
export async function isAnonymousAnalyticsEnabled(
  cloudEnabled = isRoomoteCloudEnabled(Env.R_CLOUD_ENABLED),
): Promise<boolean> {
  if (!isTelemetryEnvAllowed()) {
    return false;
  }

  try {
    const settings = await db.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, 'default'),
      columns: { metadata: true },
    });

    return isAnonymousAnalyticsEnabledFromMetadata(
      settings?.metadata,
      cloudEnabled,
    );
  } catch {
    return false;
  }
}

async function postToPing(path: string, body: unknown): Promise<Response> {
  return fetch(`${getPingBaseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/**
 * In-memory fire-and-forget batch queue. Events are dropped when the queue
 * cannot be delivered; telemetry must never surface failures to callers.
 */
const pendingEvents: PingEvent[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let flushInFlight: Promise<void> | null = null;

function scheduleFlush(): void {
  if (flushTimer) {
    return;
  }

  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushTelemetry();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

async function deliverBatch(events: PingEvent[]): Promise<void> {
  try {
    const request: PingEventsRequest = {
      instanceId: await getInstanceAnalyticsId(),
      appVersion: getAppVersion(),
      sentAt: new Date().toISOString(),
      events,
    };

    const response = await postToPing('/v1/events', request);
    if (!response.ok) {
      console.warn(
        `${LOG_PREFIX} dropping ${events.length} event(s): ping responded ${response.status}`,
      );
    }
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} dropping ${events.length} event(s):`,
      error instanceof Error ? error.message : error,
    );
  }
}

/** Drains the queue. Never throws. */
export async function flushTelemetry(): Promise<void> {
  if (flushInFlight) {
    await flushInFlight;
  }

  if (pendingEvents.length === 0) {
    return;
  }

  const batch = pendingEvents.splice(0, pendingEvents.length);
  flushInFlight = deliverBatch(batch).finally(() => {
    flushInFlight = null;
  });
  await flushInFlight;
}

function enqueue(event: PingEvent): void {
  pendingEvents.push(event);

  if (pendingEvents.length >= MAX_TELEMETRY_BATCH_SIZE) {
    void flushTelemetry();
    return;
  }

  scheduleFlush();
}

export interface CaptureEventOptions {
  /**
   * Attribute the event to this user's anonymous analytics id. Without a
   * userId the event is instance-level (distinct id = instance id).
   */
  userId?: string;
  properties?: TelemetryEventProperties;
  /** ISO-8601 override; defaults to now. */
  timestamp?: string;
  cloudEnabled?: boolean;
}

/**
 * Captures an anonymous analytics event. No-ops (and never throws) when
 * analytics is disabled, the event name is invalid, or ids cannot be
 * resolved.
 */
export async function captureEvent(
  event: string,
  options: CaptureEventOptions = {},
): Promise<void> {
  try {
    if (!TELEMETRY_EVENT_NAME_PATTERN.test(event)) {
      return;
    }

    if (!(await isAnonymousAnalyticsEnabled(options.cloudEnabled))) {
      return;
    }

    const distinctId = options.userId
      ? await getUserAnalyticsId(options.userId)
      : await getInstanceAnalyticsId();

    if (!distinctId) {
      return;
    }

    enqueue({
      event,
      distinctId,
      timestamp: options.timestamp ?? new Date().toISOString(),
      properties: options.properties,
    });
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} failed to capture ${event}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/** Captures an instance-level event (distinct id = instance analytics id). */
export async function captureInstanceEvent(
  event: string,
  properties?: TelemetryEventProperties,
): Promise<void> {
  return captureEvent(event, { properties });
}

/**
 * Asks the Ping service for the latest released version. Mandatory (not
 * gated by the analytics setting) but still env-gated: non-production sends
 * nothing without an explicit force flag and Ping endpoint.
 * Returns null on any failure.
 */
export async function checkLatestVersion(): Promise<PingVersionCheckResponse | null> {
  if (!isTelemetryEnvAllowed()) {
    return null;
  }

  try {
    const request: PingVersionCheckRequest = {
      instanceId: await getInstanceAnalyticsId(),
      appVersion: getAppVersion(),
    };

    const response = await postToPing('/v1/version-check', request);
    if (!response.ok) {
      console.warn(
        `${LOG_PREFIX} version check failed: ping responded ${response.status}`,
      );
      return null;
    }

    const payload = (await response.json()) as PingVersionCheckResponse;
    return typeof payload?.latestVersion === 'string' ||
      payload?.latestVersion === null
      ? payload
      : null;
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} version check failed:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Sends the daily anonymous instance report. Gated by the analytics
 * setting; never throws. Returns whether the report was accepted.
 */
export async function sendInstanceReport(
  report: Record<string, unknown>,
): Promise<boolean> {
  try {
    if (!(await isAnonymousAnalyticsEnabled())) {
      return false;
    }

    const request: PingInstanceReportRequest = {
      instanceId: await getInstanceAnalyticsId(),
      appVersion: getAppVersion(),
      sentAt: new Date().toISOString(),
      report,
    };

    const response = await postToPing('/v1/instance-report', request);
    if (!response.ok) {
      console.warn(
        `${LOG_PREFIX} instance report failed: ping responded ${response.status}`,
      );
      return false;
    }

    return true;
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} instance report failed:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}
