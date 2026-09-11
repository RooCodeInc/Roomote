import { Env } from '@roomote/env';
import {
  db,
  findSessionEgressCandidateForRun,
  recordTaskRunLifecycleEvent,
} from '@roomote/db/server';
import { createSessionEgressControllerClient } from '@roomote/sdk/server/session-egress';

import {
  resolveSessionEgressProvisioningConfig,
  SessionEgressLifecycle,
} from './lifecycle';

export * from './lifecycle';

/**
 * Production wiring: configuration from the validated env, the typed SDK
 * control-plane client against the API origin the controller already uses,
 * and lifecycle events on the run so the Session sees a nonsecret status.
 */
export function createSessionEgressLifecycle(): SessionEgressLifecycle {
  const config = resolveSessionEgressProvisioningConfig(Env);
  const client = config
    ? createSessionEgressControllerClient({ apiBaseUrl: Env.TRPC_URL })
    : null;

  if (config) {
    console.log(
      `[sessionEgress] Enabled: gateway ${config.gatewayAddr}, connector image ${config.connectorImage}, lease ${config.leaseSeconds}s`,
    );
  } else {
    console.log(
      '[sessionEgress] Disabled: no SESSION_EGRESS_* provisioning configured; runs attached to Sessions with service grants will report no service tokens.',
    );
  }

  return new SessionEgressLifecycle({
    client,
    config,
    findCandidate: findSessionEgressCandidateForRun,
    recordEvent: async (event) => {
      await recordTaskRunLifecycleEvent(db, {
        runId: event.runId,
        taskId: event.taskId,
        eventType: event.eventType,
        message: event.message,
        details: event.details,
      });
    },
  });
}
