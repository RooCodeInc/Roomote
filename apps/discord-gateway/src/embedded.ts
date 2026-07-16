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
  options: {
    /**
     * Invoked when the supervisor itself dies. Without it the only signal is
     * a console line while the host process stays green and Discord
     * ingestion is silently stopped — hosts should report this to their
     * error tracker.
     */
    onFatal?: (error: unknown) => void;
  } = {},
): DiscordGatewaySupervisor {
  const service = new DiscordGatewayService(
    redis,
    resolveDiscordGatewayConfig(env),
  );
  const runPromise = service.run().catch((error) => {
    console.error(
      `[discord-gateway] supervisor stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
    );
    void service.status
      .update({
        phase: 'error',
        ready: false,
        connected: false,
        lastError: `Discord gateway supervisor stopped: ${error instanceof Error ? error.message : String(error)}`,
      })
      .catch(() => undefined);
    options.onFatal?.(error);
  });

  return {
    async stop() {
      await service.stop();
      await runPromise;
    },
  };
}
