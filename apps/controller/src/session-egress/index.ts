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
  const apiProxyEnabled = Env.R_SESSION_EGRESS_API_PROXY_ENABLED === true;
  const client =
    config || apiProxyEnabled
      ? createSessionEgressControllerClient({ apiBaseUrl: Env.TRPC_URL })
      : null;

  if (config) {
    console.log(
      `[sessionEgress] Connector admission enabled: gateway ${config.gatewayAddr}, connector image ${config.connectorImage}, lease ${config.leaseSeconds}s`,
    );
  }
  if (apiProxyEnabled) {
    console.log(
      '[sessionEgress] API-proxy admission enabled for connector-less compute providers.',
    );
  }
  if (!config && !apiProxyEnabled) {
    console.log(
      '[sessionEgress] Disabled: no SESSION_EGRESS_* provisioning and no R_SESSION_EGRESS_API_PROXY_ENABLED; runs attached to Sessions with service grants will report no service tokens.',
    );
  }

  return new SessionEgressLifecycle({
    client,
    config,
    apiProxyEnabled,
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
