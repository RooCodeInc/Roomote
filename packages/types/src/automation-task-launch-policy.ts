import type { BackgroundAutomationKey } from './background-agents';

/** Release-N gate: schema/read support ships now; ownerless writes start N+1. */
export const AUTOMATION_OWNED_FAST_SESSION_WRITES_ENABLED = false;

export type AutomationTaskLaunchPolicyId =
  | 'custom_automation'
  | 'scheduled_triage_scan'
  | 'merged_pr_audit_scan'
  | 'suggester_scan'
  | 'announcer'
  | 'conflict_resolution'
  | 'ci_failure_triage'
  | 'issue_fixer'
  | 'automation_work_item'
  | 'pr_review'
  | 'chat_channel_auto_start'
  | 'slack_workflow'
  | 'snapshot_refresh'
  | 'mcp_recommendations'
  | 'onboarding_suggestion_scan'
  | 'deployment_ci_probe';

type AutomationTaskLaunchPolicy = {
  id: AutomationTaskLaunchPolicyId;
  automationKeys: readonly BackgroundAutomationKey[];
  launchSites: readonly string[];
} & (
  | {
      mode: 'owned_fast_session';
      ownerlessFallback: 'legacy_sandbox_task';
      reason: string;
    }
  | {
      mode: 'sandbox_task';
      reason: string;
    }
);

/**
 * Complete inventory of production automation paths that can create a fresh
 * sandbox task. Fast eligibility is explicit here so reviews can distinguish
 * owned conversational runs from system workflows that require a task.
 */
