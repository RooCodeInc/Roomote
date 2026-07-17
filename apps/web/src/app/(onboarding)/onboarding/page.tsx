import { Env } from '@/lib/server/env';
import { PAGE_METADATA } from '@/lib/metadata';

import { OnboardingClient } from './OnboardingClient';

export const metadata = PAGE_METADATA.onboarding;

export default function OnboardingPage() {
  return <OnboardingClient githubAppSlug={Env.R_GITHUB_APP_SLUG} />;
}
