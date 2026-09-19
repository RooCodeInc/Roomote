'use client';

import { Code2, Switch } from '@/components/system';
import { useCodeModeIntegrationsExperiment } from '@/hooks/useCodeModeIntegrationsExperiment';

import { Section } from './Section';

export function CodeModeIntegrationsExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } =
    useCodeModeIntegrationsExperiment();

  return (
    <Section icon={Code2} title="Code Mode Integrations">
      <div className="flex gap-3">
        <Switch
          aria-label="Toggle Code Mode Integrations"
          checked={enabled}
          disabled={isLoading || isUpdating}
          onCheckedChange={setEnabled}
        />
        <p className="text-sm text-muted-foreground">
          Let Sessions reach each connected integration tool individually
          through OpenCode code mode — a confined script runner with its own
          tool search — instead of the on-demand find/call dispatcher.
          Authorization and visibility rules are unchanged.
        </p>
      </div>
    </Section>
  );
}
