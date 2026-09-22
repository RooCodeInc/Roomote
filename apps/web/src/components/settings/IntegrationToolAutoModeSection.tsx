'use client';

import { Sparkles } from '@/components/system';
import { useIntegrationToolApprovalsExperiment } from '@/hooks/useIntegrationToolApprovalsExperiment';
import { useAuthorizedUser } from '@/hooks/useUser';

import { IntegrationToolAutoModeSetting } from './IntegrationToolAutoModeSetting';
import { Section } from './Section';

/**
 * Auto mode on the Integrations page, next to the per-tool choices it acts
 * on. A deployment-wide, admin-only setting, so it is present only for an
 * admin while the `integrationToolApprovals` experiment is on.
 */
export function IntegrationToolAutoModeSection() {
  const { isAdmin } = useAuthorizedUser();
  const { enabled } = useIntegrationToolApprovalsExperiment();
  if (!isAdmin || !enabled) return null;
  return (
    <Section icon={Sparkles} title="Auto mode">
      <IntegrationToolAutoModeSetting />
    </Section>
  );
}
