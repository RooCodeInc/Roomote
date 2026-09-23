'use client';

import { Sparkles } from '@/components/system';
import { useIntegrationToolAutoApprovalsExperiment } from '@/hooks/useIntegrationToolAutoApprovalsExperiment';
import { useAuthorizedUser } from '@/hooks/useUser';

import { IntegrationToolAutoModeSetting } from './IntegrationToolAutoModeSetting';
import { Section } from './Section';

/**
 * Auto mode on the Agent guidance page. A deployment-wide, admin-only setting,
 * present only while the `integrationToolAutoApprovals` experiment is on.
 */
export function IntegrationToolAutoModeSection() {
  const { isAdmin } = useAuthorizedUser();
  const { enabled } = useIntegrationToolAutoApprovalsExperiment();
  if (!isAdmin || !enabled) return null;
  return (
    <Section icon={Sparkles} title="Auto-approval decisions">
      <IntegrationToolAutoModeSetting />
    </Section>
  );
}
