'use client';

import { ShieldQuestion, Switch } from '@/components/system';
import { useIntegrationToolAutoApprovalsExperiment } from '@/hooks/useIntegrationToolAutoApprovalsExperiment';

import { Section } from './Section';

/** Customer-facing copy, written with the product's voice. */
const COPY = {
  title: 'Auto tool approvals',
  toggle: 'Toggle Auto tool approvals',
  description:
    'Show the Auto-approval decisions card in Settings → Agent Guidance, where admins can turn it on. When on, Roomote runs routine calls to tools without a saved choice, asks the session owner about risky ones, and blocks those calls if the owner is away. Per-tool choices and session-specific requests still take priority.',
};

/**
 * Admin switch for the Auto tool approvals experiment. Per-tool approvals
 * (Always allow, Always ask, Disable) are not experimental; this only adds
 * Auto, configured from Settings → Agent Guidance while it is on.
 */
export function IntegrationToolAutoApprovalsExperimentalSetting() {
  const { enabled, isLoading, isUpdating, setEnabled } =
    useIntegrationToolAutoApprovalsExperiment();

  return (
    <Section icon={ShieldQuestion} title={COPY.title}>
      <div className="flex gap-3">
        <Switch
          aria-label={COPY.toggle}
          checked={enabled}
          disabled={isLoading || isUpdating}
          onCheckedChange={setEnabled}
        />
        <p className="text-sm text-muted-foreground">{COPY.description}</p>
      </div>
    </Section>
  );
}
