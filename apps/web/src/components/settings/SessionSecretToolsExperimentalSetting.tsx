'use client';

import { KeyRound, Switch } from '@/components/system';
import { useSessionSecretTools } from '@/hooks/useSessionSecretTools';

import { Section } from './Section';

export function SessionSecretToolsExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } =
    useSessionSecretTools();

  return (
    <Section icon={KeyRound} title="Session secret tools">
      <div className="flex gap-3">
        <Switch
          aria-label="Toggle Session secret tools"
          checked={enabled}
          disabled={isLoading || isUpdating}
          onCheckedChange={setEnabled}
        />
        <p className="text-sm text-muted-foreground">
          Let agents request and use short-lived credentials approved in a
          Session.
        </p>
      </div>
    </Section>
  );
}
