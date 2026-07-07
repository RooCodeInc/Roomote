import { SETTINGS_PATHS } from '@/lib/settings';

import { LegacySettingsRedirectPage } from '../../LegacySettingsRedirectPage';

export default function LegacyCreateCloudProjectPage() {
  return (
    <LegacySettingsRedirectPage targetPath={SETTINGS_PATHS.newEnvironment} />
  );
}
