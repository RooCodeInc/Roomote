import {
  listIntegrationToolPolicies,
  upsertIntegrationToolPolicy,
} from '@roomote/db/server';
import type { IntegrationToolPolicyUpsert } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

import { assertAdmin } from '../setup/shared';

/**
 * Experiment-gated (`integrationToolApprovals`) per-tool approval policies.
 * Deployment-scoped and admin-managed: every session on the deployment runs
 * under these modes while the experiment is enabled.
 */
export async function listIntegrationToolPoliciesCommand(
  auth: UserAuthSuccess,
) {
  assertAdmin(auth);
  return listIntegrationToolPolicies();
}

export async function setIntegrationToolPolicyCommand(
  auth: UserAuthSuccess,
  input: IntegrationToolPolicyUpsert,
) {
  assertAdmin(auth);
  await upsertIntegrationToolPolicy({
    ...input,
    updatedByUserId: auth.userId,
  });
  return listIntegrationToolPolicies();
}
