'use client';

import { ComputeProviders } from '@/components/settings/ComputeProviders';
import { SettingsShell } from '@/components/settings/SettingsShell';

export function ComputeSettingsPage() {
  return (
    <SettingsShell pageId="compute" adminOnly={true}>
      <ComputeProviders />
    </SettingsShell>
  );
}
