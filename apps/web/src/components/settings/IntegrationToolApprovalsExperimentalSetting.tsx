'use client';

import { ShieldQuestion, Switch } from '@/components/system';
import { useIntegrationToolApprovalsExperiment } from '@/hooks/useIntegrationToolApprovalsExperiment';

import { IntegrationToolAutoModeSetting } from './IntegrationToolAutoModeSetting';
import { Section } from './Section';

/**
 * Experiment-gated (`integrationToolApprovals`) admin switch. The per-tool
 * approval modes themselves are configured per integration from the Manage
 * tools dialog in Settings → Integrations while this experiment is on.
 */
export function IntegrationToolApprovalsExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } =
    useIntegrationToolApprovalsExperiment();

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
          sessions and tasks. While enabled, each integration&apos;s Manage
          tools dialog in Settings → Integrations offers Auto (default), Always
          allow, Ask first, and Reject per tool. Ask first pauses each call
          until the session owner allows it once, stops the asks for the rest of
          that session, or rejects it; Reject blocks it outright. Automatic
          approvals let a decision model assess each call to a tool left on
          Auto, run routine ones, and ask a person about risky ones. A task asks
          the owner of its session the same way, and a task nobody can answer
          for, such as one an automation started, cannot run an Ask first tool.
          Session owners can also ask to be asked about any tool from its call
          in the transcript. Tools left at the default run exactly as before.
          Policies are deployment-wide and apply from the next session turn.
        </p>
      </div>
      {enabled ? <IntegrationToolAutoModeSetting /> : null}
    </Section>
  );
}
