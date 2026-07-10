import { Env } from '@/lib/server/env';

import { OnboardingClient } from './OnboardingClient';

export default function OnboardingPage() {
  return <OnboardingClient githubAppSlug={Env.R_GITHUB_APP_SLUG} />;
}
