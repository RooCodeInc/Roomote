import { Env } from '@roomote/env';
import {
  db,
  findCredentialEgressCandidateForRun,
  recordTaskRunLifecycleEvent,
} from '@roomote/db/server';
import { createCredentialEgressControllerClient } from '@roomote/sdk/server/credential-egress';

import { resolveCredentialEgressApiProxyBaseUrl } from './api-proxy';
import { CredentialEgressLifecycle } from './lifecycle';

export * from './lifecycle';
export * from './api-proxy';
export * from './hosted-launch';

/**
 * Production wiring: the typed SDK control-plane client against the API
 * origin the controller already uses, the proxy base URL sandboxes call, and
 * lifecycle events on the run so the Session sees a nonsecret status. No
 * deployment configuration exists; the per-owner experiment decides whether
 * a run gets tokens.
 */
export function createCredentialEgressLifecycle(): CredentialEgressLifecycle {
  return new CredentialEgressLifecycle({
    client: createCredentialEgressControllerClient({
      apiBaseUrl: Env.TRPC_URL,
    }),
    apiProxyBaseUrl: resolveCredentialEgressApiProxyBaseUrl(Env),
    findCandidate: findCredentialEgressCandidateForRun,
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
