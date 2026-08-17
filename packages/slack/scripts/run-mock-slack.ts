#!/usr/bin/env npx tsx

import { readFile } from 'node:fs/promises';

import { Env } from '@roomote/env';
import { z } from 'zod';

import {
  MockSlackServer,
  type MockSlackReplayEvent,
  type MockSlackRoomoteTarget,
  type MockSlackState,
} from '../src/mock-slack-server';

const configSchema = z.object({
  port: z.number().int().positive().optional(),
  roomoteTarget: z
    .object({
      webhookUrl: z.string().url(),
      signingSecret: z.string().min(1).optional(),
    })
    .optional(),
  state: z.object({
    team: z.object({
      id: z.string().min(1),
      domain: z.string().min(1),
      timezone: z.string().optional(),
    }),
    acceptedBotTokens: z.array(z.string().min(1)).optional(),
    botUserId: z.string().min(1).optional(),
    channels: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        type: z.enum(['public_channel', 'private_channel', 'im']).optional(),
        isMember: z.boolean().optional(),
        members: z.array(z.string().min(1)).optional(),
      }),
    ),
    users: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        displayName: z.string().optional(),
        realName: z.string().optional(),
        email: z.string().email().optional(),
      }),
    ),
    messages: z
      .array(
        z.object({
          channel: z.string().min(1),
          ts: z.string().min(1),
          text: z.string(),
          thread_ts: z.string().optional(),
          user: z.string().min(1),
          username: z.string().optional(),
          bot_id: z.string().optional(),
          type: z.string().min(1),
          blocks: z.array(z.unknown()).optional(),
          attachments: z.array(z.unknown()).optional(),
          ephemeral: z.boolean().optional(),
          reactions: z.array(z.string()).optional(),
          chunks: z.array(z.unknown()).optional(),
          streaming_state: z.enum(['in_progress', 'completed']).optional(),
        }),
      )
      .optional(),
    assistantThreadStatuses: z
      .array(
        z.object({
          channel: z.string().min(1),
          threadTs: z.string().min(1),
          status: z.string(),
        }),
      )
      .optional(),
    streamEvents: z
      .array(
        z.object({
          method: z.enum(['start', 'append', 'stop']),
          channel: z.string().min(1),
          messageTs: z.string().min(1),
          threadTs: z.string().optional(),
          chunks: z.array(z.unknown()),
        }),
      )
      .optional(),
  }),
  replay: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('event_callback'),
          eventId: z.string().min(1),
          teamId: z.string().optional(),
          event: z.object({
            type: z.string().min(1),
            subtype: z.string().optional(),
            channel: z.string().min(1),
            user: z.string().min(1),
            text: z.string(),
            ts: z.string().min(1),
            thread_ts: z.string().optional(),
            bot_id: z.string().optional(),
            app_id: z.string().optional(),
            files: z.array(z.unknown()).optional(),
            processedImages: z.array(z.string()).optional(),
            channel_type: z.string().optional(),
          }),
        }),
        z.object({
          kind: z.literal('interactive'),
          payload: z.unknown(),
        }),
        z.object({
          kind: z.literal('url_verification'),
          challenge: z.string().min(1),
          teamId: z.string().optional(),
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
): MockSlackRoomoteTarget | undefined {
  if (!roomoteTarget) {
    return undefined;
  }

  const signingSecretSource = roomoteTarget.signingSecret
    ? 'config'
    : 'Env.R_SLACK_SIGNING_SECRET';
  const signingSecret =
    roomoteTarget.signingSecret ?? Env.R_SLACK_SIGNING_SECRET;

  console.info(`Using Roomote signing secret from ${signingSecretSource}.`);

  return {
    webhookUrl: roomoteTarget.webhookUrl,
    signingSecret,
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
  pnpm --filter @roomote/slack mock:server --state scripts/mock-slack.example.json
  pnpm --filter @roomote/slack mock:server --state scripts/mock-slack.example.json --port 3012 --exit-after-replay
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rawConfig = await readFile(options.statePath, 'utf8');
  const config = configSchema.parse(JSON.parse(rawConfig)) as HarnessConfig;
  const roomoteTarget = resolveRoomoteTarget(config.roomoteTarget);

  const server = new MockSlackServer({
    state: config.state as MockSlackState,
    ...(roomoteTarget ? { roomoteTarget } : {}),
  });

  const baseUrl = await server.start(options.port ?? config.port ?? 0);

  console.info(`Mock Slack API listening at ${baseUrl}`);
  console.info(
    `Set SLACK_API_BASE_URL=${baseUrl}/api/ in the Roomote services you want to point at the harness.`,
  );

  if (config.replay?.length) {
    for (const [index, event] of config.replay.entries()) {
      const result = await server.dispatch(event as MockSlackReplayEvent);
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
