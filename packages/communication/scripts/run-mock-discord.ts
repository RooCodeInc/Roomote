#!/usr/bin/env npx tsx

import { readFile } from 'node:fs/promises';

import { Env } from '@roomote/env';
import { z } from 'zod';

import {
  MockDiscordServer,
  type MockDiscordReplayEvent,
  type MockDiscordRoomoteTarget,
} from '../src/mock-discord-server';

const channelSchema = z
  .object({
    id: z.string().min(1),
    guild_id: z.string().optional(),
    parent_id: z.string().nullable().optional(),
    name: z.string().min(1),
    type: z.number().int(),
    position: z.number().int().optional(),
    flags: z.number().int().optional(),
  })
  .passthrough();

const configSchema = z.object({
  port: z.number().int().positive().optional(),
  roomoteTarget: z
    .object({
      eventsUrl: z.string().url(),
      gatewaySecret: z.string().min(1).optional(),
    })
    .optional(),
  state: z
    .object({
      botToken: z.string().min(1).optional(),
      bot: z
        .object({
          id: z.string().min(1),
          username: z.string().min(1),
          globalName: z.string().nullable().optional(),
        })
        .optional(),
      application: z
        .object({ id: z.string().min(1), name: z.string().min(1) })
        .optional(),
      guildId: z.string().min(1).optional(),
      channels: z.array(channelSchema).optional(),
    })
    .optional(),
  replay: z
    .array(
      z.object({
        kind: z.enum(['message', 'interaction']),
        payload: z.record(z.unknown()),
        eventId: z.string().min(1).optional(),
      }),
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
): MockDiscordRoomoteTarget | undefined {
  if (!roomoteTarget) {
    return undefined;
  }

  const secretSource = roomoteTarget.gatewaySecret
    ? 'config'
    : process.env.R_DISCORD_GATEWAY_SECRET?.trim()
      ? 'Env.R_DISCORD_GATEWAY_SECRET'
      : Env.APP_ENV === 'development' || process.env.NODE_ENV === 'development'
        ? 'Env.ENCRYPTION_KEY'
        : 'missing';
  const gatewaySecret =
    roomoteTarget.gatewaySecret ??
    process.env.R_DISCORD_GATEWAY_SECRET?.trim() ??
    (Env.APP_ENV === 'development' || process.env.NODE_ENV === 'development'
      ? Env.ENCRYPTION_KEY
      : undefined) ??
    '';

  console.info(`Using Discord gateway secret from ${secretSource}.`);

  return {
    eventsUrl: roomoteTarget.eventsUrl,
    gatewaySecret,
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
        return { statePath, port, exitAfterReplay };
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
  pnpm --filter @roomote/communication mock:discord --state scripts/mock-discord.example.json
  pnpm --filter @roomote/communication mock:discord --state scripts/mock-discord.example.json --port 3014 --exit-after-replay
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rawConfig = await readFile(options.statePath, 'utf8');
  const config = configSchema.parse(JSON.parse(rawConfig)) as HarnessConfig;
  const roomoteTarget = resolveRoomoteTarget(config.roomoteTarget);

  const server = new MockDiscordServer({
    ...(config.state?.botToken ? { botToken: config.state.botToken } : {}),
    ...(config.state?.bot ? { bot: config.state.bot } : {}),
    ...(config.state?.application
      ? { application: config.state.application }
      : {}),
    ...(config.state?.guildId ? { guildId: config.state.guildId } : {}),
    ...(roomoteTarget ? { roomoteTarget } : {}),
  });

  for (const channel of config.state?.channels ?? []) {
    server.addChannel(channel);
  }

  const { baseUrl } = await server.listen(options.port ?? config.port ?? 0);

  console.info(`Mock Discord REST API listening at ${baseUrl}`);
  console.info(
    `Set DISCORD_API_BASE_URL=${baseUrl} in the Roomote services you want to point at the harness.`,
  );

  if (config.replay?.length) {
    for (const [index, event] of config.replay.entries()) {
      const result = await server.dispatch(event as MockDiscordReplayEvent);
      console.info(
        `Replayed ${event.kind} ${index + 1}/${config.replay.length}: ${result.status} ${result.body}`,
      );
    }
  }

  if (options.exitAfterReplay) {
    await server.close();
    return;
  }

  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await server.close();
    process.exit(0);
  });

  await new Promise(() => undefined);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
