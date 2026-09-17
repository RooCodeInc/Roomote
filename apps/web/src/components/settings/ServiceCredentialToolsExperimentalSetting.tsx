'use client';

import { KeyRound, Switch } from '@/components/system';
import { useServiceCredentialTools } from '@/hooks/useServiceCredentialTools';

import { Section } from './Section';

export function ServiceCredentialToolsExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } =
    useServiceCredentialTools();

  return (
    <Section icon={KeyRound} title="Integration keys">
      <div className="flex gap-3">
        <Switch
          aria-label="Toggle integration keys"
          checked={enabled}
          disabled={isLoading || isUpdating}
          onCheckedChange={setEnabled}
        />
        <p className="text-sm text-muted-foreground">
          Let agents request and use integration keys approved in a Session.
        </p>
      </div>
    </Section>
  );
}
