'use client';

import { Scale, Switch } from '@/components/system';
import { useDeploymentExperiment } from '@/hooks/useDeploymentExperiments';
import { Section } from './Section';

export function JudgementExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } =
    useDeploymentExperiment('judgement', 'Failed to update Judgement.');

  return (
    <Section icon={Scale} title="Judgement repository rules">
      <div className="flex gap-3">
        <Switch
          aria-label="Toggle Judgement repository rules"
          checked={enabled}
          disabled={isLoading || isUpdating}
          onCheckedChange={setEnabled}
        />
        <p className="text-sm text-muted-foreground">
          Let coding tasks turn recurring mistakes into repository rules and
          test them against examples. Requires Jev under Settings → Models and
          takes effect on the next task run. Checks send selected repository
          content to that provider.
        </p>
      </div>
    </Section>
  );
}
