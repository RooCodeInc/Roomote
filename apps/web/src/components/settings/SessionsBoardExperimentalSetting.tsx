'use client';

import { Columns3, Switch } from '@/components/system';
import { useDeploymentExperiment } from '@/hooks/useDeploymentExperiments';

import { Section } from './Section';

export function SessionsBoardExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } =
    useDeploymentExperiment(
      'sessionsBoard',
      'Failed to update the Sessions board setting.',
    );

  return (
    <Section icon={Columns3} title="Sessions board">
      <div className="flex gap-3">
        <Switch
          aria-label="Toggle Sessions board"
          checked={enabled}
          disabled={isLoading || isUpdating}
          onCheckedChange={setEnabled}
        />
        <p className="text-sm text-muted-foreground">
          Show the Sessions board to deployment members. Everyone keeps their
          existing access to Sessions.
        </p>
      </div>
    </Section>
  );
}
