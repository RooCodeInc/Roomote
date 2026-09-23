export const CUSTOM_AUTOMATION_LAUNCH_CRITERIA_OUTCOMES = [
  'passed',
  'skipped',
  'uncertain',
  'unavailable',
  'error',
] as const;

export type CustomAutomationLaunchCriteriaOutcome =
  (typeof CUSTOM_AUTOMATION_LAUNCH_CRITERIA_OUTCOMES)[number];

export type CustomAutomationLaunchCriteriaAnswer = {
  type: 'noul';
  noul: number;
};
