import { getRedis } from '@roomote/redis';

import { resolveDiscordGatewayConfig } from './config';
import { DiscordGatewayService } from './service';
import { startHealthServer } from './status';

const config = resolveDiscordGatewayConfig();
const redis = getRedis();
const service = new DiscordGatewayService(redis, config);
const healthServer = startHealthServer(config.port, () => service.status.get());
let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  console.info(`[discord-gateway] ${signal} received; shutting down`);
  healthServer.close();
  await service.stop();
  // run() releases the leader lease in its finally block; quitting Redis
  // before that unwind finishes would strand the lease until its TTL and
  // block failover for up to leaderLeaseTtlSeconds. The rejection (if any)
  // was already logged by the run().catch handler below.
  await runPromise.catch(() => undefined);
  await redis.quit();
}

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

console.info(
  `[discord-gateway] health server listening on 0.0.0.0:${config.port}`,
);

const runPromise = service.run();
runPromise.catch(async (error) => {
  console.error(
    `[discord-gateway] fatal error: ${error instanceof Error ? error.message : String(error)}`,
  );
  await shutdown('startup_failure');
  process.exitCode = 1;
});
