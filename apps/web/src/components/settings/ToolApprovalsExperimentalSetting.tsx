'use client';

import { ShieldQuestion, Switch } from '@/components/system';
import { useToolApprovalsExperiment } from '@/hooks/useToolApprovalsExperiment';

import { Section } from './Section';

export function ToolApprovalsExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } =
    useToolApprovalsExperiment();
  return (
    <Section icon={ShieldQuestion} title="Tool approvals">
      <div className="flex gap-3">
        <Switch
          aria-label="Toggle tool approvals"
          checked={enabled}
          disabled={isLoading || isUpdating}
          onCheckedChange={setEnabled}
        />
        <p className="text-sm text-muted-foreground">
          Ask the Session requester to allow or reject each on-demand
          integration tool call before it runs. Allowing runs that exact call
          once; unanswered requests fail closed.
        </p>
      </div>
    </Section>
  );
}
