import { SETTINGS_PATHS } from '@/lib/settings';
import { LegacySettingsRedirectPage } from '../cloud-projects/LegacySettingsRedirectPage';

export default function Page() {
  return <LegacySettingsRedirectPage targetPath={SETTINGS_PATHS.automations} />;
}
