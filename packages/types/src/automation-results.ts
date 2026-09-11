export const AUTOMATION_RESULT_PRIORITIES = [
  'normal',
  'high',
  'critical',
] as const;

export type AutomationResultPriority =
  (typeof AUTOMATION_RESULT_PRIORITIES)[number];

export const AUTOMATION_RESULT_KINDS = ['report', 'suggestion'] as const;

export type AutomationResultKind = (typeof AUTOMATION_RESULT_KINDS)[number];

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
