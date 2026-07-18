import type { TaskSuggestionSource } from '@roomote/types';

export type AutomationKey = Extract<
  TaskSuggestionSource,
  | 'sentry_triage'
  | 'dependabot_triage'
  | 'codeql_triage'
  | 'security_auditor'
  | 'code_quality_auditor'
  | 'ci_failure_triage'
>;

export function isAutomationWorkItemSource(
  source: TaskSuggestionSource | undefined,
): source is AutomationKey {
  return (
    source === 'sentry_triage' ||
    source === 'dependabot_triage' ||
    source === 'codeql_triage' ||
    source === 'security_auditor' ||
    source === 'code_quality_auditor' ||
    source === 'ci_failure_triage'
  );
}

export function buildAutomationWorkItemsSummaryLockKey(params: {
  sourceTaskId: string;
}): string {
  return `automation_work_items:${params.sourceTaskId}`;
}
