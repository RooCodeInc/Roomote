'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import { LivePreviewsSettings } from '@/components/settings/previews/LivePreviewsSettings';

export function LivePreviewsSettingsPage() {
  return (
    <SettingsShell pageId="previews" adminOnly={true}>
      <LivePreviewsSettings />
    </SettingsShell>
  );
}
