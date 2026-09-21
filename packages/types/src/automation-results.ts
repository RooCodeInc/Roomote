export const AUTOMATION_RESULT_PRIORITIES = [
  'normal',
  'high',
  'critical',
] as const;

export type AutomationResultPriority =
  (typeof AUTOMATION_RESULT_PRIORITIES)[number];

/** Immutable Results-page eligibility captured when automation output is stored. */
export type AutomationResultVisibility = 'shared' | 'private';

export const AUTOMATION_RESULT_KINDS = ['outcome', 'input_request'] as const;
export type AutomationResultKind = (typeof AUTOMATION_RESULT_KINDS)[number];

export const AUTOMATION_RESULT_PREPARATION_STATUSES = [
  'pending',
  'ready',
  'failed',
] as const;
export type AutomationResultPreparationStatus =
  (typeof AUTOMATION_RESULT_PREPARATION_STATUSES)[number];

export const AUTOMATION_RESULT_PRIORITY_LABELS: Record<
  AutomationResultPriority,
  string
> = {
  normal: 'Normal',
  high: 'High',
  critical: 'Critical',
};

export const AUTOMATION_RESULT_PRIORITY_RANK: Record<
  AutomationResultPriority,
  number
> = {
  normal: 0,
  high: 1,
  critical: 2,
};
