'use client';

import { Sparkles } from '@/components/system';
import { useIntegrationToolApprovalsExperiment } from '@/hooks/useIntegrationToolApprovalsExperiment';

import { IntegrationToolAutoModeSetting } from './IntegrationToolAutoModeSetting';
import { Section } from './Section';

/**
 * Auto mode on the Integrations page, next to the per-tool choices it acts
 * on. Present only while the `integrationToolApprovals` experiment is on.
 */
export function IntegrationToolAutoModeSection() {
  const { enabled } = useIntegrationToolApprovalsExperiment();
  if (!enabled) return null;
  return (
    <Section icon={Sparkles} title="Auto mode">
      <IntegrationToolAutoModeSetting />
    </Section>
  );
}
