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
export * from './api-proxy';

/**
 * Production wiring: configuration from the validated env, the typed SDK
 * control-plane client against the API origin the controller already uses,
 * and lifecycle events on the run so the Session sees a nonsecret status.
 */
export function createSessionEgressLifecycle(): SessionEgressLifecycle {
  const config = resolveSessionEgressProvisioningConfig(Env);
  // API-proxy admission needs only the control plane, so the client always
  // exists; the per-owner experiment decides whether a run gets tokens.
  const client = createSessionEgressControllerClient({
    apiBaseUrl: Env.TRPC_URL,
  });

  console.log(
    config
      ? `[sessionEgress] Connector admission enabled: gateway ${config.gatewayAddr}, connector image ${config.connectorImage}, lease ${config.leaseSeconds}s; API-proxy admission available for connector-less providers.`
      : '[sessionEgress] API-proxy admission available for connector-less providers; no SESSION_EGRESS_* connector provisioning configured.',
  );

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
