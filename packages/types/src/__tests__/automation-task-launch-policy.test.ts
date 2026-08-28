import { describe, expect, it } from 'vitest';

import {
  AUTOMATION_TASK_LAUNCH_POLICIES,
  resolveAutomationTaskLaunchMode,
} from '../automation-task-launch-policy';

describe('automation task launch policies', () => {
  it('keeps a complete, uniquely identified launcher inventory', () => {
    expect(AUTOMATION_TASK_LAUNCH_POLICIES.map(({ id }) => id)).toEqual([
      'custom_automation',
      'scheduled_triage_scan',
      'merged_pr_audit_scan',
      'suggester_scan',
      'announcer',
      'conflict_resolution',
      'ci_failure_triage',
      'issue_fixer',
      'automation_work_item',
      'pr_review',
      'chat_channel_auto_start',
      'slack_workflow',
      'snapshot_refresh',
      'mcp_recommendations',
      'onboarding_suggestion_scan',
      'deployment_ci_probe',
    ]);
    expect(
      new Set(
        AUTOMATION_TASK_LAUNCH_POLICIES.flatMap(({ launchSites }) =>
          launchSites.map((site) => site),
        ),
      ).size,
    ).toBe(
      AUTOMATION_TASK_LAUNCH_POLICIES.reduce(
        (count, { launchSites }) => count + launchSites.length,
        0,
      ),
    );
    for (const policy of AUTOMATION_TASK_LAUNCH_POLICIES) {
      expect(policy.automationKeys.length).toBeGreaterThan(0);
      expect(policy.launchSites.length).toBeGreaterThan(0);
      expect(policy.reason.length).toBeGreaterThan(40);
    }
  });

  it('starts only owned custom automations as Fast Sessions', () => {
    expect(
      resolveAutomationTaskLaunchMode({
        policyId: 'custom_automation',
        runAsUserId: 'user-1',
      }),
    ).toBe('fast_session');
    expect(
      resolveAutomationTaskLaunchMode({
        policyId: 'custom_automation',
        runAsUserId: null,
      }),
    ).toBe('sandbox_task');

    for (const policy of AUTOMATION_TASK_LAUNCH_POLICIES) {
      if (policy.id === 'custom_automation') continue;
      expect(
        resolveAutomationTaskLaunchMode({
          policyId: policy.id,
          runAsUserId: 'user-1',
        }),
      ).toBe('sandbox_task');
    }
  });
});
