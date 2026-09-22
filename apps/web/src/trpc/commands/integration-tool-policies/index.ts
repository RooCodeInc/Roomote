import { TRPCError } from '@trpc/server';

import {
  isDeploymentExperimentEnabled,
  listIntegrationToolPolicies,
  listIntegrationToolUserPolicies,
  upsertIntegrationToolPolicy,
  upsertIntegrationToolUserPolicy,
} from '@roomote/db/server';
import {
  isInternalMcpServer,
  type IntegrationToolPolicyUpsert,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

import { assertAdmin } from '../setup/shared';

/**
 * Internal MCPs (Roomote's own server, the HTTP integrations broker, Brain
 * memory) are excluded from approval control; reject attempts to configure
 * them and hide any previously stored rows for them.
 */
function assertApprovalManagedIntegrationId(integrationId: string) {
  if (isInternalMcpServer(integrationId)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `${integrationId} is a Roomote-internal MCP server and is outside approval control.`,
    });
  }
}

/**
 * Experiment-gated (`integrationToolApprovals`) per-tool approval policies.
 * Deployment-scoped and admin-managed: every session on the deployment runs
 * under these modes while the experiment is enabled.
 */
export async function listIntegrationToolPoliciesCommand(
  auth: UserAuthSuccess,
) {
  assertAdmin(auth);
  return (await listIntegrationToolPolicies()).filter(
    (policy) => !isInternalMcpServer(policy.integrationId),
  );
}

export async function setIntegrationToolPolicyCommand(
  auth: UserAuthSuccess,
  input: IntegrationToolPolicyUpsert,
) {
  assertAdmin(auth);
  assertApprovalManagedIntegrationId(input.integrationId);
  await upsertIntegrationToolPolicy({
    ...input,
    updatedByUserId: auth.userId,
  });
  return listIntegrationToolPoliciesCommand(auth);
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
  return (await listIntegrationToolUserPolicies(auth.userId)).filter(
    (policy) => !isInternalMcpServer(policy.integrationId),
  );
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
  assertApprovalManagedIntegrationId(input.integrationId);
  await upsertIntegrationToolUserPolicy({ ...input, userId: auth.userId });
  return (await listIntegrationToolUserPolicies(auth.userId)).filter(
    (policy) => !isInternalMcpServer(policy.integrationId),
  );
}
