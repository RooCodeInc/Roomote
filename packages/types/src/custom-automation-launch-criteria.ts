import type {
  CustomAutomationRunWhen,
  CustomAutomationRunWhenJudgmentAnswer,
  CustomAutomationRunWhenOutcome,
} from './custom-automation-run-when';

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

/** Snapshot of all criteria applied to one automation occurrence. */
export type CustomAutomationLaunchCriteriaSnapshot = {
  launchCriteria?: string;
  runWhen?: CustomAutomationRunWhen;
};

/** Answers from the launch-criteria and typed runWhen checks. */
export type CustomAutomationLaunchCriteriaAnswers = {
  criteriaMet?: CustomAutomationLaunchCriteriaAnswer;
  runWhen?: Record<string, CustomAutomationRunWhenJudgmentAnswer>;
};

/** Individual outcomes from the checks combined in one launch gate. */
export type CustomAutomationLaunchCriteriaOutcomes = {
  launchCriteria?: CustomAutomationLaunchCriteriaOutcome;
  runWhen?: CustomAutomationRunWhenOutcome;
};
