import { SETTINGS_PATHS } from '@/lib/settings';

import { LegacySettingsRedirectPage } from './LegacySettingsRedirectPage';

export default function LegacyCloudProjectsSettingsPage() {
  return (
    <LegacySettingsRedirectPage targetPath={SETTINGS_PATHS.environments} />
  );
}
