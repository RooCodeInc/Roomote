'use client';

import { ShieldQuestion, Switch } from '@/components/system';
import { useDeploymentExperiment } from '@/hooks/useDeploymentExperiments';

import { Section } from './Section';

export function IntegrationToolAutoApprovalsNightlySetting() {
  const { enabled, isLoading, isUpdating, setEnabled } =
    useDeploymentExperiment(
      'integrationToolAutoApprovals',
      'Failed to update Auto tool approvals.',
    );

  return (
    <Section icon={ShieldQuestion} title="Auto tool approvals">
      <div className="flex gap-3">
        <Switch
          aria-label="Toggle Auto tool approvals"
          checked={enabled}
          disabled={isLoading || isUpdating}
          onCheckedChange={setEnabled}
        />
        <p className="text-sm text-muted-foreground">
          Expose the Auto-approval decisions card in Settings → Agent Guidance.
          Jev is required for Auto to make decisions, and saved per-tool choices
          continue to take priority.
        </p>
      </div>
    </Section>
  );
}
