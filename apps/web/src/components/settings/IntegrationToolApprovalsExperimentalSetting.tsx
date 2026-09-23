'use client';

import { ShieldQuestion, Switch } from '@/components/system';
import { useIntegrationToolApprovalsExperiment } from '@/hooks/useIntegrationToolApprovalsExperiment';

import { Section } from './Section';

/**
 * Experiment-gated (`integrationToolApprovals`) admin switch. The per-tool
 * approval modes themselves are configured per integration from the Manage
 * tools dialog on the Integrations page while this experiment is on.
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
          tools dialog on the Integrations page offers Auto (default, shown with
          no choice selected), Always allow, Always ask, and Disable per tool.
          Set up Auto mode in Settings → Agent Guidance to handle routine work
          automatically and ask before anything risky. If the session owner is
          away, risky calls are blocked. Always ask pauses each call until the
          session owner allows it once, stops the asks for the rest of that
          session, or declines it; Disable hides the tool and blocks it
          outright. A task asks the owner of its session the same way, and a
          task nobody can answer for, such as one an automation started, cannot
          run an Always ask tool. Session owners can also ask to be asked about
          any tool from its call in the transcript. Tools left on Auto with Auto
          mode off run exactly as before. Policies are deployment-wide and apply
          from the next session turn.
        </p>
      </div>
    </Section>
  );
}
