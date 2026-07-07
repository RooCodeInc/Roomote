/**
 * Telemetry package - client-safe exports.
 *
 * Shared types and constants for Roomote's anonymous analytics ("Ping")
 * pipeline. No environment or database access here; server-side capture
 * lives in `@roomote/telemetry/server`.
 */

export type TelemetryPropertyValue =
  | string
  | number
  | boolean
  | null
  | string[];

export type TelemetryEventProperties = Record<string, TelemetryPropertyValue>;

/**
 * A telemetry event as submitted by product code (client relay or server
 * capture). `distinctId` is resolved server-side from anonymous ids.
 */
export interface TelemetryEventInput {
  event: string;
  properties?: TelemetryEventProperties;
  /** ISO-8601 timestamp; defaults to capture time. */
  timestamp?: string;
}

/** PostHog-compatible page view event name. */
export const PAGEVIEW_EVENT = '$pageview';

/** Event names: lowercase snake case, plus PostHog-style `$` events. */
export const TELEMETRY_EVENT_NAME_PATTERN = /^[$a-z][a-z0-9_]{0,99}$/;

export const MAX_TELEMETRY_BATCH_SIZE = 20;

/**
 * Wire types for the hosted Ping service (`/v1/*`). Versioned: breaking
 * changes require a new API version, additive fields do not.
 */

export interface PingEvent {
  event: string;
  distinctId: string;
  timestamp: string;
  properties?: TelemetryEventProperties;
}

export interface PingEventsRequest {
  instanceId: string;
  appVersion?: string;
  sentAt: string;
  events: PingEvent[];
}

export interface PingInstanceReportRequest {
  instanceId: string;
  appVersion?: string;
  sentAt: string;
  report: Record<string, unknown>;
}

export interface PingVersionCheckRequest {
  instanceId: string;
  appVersion?: string;
}

export interface PingVersionCheckResponse {
  latestVersion: string | null;
  checkedAt?: string;
}
