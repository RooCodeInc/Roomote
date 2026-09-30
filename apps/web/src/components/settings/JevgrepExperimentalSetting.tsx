'use client';

import { Search, Switch } from '@/components/system';
import { useDeploymentExperiment } from '@/hooks/useDeploymentExperiments';
import { Section } from './Section';

export function JevgrepExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } =
    useDeploymentExperiment('jevgrep', 'Failed to update Jevgrep.');

  return (
    <Section icon={Search} title="Jevgrep code search">
      <div className="flex gap-3">
        <Switch
          aria-label="Toggle Jevgrep code search"
          checked={enabled}
          disabled={isLoading || isUpdating}
          onCheckedChange={setEnabled}
        />
        <p className="text-sm text-muted-foreground">
          Let coding tasks find relevant code with Jevgrep. Requires Jev under
          Settings → Models and takes effect on the next task run. Searches send
          selected source to that provider. Ordinary code search remains
          available if Jevgrep fails.
        </p>
      </div>
    </Section>
  );
}
