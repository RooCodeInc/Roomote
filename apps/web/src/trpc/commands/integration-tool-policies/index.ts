import { TRPCError } from '@trpc/server';

import {
  and,
  customMcpServers,
  db,
  deploymentMcpEnablements,
  eq,
  isDeploymentExperimentEnabled,
  listIntegrationToolPolicies,
  listIntegrationToolUserPolicies,
  personalMcpServers,
  upsertIntegrationToolPolicies,
  upsertIntegrationToolPolicy,
  upsertIntegrationToolUserPolicies,
  upsertIntegrationToolUserPolicy,
} from '@roomote/db/server';
import {
  getMcpIntegration,
  type IntegrationToolPoliciesUpsert,
  type IntegrationToolPolicyMode,
  type IntegrationToolPolicyUpsert,
} from '@roomote/types';

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
  await syncLegacyDisabledTool({ ...input, scope: 'deployment' });
  return listIntegrationToolPolicies();
}

export async function setIntegrationToolPoliciesCommand(
  auth: UserAuthSuccess,
  input: IntegrationToolPoliciesUpsert,
) {
  assertAdmin(auth);
  await upsertIntegrationToolPolicies({
    ...input,
    updatedByUserId: auth.userId,
  });
  await syncLegacyDisabledTools({ ...input, scope: 'deployment' });
  return listIntegrationToolPolicies();
}

const toolApprovalsEnabled = () =>
  isDeploymentExperimentEnabled('integrationToolApprovals');

/**
 * Keep pre-policy availability rows compatible while the policy surface rolls
 * them into the `reject`/Disable mode. The columns remain for N-1 rollback;
 * current policy edits are the only user-facing source of truth.
 */
async function syncLegacyDisabledTool(input: {
  integrationId: string;
  toolName: string;
  mode: IntegrationToolPolicyMode;
  scope: 'deployment' | 'personal';
  userId?: string;
}) {
  return syncLegacyDisabledTools({ ...input, toolNames: [input.toolName] });
}

async function syncLegacyDisabledTools(input: {
  integrationId: string;
  toolNames: string[];
  mode: IntegrationToolPolicyMode;
  scope: 'deployment' | 'personal';
  userId?: string;
}) {
  if (input.scope === 'personal') {
    if (!input.userId) return;
    const server = await db.query.personalMcpServers.findFirst({
      where: and(
        eq(personalMcpServers.ownerUserId, input.userId),
        eq(personalMcpServers.name, input.integrationId),
      ),
      columns: { id: true, disabledTools: true },
    });
    if (!server) return;

    const disabledTools = new Set(server.disabledTools ?? []);
    for (const toolName of input.toolNames) {
      if (input.mode === 'reject') disabledTools.add(toolName);
      else disabledTools.delete(toolName);
    }

    await db
      .update(personalMcpServers)
      .set({
        disabledTools:
          disabledTools.size > 0 ? [...disabledTools].sort() : null,
        updatedAt: new Date(),
      })
      .where(eq(personalMcpServers.id, server.id));
    return;
  }

  if (getMcpIntegration(input.integrationId)) {
    const enablement = await db.query.deploymentMcpEnablements.findFirst({
      where: eq(deploymentMcpEnablements.mcpId, input.integrationId),
      columns: { mcpId: true, disabledTools: true },
    });
    if (!enablement) return;

    const disabledTools = new Set(enablement.disabledTools ?? []);
    for (const toolName of input.toolNames) {
      if (input.mode === 'reject') disabledTools.add(toolName);
      else disabledTools.delete(toolName);
    }

    await db
      .update(deploymentMcpEnablements)
      .set({
        disabledTools:
          disabledTools.size > 0 ? [...disabledTools].sort() : null,
        updatedAt: new Date(),
      })
      .where(eq(deploymentMcpEnablements.mcpId, enablement.mcpId));
    return;
  }

  const server = await db.query.customMcpServers.findFirst({
    where: eq(customMcpServers.name, input.integrationId),
    columns: { id: true, disabledTools: true },
  });
  if (!server) return;

  const disabledTools = new Set(server.disabledTools ?? []);
  for (const toolName of input.toolNames) {
    if (input.mode === 'reject') disabledTools.add(toolName);
    else disabledTools.delete(toolName);
  }

  await db
    .update(customMcpServers)
    .set({
      disabledTools: disabledTools.size > 0 ? [...disabledTools].sort() : null,
      updatedAt: new Date(),
    })
    .where(eq(customMcpServers.id, server.id));
}

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
  await syncLegacyDisabledTool({
    ...input,
    scope: 'personal',
    userId: auth.userId,
  });
  return listIntegrationToolUserPolicies(auth.userId);
}

export async function setPersonalIntegrationToolPoliciesCommand(
  auth: UserAuthSuccess,
  input: IntegrationToolPoliciesUpsert,
) {
  if (!(await toolApprovalsEnabled())) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Tool approvals are not enabled.',
    });
  }
  await upsertIntegrationToolUserPolicies({ ...input, userId: auth.userId });
  await syncLegacyDisabledTools({
    ...input,
    scope: 'personal',
    userId: auth.userId,
  });
  return listIntegrationToolUserPolicies(auth.userId);
}
