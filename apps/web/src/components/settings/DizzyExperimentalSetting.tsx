'use client';

import { RefreshCw, Switch } from '@/components/system';
import { useDeploymentExperiment } from '@/hooks/useDeploymentExperiments';

import { Section } from './Section';

export function DizzyExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } =
    useDeploymentExperiment('dizzy', 'Failed to save the Dizzy experiment.');

  return (
    <Section icon={RefreshCw} title="Dizzy">
      <div className="flex gap-3">
        <Switch
          aria-label="Toggle Dizzy"
          checked={enabled}
          disabled={isLoading || isUpdating}
          onCheckedChange={setEnabled}
        />
        <p className="text-sm text-muted-foreground">
          Continuously spin the Roomote logo mark in the collapsed sidebar and
          mobile header.
        </p>
      </div>
    </Section>
  );
}
