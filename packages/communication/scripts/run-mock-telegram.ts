#!/usr/bin/env npx tsx

import { readFile } from 'node:fs/promises';

import { Env } from '@roomote/env';
import { z } from 'zod';

import {
  MockTelegramServer,
  type MockTelegramReplayEvent,
  type MockTelegramRoomoteTarget,
  type MockTelegramState,
} from '../src/mock-telegram-server';

const inboundMessageSchema = z
  .object({
    chat: z
      .object({
        id: z.union([z.number(), z.string()]),
        type: z.string(),
      })
      .passthrough(),
    from: z.object({ id: z.number() }).passthrough().optional(),
    text: z.string().optional(),
    message_id: z.number().int().optional(),
    message_thread_id: z.number().int().optional(),
    date: z.number().int().optional(),
    entities: z.array(z.record(z.unknown())).optional(),
  })
  .passthrough();

const configSchema = z.object({
  port: z.number().int().positive().optional(),
  roomoteTarget: z
    .object({
      webhookUrl: z.string().url(),
      secretToken: z.string().min(1).optional(),
    })
    .optional(),
  state: z.object({
    bot: z
      .object({
        id: z.number().int(),
        username: z.string().min(1),
        first_name: z.string().min(1),
      })
      .optional(),
    acceptedBotTokens: z.array(z.string().min(1)).optional(),
    chats: z.array(
      z
        .object({
          id: z.number(),
          type: z.enum(['private', 'group', 'supergroup', 'channel']),
          title: z.string().optional(),
          username: z.string().optional(),
          first_name: z.string().optional(),
          is_forum: z.boolean().optional(),
        })
        .passthrough(),
    ),
    users: z.array(
      z
        .object({
          id: z.number(),
          is_bot: z.boolean().optional(),
          first_name: z.string().optional(),
          last_name: z.string().optional(),
          username: z.string().optional(),
        })
        .passthrough(),
    ),
    messages: z.array(z.record(z.unknown())).optional(),
    behavior: z
      .object({
        rejectHtmlParseMode: z.boolean().optional(),
        rejectPhotos: z.boolean().optional(),
      })
      .optional(),
  }),
  replay: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('message'),
          updateId: z.number().int().optional(),
          message: inboundMessageSchema,
        }),
        z.object({
          kind: z.literal('edited_message'),
          updateId: z.number().int().optional(),
          message: inboundMessageSchema,
        }),
        z.object({
          kind: z.literal('callback_query'),
          updateId: z.number().int().optional(),
          callbackQuery: z
            .object({
              id: z.string().min(1),
              from: z.object({ id: z.number() }).passthrough(),
              data: z.string().optional(),
              message: z.record(z.unknown()).optional(),
            })
            .passthrough(),
        }),
        z.object({
          kind: z.literal('update'),
          update: z.record(z.unknown()),
        }),
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

function resolveRoomoteTarget(
  roomoteTarget: HarnessConfig['roomoteTarget'],
): MockTelegramRoomoteTarget | undefined {
  if (!roomoteTarget) {
    return undefined;
  }

  const secretSource = roomoteTarget.secretToken
    ? 'config'
    : 'Env.R_TELEGRAM_WEBHOOK_SECRET';
  const secretToken =
    roomoteTarget.secretToken ?? Env.R_TELEGRAM_WEBHOOK_SECRET ?? '';

  console.info(`Using Telegram webhook secret from ${secretSource}.`);

  return {
    webhookUrl: roomoteTarget.webhookUrl,
    secretToken,
  };
}

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
  pnpm --filter @roomote/communication mock:telegram --state scripts/mock-telegram.example.json
  pnpm --filter @roomote/communication mock:telegram --state scripts/mock-telegram.example.json --port 3013 --exit-after-replay
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rawConfig = await readFile(options.statePath, 'utf8');
  const config = configSchema.parse(JSON.parse(rawConfig)) as HarnessConfig;
  const roomoteTarget = resolveRoomoteTarget(config.roomoteTarget);

  const server = new MockTelegramServer({
    state: config.state as MockTelegramState,
    ...(roomoteTarget ? { roomoteTarget } : {}),
  });

  const baseUrl = await server.start(options.port ?? config.port ?? 0);

  console.info(`Mock Telegram Bot API listening at ${baseUrl}`);
  console.info(
    `Set TELEGRAM_API_BASE_URL=${baseUrl} in the Roomote services you want to point at the harness.`,
  );

  if (config.replay?.length) {
    for (const [index, event] of config.replay.entries()) {
      const result = await server.dispatch(event as MockTelegramReplayEvent);
      console.info(
        `Replayed ${event.kind} ${index + 1}/${config.replay.length}: ${result.status} ${result.body}`,
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
