import { Env } from '@roomote/env';
import {
  db,
  findSessionEgressCandidateForRun,
  recordTaskRunLifecycleEvent,
} from '@roomote/db/server';
import { createSessionEgressControllerClient } from '@roomote/sdk/server/session-egress';

import { resolveSessionEgressApiProxyBaseUrl } from './api-proxy';
import { SessionEgressLifecycle } from './lifecycle';

export * from './lifecycle';
export * from './api-proxy';

/**
 * Production wiring: the typed SDK control-plane client against the API
 * origin the controller already uses, the proxy base URL sandboxes call, and
 * lifecycle events on the run so the Session sees a nonsecret status. No
 * deployment configuration exists; the per-owner experiment decides whether
 * a run gets tokens.
 */
export function createSessionEgressLifecycle(): SessionEgressLifecycle {
  return new SessionEgressLifecycle({
    client: createSessionEgressControllerClient({ apiBaseUrl: Env.TRPC_URL }),
    apiProxyBaseUrl: resolveSessionEgressApiProxyBaseUrl(Env),
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
