import { TRPCError } from '@trpc/server';

import {
  isDeploymentExperimentEnabled,
  listIntegrationToolPolicies,
  listIntegrationToolUserPolicies,
  upsertIntegrationToolPolicy,
  upsertIntegrationToolUserPolicy,
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

const toolApprovalsEnabled = () =>
  isDeploymentExperimentEnabled('integrationToolApprovals');

/**
 * The caller's personal policies for their own Sessions. They layer on the
 * deployment policies and only ever tighten them. Inert while the experiment
 * is off.
 */
export async function listPersonalIntegrationToolPoliciesCommand(
  auth: UserAuthSuccess,
) {
  if (!(await toolApprovalsEnabled())) return [];
  return listIntegrationToolUserPolicies(auth.userId);
}

export async function setPersonalIntegrationToolPolicyCommand(
  auth: UserAuthSuccess,
  input: IntegrationToolPolicyUpsert,
) {
  if (!(await toolApprovalsEnabled())) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Tool approvals are not enabled.',
    });
  }
  await upsertIntegrationToolUserPolicy({ ...input, userId: auth.userId });
  return listIntegrationToolUserPolicies(auth.userId);
}
