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
}

/**
 * Automation scheduler jobs are named by the canonical snake_case automation
 * key (ci_failure_triage is webhook/Run-now driven and never scheduled).
 */
export type ScheduledAutomationJobName = Exclude<
  TriggerableBackgroundAutomationKey,
  'ci_failure_triage'
>;

export type SchedulerJobName = ScheduledJobName | ScheduledAutomationJobName;
