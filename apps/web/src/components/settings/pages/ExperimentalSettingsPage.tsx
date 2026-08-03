'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';

export function ExperimentalSettingsPage() {
  return (
    <SettingsShell pageId="experimental" adminOnly={true}>
      <p className="text-sm text-muted-foreground">
        No experimental features are available right now. Check back soon.
      </p>
    </SettingsShell>
  );
}
