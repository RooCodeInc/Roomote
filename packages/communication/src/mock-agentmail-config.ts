import { z } from 'zod';

import type {
  MockAgentMailReplayEvent,
  MockAgentMailState,
} from './mock-agentmail-server';

/**
 * Scenario-file schema for the mock AgentMail harness CLI
 * (`scripts/run-mock-agentmail.ts`). Kept next to the server so the file
 * format and the in-process mock cannot drift: every state field the mock
 * understands (pods, pod scoping, delivery-failure replays) must be declared
 * here, or Zod strips it before the server ever sees it.
 */
const inboundEmailSchema = z
  .object({
    kind: z.literal('message').optional(),
    inboxId: z.string().min(1),
    from: z.string().min(1),
    to: z.array(z.string().min(1)).optional(),
    cc: z.array(z.string().min(1)).optional(),
    subject: z.string().optional(),
    text: z.string().optional(),
    html: z.string().optional(),
    threadId: z.string().optional(),
    timestamp: z.string().optional(),
    autoSubmitted: z.boolean().optional(),
    oversize: z.boolean().optional(),
    duplicate: z.boolean().optional(),
  })
  .passthrough();

const deliveryFailureSchema = z
  .object({
    kind: z.enum(['bounce', 'complaint']),
    inboxId: z.string().min(1),
    recipients: z.array(z.string().min(1)),
    messageId: z.string().optional(),
    threadId: z.string().optional(),
    bounceType: z.string().optional(),
    subType: z.string().optional(),
  })
  .passthrough();

const configSchema = z.object({
  port: z.number().int().positive().optional(),
  state: z.object({
    acceptedApiKeys: z.array(z.string().min(1)).optional(),
    // Pods let a scenario exercise the pod-scoped management routes
    // (`/v0/pods/{pod_id}/...`) the app uses under R_AGENTMAIL_POD_ID.
    pods: z
      .array(
        z
          .object({
            pod_id: z.string().min(1),
            name: z.string().optional(),
            client_id: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    inboxes: z.array(
      z
        .object({
          inbox_id: z.string().min(1),
          display_name: z.string().optional(),
          client_id: z.string().optional(),
          pod_id: z.string().min(1).optional(),
        })
        .passthrough(),
    ),
    webhooks: z
      .array(
        z
          .object({
            webhook_id: z.string().min(1),
            url: z.string().url(),
            secret: z.string().min(1).optional(),
            client_id: z.string().optional(),
            inbox_ids: z.array(z.string().min(1)).optional(),
            pod_ids: z.array(z.string().min(1)).optional(),
            event_types: z.array(z.string().min(1)).optional(),
            enabled: z.boolean().optional(),
          })
          .passthrough(),
      )
      .optional(),
    messages: z.array(z.record(z.unknown())).optional(),
    // Seeded events make `kind: "redeliver"` usable from a scenario file:
    // the redelivery reuses the stored svix id and resends the payload.
    events: z
      .array(
        z
          .object({
            event_id: z.string().min(1),
            svix_id: z.string().min(1),
            event_type: z.string().min(1),
            inbox_id: z.string().min(1),
            message_id: z.string().min(1),
            payload: z.string().min(1),
            deliveries: z.array(z.record(z.unknown())).optional(),
          })
          .passthrough(),
      )
      .optional(),
  }),
  replay: z
    .array(
      z.union([
        z.object({
          kind: z.literal('redeliver'),
          eventId: z.string().min(1),
        }),
        deliveryFailureSchema,
        inboundEmailSchema,
      ]),
    )
    .optional(),
});

type MockAgentMailHarnessConfig = {
  port?: number;
  state: MockAgentMailState;
  replay?: MockAgentMailReplayEvent[];
};

export function parseMockAgentMailConfig(
  raw: unknown,
): MockAgentMailHarnessConfig {
  const config = configSchema.parse(raw);
  return {
    ...(config.port !== undefined ? { port: config.port } : {}),
    state: config.state as MockAgentMailState,
    ...(config.replay
      ? { replay: config.replay as MockAgentMailReplayEvent[] }
      : {}),
  };
}
