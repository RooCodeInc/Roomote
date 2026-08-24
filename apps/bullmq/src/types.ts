import type { TriggerableBackgroundAutomationKey } from '@roomote/types';

/**
 * Infrastructure scheduled jobs (not user-facing automations).
 */
export enum ScheduledJobName {
  Heartbeat = 'Heartbeat',
  RefreshSnapshots = 'RefreshSnapshots',
  SleepCheck = 'SleepCheck',
  PullRequestAnalyticsSync = 'PullRequestAnalyticsSync',
  InstancePing = 'InstancePing',
  LicenseUsageSync = 'LicenseUsageSync',
  LicenseUsageHeartbeat = 'LicenseUsageHeartbeat',
  WebhookCleanup = 'WebhookCleanup',
  StandbyRetention = 'StandbyRetention',
  CustomAutomations = 'custom_automations',
  PrReviewNotificationDispatch = 'PrReviewNotificationDispatch',
  BrainOutboxDrain = 'BrainOutboxDrain',
  BrainCollectors = 'BrainCollectors',
  BrainMaintenance = 'BrainMaintenance',
  ProviderUsageLimitCheck = 'ProviderUsageLimitCheck',
}

/**
 * Automation scheduler jobs are named by the canonical snake_case automation
 * key (ci_failure_triage is webhook/Run-now driven and never scheduled).
 */
export type ScheduledAutomationJobName = Exclude<
  TriggerableBackgroundAutomationKey,
  'ci_failure_triage' | 'issue_fixer'
>;

export type SchedulerJobName = ScheduledJobName | ScheduledAutomationJobName;
