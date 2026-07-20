import { redirect } from 'next/navigation';

import { ComputeSettingsPage } from '@/components/settings/pages/ComputeSettingsPage';
import { SETTINGS_PATHS } from '@/lib/settings';
import { Env, isRoomoteCloudEnabled } from '@/lib/server/env';

export default function Page() {
  if (isRoomoteCloudEnabled(Env.R_CLOUD_ENABLED)) {
    redirect(SETTINGS_PATHS.personal);
  }

  return <ComputeSettingsPage />;
}
