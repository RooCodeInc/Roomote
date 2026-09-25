'use client';

import { Activity, Switch } from '@/components/system';
import { useDeploymentExperiment } from '@/hooks/useDeploymentExperiments';

import { Section } from './Section';

export function SessionStatusJudgmentExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } =
    useDeploymentExperiment(
      'sessionStatusJudgment',
      'Failed to update Session status judgment.',
    );

  return (
    <Section icon={Activity} title="Session status judgment">
      <div className="flex gap-3">
        <Switch
          aria-label="Toggle Session status judgment"
          checked={enabled}
          disabled={isLoading || isUpdating}
          onCheckedChange={setEnabled}
        />
        <p className="text-sm text-muted-foreground">
          Classify settled Session outcomes with the configured judgment model.
          Results stay hidden until the Sessions board is enabled.
        </p>
      </div>
    </Section>
  );
}
