#!/usr/bin/env npx tsx

import { readFile } from 'node:fs/promises';

import { parseMockAgentMailConfig } from '../src/mock-agentmail-config';
import { MockAgentMailServer } from '../src/mock-agentmail-server';

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
  const config = parseMockAgentMailConfig(JSON.parse(rawConfig));

  const server = new MockAgentMailServer({ state: config.state });

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
      const result = await server.dispatch(event);
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
