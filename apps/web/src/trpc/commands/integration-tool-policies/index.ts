import { TRPCError } from '@trpc/server';

import {
  getIntegrationToolAutoSettings,
  isDeploymentExperimentEnabled,
  listIntegrationToolPolicies,
  listIntegrationToolUserPolicies,
  setIntegrationToolAutoSettings,
  upsertIntegrationToolPolicy,
  upsertIntegrationToolUserPolicy,
} from '@roomote/db/server';
import { resolveDecisionModel } from '@roomote/cloud-agents/server/typesafe-judgment';
import type {
  IntegrationToolAutoSettings,
  IntegrationToolPolicyUpsert,
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

/**
 * Deployment-wide Auto mode, admin only. `model` names what Auto will
 * consult, so an admin sees the cost of turning it on: the hosted judgment
 * model, or the helper model when none is configured.
 */
export async function getIntegrationToolAutoSettingsCommand(
  auth: UserAuthSuccess,
) {
  assertAdmin(auth);
  const [settings, model] = await Promise.all([
    getIntegrationToolAutoSettings(),
    resolveDecisionModel().catch(() => null),
  ]);
  return {
    ...settings,
    model:
      model === null
        ? null
        : model.kind === 'judgment'
          ? { kind: 'judgment' as const }
          : { kind: 'helper' as const, model: model.model },
  };
}

export async function setIntegrationToolAutoSettingsCommand(
  auth: UserAuthSuccess,
  input: IntegrationToolAutoSettings,
) {
  assertAdmin(auth);
  if (!(await toolApprovalsEnabled())) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Integration tool approvals are not enabled.',
    });
  }
  await setIntegrationToolAutoSettings({
    mode: input.mode,
    policy: input.policy.trim(),
  });
  return getIntegrationToolAutoSettingsCommand(auth);
}
