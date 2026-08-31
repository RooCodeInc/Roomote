#!/usr/bin/env npx tsx

import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import {
  MockAgentMailServer,
  type MockAgentMailReplayEvent,
  type MockAgentMailState,
} from '../src/mock-agentmail-server';

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

const configSchema = z.object({
  port: z.number().int().positive().optional(),
  state: z.object({
    acceptedApiKeys: z.array(z.string().min(1)).optional(),
    inboxes: z.array(
      z
        .object({
          inbox_id: z.string().min(1),
          display_name: z.string().optional(),
          client_id: z.string().optional(),
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
            event_types: z.array(z.string().min(1)).optional(),
            enabled: z.boolean().optional(),
          })
          .passthrough(),
      )
      .optional(),
    messages: z.array(z.record(z.unknown())).optional(),
  }),
  replay: z
    .array(
      z.union([
        z.object({
          kind: z.literal('redeliver'),
          eventId: z.string().min(1),
        }),
        inboundEmailSchema,
      ]),
    )
    .optional(),
});

type HarnessConfig = z.infer<typeof configSchema>;

type ParsedOptions = {
  statePath: string;
  port?: number;
  exitAfterReplay: boolean;
};

function parseArgs(argv: string[]): ParsedOptions {
  const args = [...argv];
  let statePath = '';
  let port: number | undefined;
  let exitAfterReplay = false;

  while (args.length > 0) {
    const current = args.shift();

    switch (current) {
      case '--state': {
        statePath = args.shift() ?? '';
        break;
      }
      case '--port': {
        const rawPort = args.shift();
        port = rawPort ? Number.parseInt(rawPort, 10) : undefined;
        break;
      }
      case '--exit-after-replay': {
        exitAfterReplay = true;
        break;
      }
      case '--help': {
        printHelp();
        process.exit(0);
        return {
          statePath,
          port,
          exitAfterReplay,
        };
      }
      default: {
        throw new Error(`Unknown argument: ${current}`);
      }
    }
  }

  if (!statePath) {
    throw new Error('Missing required --state <path> argument.');
  }

  if (typeof port === 'number' && (!Number.isInteger(port) || port <= 0)) {
    throw new Error(`Invalid --port value: ${port}`);
  }

  return { statePath, port, exitAfterReplay };
}

function printHelp(): void {
  console.info(`Usage:
  pnpm --filter @roomote/communication mock:agentmail --state scripts/mock-agentmail.example.json
  pnpm --filter @roomote/communication mock:agentmail --state scripts/mock-agentmail.example.json --port 3015 --exit-after-replay
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rawConfig = await readFile(options.statePath, 'utf8');
  const config = configSchema.parse(JSON.parse(rawConfig)) as HarnessConfig;

  const server = new MockAgentMailServer({
    state: config.state as MockAgentMailState,
  });

  const baseUrl = await server.start(options.port ?? config.port ?? 0);

  console.info(`Mock AgentMail API listening at ${baseUrl}`);
  console.info(
    `Set AGENTMAIL_API_BASE_URL=${baseUrl} in the Roomote services you want to point at the harness.`,
  );

  for (const webhook of server.getState().webhooks ?? []) {
    console.info(
      `Seeded webhook ${webhook.webhook_id} → ${webhook.url} (secret ${webhook.secret})`,
    );
  }

  if (config.replay?.length) {
    for (const [index, event] of config.replay.entries()) {
      const result = await server.dispatch(event as MockAgentMailReplayEvent);
      const statuses =
        result.deliveries
          .map((delivery) => `${delivery.url} ${delivery.status}`)
          .join(', ') || 'no matching webhooks';
      console.info(
        `Replayed ${result.eventId} ${index + 1}/${config.replay.length}: ${statuses}`,
      );
    }
  }

  if (options.exitAfterReplay) {
    await server.stop();
    return;
  }

  process.on('SIGINT', async () => {
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await server.stop();
    process.exit(0);
  });

  await new Promise(() => undefined);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
