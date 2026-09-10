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

/** Non-identifying sources permitted on deployment activation events. */
export const ACTIVATION_ENVIRONMENT_SOURCES = [
  'setup',
  'settings',
  'mcp',
] as const;

export type ActivationEnvironmentSource =
  (typeof ACTIVATION_ENVIRONMENT_SOURCES)[number];

export const ACTIVATION_SETUP_MILESTONES = [
  'welcome',
  'authed',
  'comms_configured',
  'comms_authed',
  'source_control_configured',
  'source_control_authed',
  'inference_configured',
  'sandbox_configured',
] as const;

export type ActivationSetupMilestone =
  (typeof ACTIVATION_SETUP_MILESTONES)[number];

export type ActivationSetupMilestoneProperties = {
  provider?: string;
  preexisting?: boolean;
};

export function buildActivationSetupMilestoneProperties(
  properties: ActivationSetupMilestoneProperties,
): TelemetryEventProperties | undefined {
  if (
    properties.provider === undefined &&
    properties.preexisting === undefined
  ) {
    return undefined;
  }

  return {
    ...(properties.provider === undefined
      ? {}
      : { provider: properties.provider }),
    ...(properties.preexisting === undefined
      ? {}
      : { preexisting: properties.preexisting }),
  };
}

export type ActivationTaskProperties = {
  workflow: string;
  surface: string;
  trigger: string;
  harness: string | null;
  model: string | null;
  computeProvider: string | null;
};

/** Activation events contain routing classifications, never user or repo data. */
export function buildActivationTaskProperties(
  properties: ActivationTaskProperties,
): TelemetryEventProperties {
  return {
    workflow: properties.workflow,
    surface: properties.surface,
    trigger: properties.trigger,
    harness: properties.harness,
    model: properties.model,
    computeProvider: properties.computeProvider,
  };
}

export function buildActivationPrMergedProperties(properties: {
  provider: string;
  workflow: string;
  surface: string;
}): TelemetryEventProperties {
  return {
    provider: properties.provider,
    workflow: properties.workflow,
    surface: properties.surface,
  };
}

export type ActivationAutomationAction = 'enabled' | 'disabled';

export type ActivationAutomation =
  | 'call_roomote_via_emoji'
  | 'slack_channel_auto_start'
  | 'review_code'
  | 'conflict_resolver'
  | 'manager_stats'
  | 'provider_usage_limit'
  | 'sentry_triage'
  | 'dependabot_triage'
  | 'codeql_triage'
  | 'issue_fixer'
  | 'security_auditor'
  | 'code_quality_auditor'
  | 'ci_failure_triage'
  | 'merge_announcer'
  | 'suggester'
  | 'announcer'
  | 'platform_issue_alerts';

export function buildActivationAutomationProperties(
  automation: ActivationAutomation,
): TelemetryEventProperties {
  return { automation };
}

export type ActivationCustomAutomationAction = 'created' | 'deleted';
export type ActivationAutomationDestinationProvider =
  | 'slack'
  | 'discord'
  | 'teams'
  | 'telegram';

export function toActivationAutomationDestinationProvider(
  provider: string | null | undefined,
): ActivationAutomationDestinationProvider | null {
  return provider === 'slack' ||
    provider === 'discord' ||
    provider === 'teams' ||
    provider === 'telegram'
    ? provider
    : null;
}

export function buildActivationCustomAutomationProperties(
  destinationProvider: ActivationAutomationDestinationProvider | null,
): TelemetryEventProperties {
  return { destinationProvider };
}

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
  appVersion: string;
  sentAt: string;
  events: PingEvent[];
}

export interface PingInstanceReportRequest {
  instanceId: string;
  appVersion: string;
  cloud: boolean;
  sentAt: string;
  report: Record<string, unknown>;
}

export interface PingVersionCheckRequest {
  instanceId: string;
  appVersion: string;
}

export interface PingVersionCheckResponse {
  latestVersion: string | null;
  checkedAt?: string;
}

export type LicenseEntitlementValue = string | number | boolean;

export interface LicenseUsageReportRequest {
  contractVersion: 1;
  deploymentId: string;
  eventId: string;
  observedAt: string;
  appVersion?: string;
  usage: { activeUsers: number };
}

export interface LicenseUsageReportResponse {
  licenseId: string;
  activationExpiresAt: string;
  entitlementsVersion: string;
  entitlements: Record<string, LicenseEntitlementValue>;
  entitlementsExpiresAt: string;
}
