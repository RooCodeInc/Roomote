import { TRPCError } from '@trpc/server';

import {
  getIntegrationToolAutoForSession,
  isDeploymentExperimentEnabled,
  setIntegrationToolAutoForSession,
} from '@roomote/db/server';
import { AUTO_DECISION_REQUIREMENTS } from '@roomote/cloud-agents/server/integration-tool-auto-evaluation';
import { resolveDecisionModel } from '@roomote/cloud-agents/server/typesafe-judgment';

import type { UserAuthSuccess } from '@/types';

type FastSessionAutoToolApprovals = {
  /** Whether Auto can be turned on: the experiment and a model to assess with. */
  available: boolean;
  enabled: boolean;
  /** Auto stopped because a call could not be assessed; turning it on again resumes it. */
  suspended: boolean;
};

/** Whether this deployment offers Auto tool approvals to this user at all. */
export async function isAutoToolApprovalsExperimentEnabled(
  auth: UserAuthSuccess,
): Promise<boolean> {
  return (
    auth.nightlyExperimentsEnabled === true &&
    (await isDeploymentExperimentEnabled('integrationToolAutoApprovals'))
  );
}

/**
 * Whether Auto has something to assess calls with. Auto needs a hosted
 * judgment model; the helper-model fallback would be an LLM call per tool
 * call, so it is never used.
 */
export async function canAssessAutoToolApprovals(): Promise<boolean> {
  const model = await resolveDecisionModel(AUTO_DECISION_REQUIREMENTS).catch(
    () => null,
  );
  return model?.kind === 'judgment';
}

/**
 * Auto for one session, as its owner sees it under the composer. Without a
 * session it answers for one about to start, where Auto is always off.
 */
export async function getFastSessionAutoToolApprovalsCommand(
  auth: UserAuthSuccess,
  input: { sessionId?: string },
): Promise<FastSessionAutoToolApprovals> {
  if (!(await isAutoToolApprovalsExperimentEnabled(auth))) {
    return { available: false, enabled: false, suspended: false };
  }
  const [available, state] = await Promise.all([
    canAssessAutoToolApprovals(),
    input.sessionId
      ? getIntegrationToolAutoForSession({
          sessionId: input.sessionId,
          userId: auth.userId,
        })
      : Promise.resolve({ enabled: false, suspended: false }),
  ]);
  if (!state) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
  }
  return { available, ...state };
}

/** Turn Auto on or off for one session. Only its owner can. */
export async function setFastSessionAutoToolApprovalsCommand(
  auth: UserAuthSuccess,
  input: { sessionId: string; enabled: boolean },
): Promise<FastSessionAutoToolApprovals> {
  if (!(await isAutoToolApprovalsExperimentEnabled(auth))) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Auto tool approvals are not enabled.',
    });
  }
  // Turning it off always works, so a session is never stuck with Auto on.
  if (input.enabled && !(await canAssessAutoToolApprovals())) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Auto isn’t available yet.',
    });
  }
  const changed = await setIntegrationToolAutoForSession({
    sessionId: input.sessionId,
    userId: auth.userId,
    enabled: input.enabled,
  });
  if (!changed) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
  }
  return getFastSessionAutoToolApprovalsCommand(auth, {
    sessionId: input.sessionId,
  });
}
