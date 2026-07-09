import { SETTINGS_PATHS } from '@/lib/settings';

import { LegacySettingsRedirectPage } from '../cloud-projects/LegacySettingsRedirectPage';

export default function LegacyComputeSettingsPage() {
  return <LegacySettingsRedirectPage targetPath={SETTINGS_PATHS.compute} />;
}
