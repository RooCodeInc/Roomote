export const ONBOARDING_STEPS = [
  'welcome',
  'slack',
  'linear',
  'github',
  'invoke',
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
