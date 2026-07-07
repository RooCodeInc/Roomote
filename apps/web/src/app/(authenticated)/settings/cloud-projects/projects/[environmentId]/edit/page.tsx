import { SETTINGS_PATHS } from '@/lib/settings';

import { LegacySettingsRedirectPage } from '../../../LegacySettingsRedirectPage';

export default async function LegacyEditCloudProjectPage({
  params,
}: {
  params: Promise<{ environmentId: string }>;
}) {
  const { environmentId } = await params;

  return (
    <LegacySettingsRedirectPage
      targetPath={SETTINGS_PATHS.editEnvironment(environmentId)}
    />
  );
}