export const AUTOMATION_TASK_LAUNCH_POLICIES = [
  {
    id: 'custom_automation',
    automationKeys: ['custom_automation'],
    launchSites: ['packages/sdk/src/server/automations/custom-automations.ts'],
    mode: 'owned_fast_session',
    ownerlessFallback: 'legacy_sandbox_task',
    reason:
      'Custom automation rows persist createdByUserId, so owned runs can authorize a Fast Session; legacy rows whose owner was deleted retain their previous sandbox path.',
  },
  {
    id: 'scheduled_triage_scan',
    automationKeys: ['sentry_triage', 'dependabot_triage', 'codeql_triage'],
    launchSites: [
      'packages/sdk/src/server/automations/scheduled-triage-runner.ts',
    ],
    mode: 'sandbox_task',
    reason:
      'These deployment-owned hidden Scan tasks have no run-as user and produce machine-consumed automation work items.',
  },
  {
    id: 'merged_pr_audit_scan',
    automationKeys: ['security_auditor', 'code_quality_auditor'],
    launchSites: [
      'packages/sdk/src/server/automations/merged-pr-audit-runner.ts',
    ],
    mode: 'sandbox_task',
    reason:
      'These deployment-owned hidden Scan tasks have no run-as user and preserve provider-partitioned audit cursors and machine-consumed work items.',
  },
  {
    id: 'suggester_scan',
    automationKeys: ['suggester'],
    launchSites: ['packages/sdk/src/server/automations/suggester-dispatch.ts'],
    mode: 'sandbox_task',
    reason:
      'The deployment-owned hidden Scan task has no run-as user and feeds the structured suggestion pipeline.',
  },
  {
    id: 'announcer',
    automationKeys: ['announcer'],
    launchSites: ['packages/sdk/src/server/automations/announcer.ts'],
    mode: 'sandbox_task',
    reason:
      'The announcer is deployment-owned and has no persisted user whose integrations and credentials can authorize a Fast Session.',
  },
  {
    id: 'conflict_resolution',
    automationKeys: ['conflict_resolver'],
    launchSites: [
      'packages/sdk/src/server/automations/conflict-scan.ts',
      'apps/api/src/handlers/github/conflict-resolution/process-candidates.ts',
    ],
    mode: 'sandbox_task',
    reason:
      'Conflict resolution always requires repository execution and specialized pr_conflict_resolve payload, PR linkage, and deduplication contracts.',
  },
  {
    id: 'ci_failure_triage',
    automationKeys: ['ci_failure_triage'],
    launchSites: [
      'packages/sdk/src/server/automations/ci-failure-triage.ts',
      'packages/sdk/src/server/automations/ci-failure-triage-launch.ts',
    ],
    mode: 'sandbox_task',
    reason:
      'CI triage is deployment-owned, always requires workspace investigation, and carries fingerprint claims plus webhook announcement-thread state.',
  },
  {
    id: 'issue_fixer',
    automationKeys: ['issue_fixer'],
    launchSites: ['apps/api/src/handlers/shared/issue-fixer-launch.ts'],
    mode: 'sandbox_task',
    reason:
      'Issue fixing is deployment-owned, always requires repository inspection, and must preserve provider issue-comment delivery semantics.',
  },
  {
    id: 'automation_work_item',
    automationKeys: [
      'sentry_triage',
      'dependabot_triage',
      'codeql_triage',
      'security_auditor',
      'code_quality_auditor',
      'ci_failure_triage',
    ],
    launchSites: [
      'apps/api/src/handlers/tasks/automation-work-items/launch.ts',
    ],
    mode: 'sandbox_task',
    reason:
      'Accepted work items are explicit repository implementation requests with launch claims and linked-task finalization, so a sandbox is required rather than optional.',
  },
  {
    id: 'pr_review',
    automationKeys: ['review_code'],
    launchSites: [
      'apps/api/src/handlers/github/handlePrOpen.ts',
      'apps/api/src/handlers/github/handlePrSynchronize.ts',
      'apps/api/src/handlers/gitlab/handleMergeRequest.ts',
      'apps/api/src/handlers/gitea/handlePullRequest.ts',
      'apps/api/src/handlers/bitbucket/handlePullRequest.ts',
      'apps/api/src/handlers/ado/handlePullRequest.ts',
      'apps/bullmq/src/jobs/active-pr-review-follow-up.ts',
    ],
    mode: 'sandbox_task',
    reason:
      'Automated PR reviews are deployment-owned and require specialized review payload, PR linkage, check publication, and follow-up deduplication.',
  },
  {
    id: 'chat_channel_auto_start',
    automationKeys: ['slack_channel_auto_start'],
    launchSites: [
      'apps/api/src/handlers/slack/events/message-entry.ts',
      'apps/api/src/handlers/discord/channel-auto-start.ts',
    ],
    mode: 'sandbox_task',
    reason:
      'Only bot, webhook, or relay-authored channel events use the automation path; they have external attribution but no mapped Roomote run-as user.',
  },
  {
    id: 'slack_workflow',
    automationKeys: ['slack_workflow'],
    launchSites: ['apps/api/src/handlers/slack/events/function-executed.ts'],
    mode: 'sandbox_task',
    reason:
      'Prompt-author-owned Slack workflow runs already use a user launch; the automation fallback is used only when no mapped prompt author exists.',
  },
  {
    id: 'snapshot_refresh',
    automationKeys: ['snapshot_refresh'],
    launchSites: ['apps/bullmq/src/scheduled-jobs/refresh-snapshots.ts'],
    mode: 'sandbox_task',
    reason:
      'Snapshot refresh exists to execute sandbox snapshot lifecycle work and cannot complete without compute.',
  },
  {
    id: 'mcp_recommendations',
    automationKeys: ['mcp_recommendations'],
    launchSites: ['apps/web/src/trpc/commands/setup/index.ts'],
    mode: 'sandbox_task',
    reason:
      'MCP recommendations run inside setup against a selected environment and have no persisted automation owner.',
  },
  {
    id: 'onboarding_suggestion_scan',
    automationKeys: ['suggester'],
    launchSites: ['apps/web/src/trpc/commands/task-suggestions/onboarding.ts'],
    mode: 'sandbox_task',
    reason:
      'This user-owned setup scan writes machine-consumed onboarding suggestion state and requires the selected repository workspace rather than an optional sandbox.',
  },
  {
    id: 'deployment_ci_probe',
    automationKeys: ['suggester'],
    launchSites: [
      'packages/cloud-agents/src/server/deployment-ci-launch-task.ts',
    ],
    mode: 'sandbox_task',
    reason:
      'The deployment probe exists specifically to start and verify Docker sandbox compute.',
  },
] as const satisfies readonly AutomationTaskLaunchPolicy[];

const AUTOMATION_TASK_LAUNCH_POLICY_BY_ID = new Map(
  AUTOMATION_TASK_LAUNCH_POLICIES.map((policy) => [policy.id, policy]),
);

export function resolveAutomationTaskLaunchMode(params: {
  policyId: AutomationTaskLaunchPolicyId;
  runAsUserId?: string | null;
}): 'fast_session' | 'sandbox_task' {
  const policy = AUTOMATION_TASK_LAUNCH_POLICY_BY_ID.get(params.policyId);
  if (!policy) {
    throw new Error(
      `Unknown automation task launch policy: ${params.policyId}`,
    );
  }

  return policy.mode === 'owned_fast_session' && params.runAsUserId
    ? 'fast_session'
    : 'sandbox_task';
}
