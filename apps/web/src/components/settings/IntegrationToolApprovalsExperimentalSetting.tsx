'use client';

import { ShieldQuestion, Switch } from '@/components/system';
import { useCodeModeIntegrationsExperiment } from '@/hooks/useCodeModeIntegrationsExperiment';
import { useIntegrationToolApprovalsExperiment } from '@/hooks/useIntegrationToolApprovalsExperiment';

import { Section } from './Section';

/**
 * Experiment-gated (`integrationToolApprovals`) admin switch. The per-tool
 * approval modes themselves are configured per integration from the Manage
 * tools dialog in Settings → Integrations while this experiment is on.
 */
export function IntegrationToolApprovalsExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } =
    useIntegrationToolApprovalsExperiment();
  const codeModeIntegrations = useCodeModeIntegrationsExperiment();

  return (
    <Section icon={ShieldQuestion} title="Integration tool approvals">
      <div className="flex gap-3">
        <Switch
          aria-label="Toggle integration tool approvals"
          checked={enabled}
          disabled={isLoading || isUpdating}
          onCheckedChange={setEnabled}
        />
        <p className="text-sm text-muted-foreground">
          Gate individual integration tools behind a requester decision in
          Sessions. Applies on top of Code Mode Integrations: while enabled,
          each integration&apos;s Manage tools dialog in Settings → Integrations
          offers Always allow (default), Ask every time, and Always reject per
          tool. Ask pauses each call until the Session owner allows it once or
          rejects it; Always reject blocks it outright. Tools left at the
          default run exactly as before. Policies are deployment-wide and apply
          from the next session turn.
        </p>
      </div>
      {enabled && !codeModeIntegrations.enabled ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Code Mode Integrations is off, so these policies currently have no
          effect. Enable both experiments to gate integration tools.
        </p>
      ) : null}
    </Section>
  );
}
