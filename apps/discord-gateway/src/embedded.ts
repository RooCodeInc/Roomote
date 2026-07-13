import type { Redis } from '@roomote/redis';

import { resolveDiscordGatewayConfig } from './config';
import { DiscordGatewayService } from './service';

export type DiscordGatewaySupervisor = {
  stop: () => Promise<void>;
};

/**
 * Starts the Discord Gateway as an optional subsystem of an existing process.
 * The service remains dormant until Discord credentials are saved, and Redis
 * leader election ensures only one replica maintains a Gateway connection.
 */
export function startDiscordGatewaySupervisor(
  redis: Redis,
  env: NodeJS.ProcessEnv = process.env,
): DiscordGatewaySupervisor {
  const service = new DiscordGatewayService(
    redis,
    resolveDiscordGatewayConfig(env),
  );
  const runPromise = service.run().catch((error) => {
    console.error(
      `[discord-gateway] supervisor stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  return {
    async stop() {
      await service.stop();
      await runPromise;
    },
  };
}
