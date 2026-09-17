'use client';

import { Lock, Switch } from '@/components/system';
import { usePrivateSessionsExperiment } from '@/hooks/usePrivateSessionsExperiment';

import { Section } from './Section';

export function PrivateSessionsExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } =
    usePrivateSessionsExperiment();

  return (
    <Section icon={Lock} title="Private Sessions">
      <div className="flex gap-3">
        <Switch
          aria-label="Toggle Private Sessions"
          checked={enabled}
          disabled={isLoading || isUpdating}
          onCheckedChange={setEnabled}
        />
        <p className="text-sm text-muted-foreground">
          Let members create owner-only web Sessions without writing to shared
          memory or publishing to shared destinations.
        </p>
      </div>
    </Section>
  );
}
