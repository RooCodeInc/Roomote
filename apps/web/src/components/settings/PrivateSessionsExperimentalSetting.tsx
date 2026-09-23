'use client';

import { Lock, Switch } from '@/components/system';
import { usePrivateSessionsExperiment } from '@/hooks/usePrivateSessionsExperiment';

import { Section } from './Section';

export function PrivateSessionsExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } =
    usePrivateSessionsExperiment();

  return (
    <Section icon={Lock} title="Private sessions">
      <div className="flex gap-3">
        <Switch
          aria-label="Toggle private sessions"
          checked={enabled}
          disabled={isLoading || isUpdating}
          onCheckedChange={setEnabled}
        />
        <p className="text-sm text-muted-foreground">
          Let members create owner-only web sessions that stay out of shared
          memory. The agent asks the owner before publishing anything outside
          the session.
        </p>
      </div>
    </Section>
  );
}
