import type { SourceControlProvider } from '@roomote/types';

const ONBOARDING_COMMUNICATION_PROVIDER_IDS = [
  'slack',
  'microsoft',
  'telegram',
  'discord',
] as const;

const ONBOARDING_SOURCE_CONTROL_PROVIDER_IDS = [
  'github',
  'gitlab',
  'gitea',
  'bitbucket',
  'ado',
] as const satisfies readonly SourceControlProvider[];

export const ONBOARDING_PROVIDER_IDS = [
  ...ONBOARDING_COMMUNICATION_PROVIDER_IDS,
  ...ONBOARDING_SOURCE_CONTROL_PROVIDER_IDS,
] as const;

export type OnboardingCommunicationProviderId =
  (typeof ONBOARDING_COMMUNICATION_PROVIDER_IDS)[number];
export type OnboardingLinkableProvider =
  | {
      id: OnboardingCommunicationProviderId;
      category: 'communication';
      label: string;
      configured: boolean;
      linked: boolean;
    }
  | {
      id: SourceControlProvider;
      category: 'source-control';
      label: string;
      configured: boolean;
      linked: boolean;
    };

export const ONBOARDING_STEP_IDS = [
  'welcome',
  ...ONBOARDING_PROVIDER_IDS,
  'invoke',
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEP_IDS)[number];
