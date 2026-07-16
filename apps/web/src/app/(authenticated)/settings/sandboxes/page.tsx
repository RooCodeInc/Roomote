import { redirect } from 'next/navigation';

import { ComputeSettingsPage } from '@/components/settings/pages/ComputeSettingsPage';
import { SETTINGS_PATHS } from '@/lib/settings';
import { authorizeOrThrow } from '@/lib/server/auth-context';

export default async function Page() {
  const user = await authorizeOrThrow();
  if (user.cloudEnabled) {
    redirect(SETTINGS_PATHS.personal);
  }

  return <ComputeSettingsPage />;
}
