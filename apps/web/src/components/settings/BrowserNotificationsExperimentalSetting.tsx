'use client';

import { BellElectric, Switch } from '@/components/system';
import { useBrowserNotificationsExperiment } from '@/hooks/useBrowserNotificationsExperiment';

import { Section } from './Section';

export function BrowserNotificationsExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } =
    useBrowserNotificationsExperiment();
  return (
    <Section icon={BellElectric} title="Browser notifications">
      <div className="flex gap-3">
        <Switch
          aria-label="Toggle browser notifications"
          checked={enabled}
          disabled={isLoading || isUpdating}
          onCheckedChange={setEnabled}
        />
        <p className="text-sm text-muted-foreground">
          Let open Session and task pages offer desktop notifications before
          falling back to a connected personal provider.
        </p>
      </div>
    </Section>
  );
}
