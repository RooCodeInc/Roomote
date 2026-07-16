import {
  acquireRedisLock,
  type Redis,
  type RedisLockRenewResult,
} from '@roomote/redis';

import { DiscordApiForwarder } from './api-forwarder';
import type { DiscordGatewayConfig } from './config';
import {
  resolveDiscordGatewayCredentials,
  type DiscordGatewayCredentials,
} from './credentials';
import { runSupervisedDeliveryLoop } from './delivery-loop';
import { DiscordGatewaySession } from './gateway-session';
import { DiscordInboundQueue } from './inbound-queue';
import { DiscordLoginBackoff } from './login-backoff';
import { GatewayStatusStore } from './status';

const LEADER_LEASE_KEY = 'discord:gateway:leader';
const sleep = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });

export class DiscordGatewayService {
  readonly status: GatewayStatusStore;
  private stopped = false;
  private readonly stopController = new AbortController();
  private activeSession: DiscordGatewaySession | null = null;
  private activeDeliveryAbort: AbortController | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly config: DiscordGatewayConfig,
  ) {
    this.status = new GatewayStatusStore(redis, config.statusTtlSeconds);
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      let releaseLease: Awaited<ReturnType<typeof acquireRedisLock>> = null;

      try {
        releaseLease = await acquireRedisLock(LEADER_LEASE_KEY, {
          redis: this.redis,
          ttlSeconds: this.config.leaderLeaseTtlSeconds,
        });

        if (!releaseLease) {
          await this.status.update(
            {
              phase: 'standby',
              leader: false,
              ready: false,
              connected: false,
            },
            { publish: false },
          );
          await sleep(this.config.standbyPollMs, this.stopController.signal);
          continue;
        }

        const activeLease = releaseLease;
        await this.runAsLeader(async () =>
          activeLease.renewDetailed(this.config.leaderLeaseTtlSeconds),
        );
      } catch (error) {
        if (!this.stopped) {
          console.error(
            `[discord-gateway] supervisor cycle failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          await this.status
            .update({
              phase: 'error',
              ready: false,
              connected: false,
              lastError: error instanceof Error ? error.message : String(error),
            })
            .catch(() => undefined);
          await sleep(this.config.standbyPollMs, this.stopController.signal);
        }
      } finally {
        await releaseLease?.().catch(() => undefined);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopController.abort();
    this.activeDeliveryAbort?.abort();
    await this.activeSession?.disconnect().catch(() => undefined);
    await this.status
      .update({
        phase: 'stopping',
        live: false,
        ready: false,
        connected: false,
      })
      .catch(() => undefined);
  }

  private async runAsLeader(
    renewLease: () => Promise<RedisLockRenewResult>,
  ): Promise<void> {
    const queue = new DiscordInboundQueue(this.redis, {
      maxEntries: this.config.inboundMaxEntries,
      deadLetterMaxEntries: this.config.deadLetterMaxEntries,
    });
    const session = new DiscordGatewaySession(queue, this.status);
    const deliveryAbort = new AbortController();
    this.activeSession = session;
    this.activeDeliveryAbort = deliveryAbort;

    let leaseValid = true;
    let activeFingerprint: string | null = null;
    let deliveryPromise: Promise<void> | null = null;
    const loginBackoff = new DiscordLoginBackoff(
      this.config.loginRetryBaseMs,
      this.config.loginRetryMaxMs,
    );
    // The lease TTL (30s) leaves room for two renew intervals (10s), so a
    // single transient Redis error must not tear down a healthy Gateway
    // connection; only a definitive ownership loss or a second consecutive
    // failure (past which the lease may genuinely have expired) does.
    let renewErrorStreak = 0;
    const abandonLeadership = () => {
      leaseValid = false;
      deliveryAbort.abort();
      void session.disconnect();
    };
    const leaseTimer = setInterval(() => {
      void renewLease()
        .then((result) => {
          if (result === 'renewed') {
            renewErrorStreak = 0;
            return;
          }
          if (result === 'lost') {
            abandonLeadership();
            return;
          }
          renewErrorStreak += 1;
          if (renewErrorStreak >= 2) {
            abandonLeadership();
          }
        })
        .catch(() => {
          abandonLeadership();
        });
    }, this.config.leaderLeaseRenewMs);
    const statusTimer = setInterval(() => {
      void Promise.all([queue.depth(), queue.deadLetterDepth()])
        .then(([queueDepth, deadLetterDepth]) =>
          this.status.update({
            queueDepth,
            deadLetterDepth,
            // Surface capacity pressure before the approximate MAXLEN cap
            // starts shedding the oldest undelivered events.
            ...(queueDepth >= queue.capacity * 0.9
              ? {
                  lastError: `Inbound event stream is at ${queueDepth}/${queue.capacity} entries; oldest undelivered events will be shed at capacity.`,
                }
              : {}),
          }),
        )
        .catch((error) =>
          this.status.update({
            lastError: error instanceof Error ? error.message : String(error),
          }),
        );
    }, this.config.statusRefreshMs);

    try {
      await this.status.update({
        phase: 'awaiting_configuration',
        leader: true,
        configured: false,
        ready: false,
        connected: false,
        queueDepth: await queue.depth(),
        forwardingReady: false,
      });

      if (this.config.apiSecret) {
        const forwarder = new DiscordApiForwarder(
          this.config.apiEventsUrl,
          this.config.apiSecret,
          this.config.apiTimeoutMs,
        );
        deliveryPromise = runSupervisedDeliveryLoop({
          queue,
          forwarder,
          status: this.status,
          signal: deliveryAbort.signal,
          pollMs: this.config.deliveryPollMs,
          maxAttempts: this.config.deliveryMaxAttempts,
          maxBackoffMs: this.config.deliveryMaxBackoffMs,
          restartMaxBackoffMs: this.config.deliveryMaxBackoffMs,
        });
      } else {
        await this.status.update({
          phase: 'error',
          forwardingReady: false,
          lastError:
            'R_DISCORD_GATEWAY_SECRET or ENCRYPTION_KEY is required to forward Discord events',
        });
      }

      while (!this.stopped && leaseValid) {
        let credentials: DiscordGatewayCredentials | null;
        try {
          credentials = await resolveDiscordGatewayCredentials();
        } catch (error) {
          await this.status.update({
            lastError: `Discord credential lookup failed: ${error instanceof Error ? error.message : String(error)}`,
          });
          await sleep(this.config.credentialPollMs, this.stopController.signal);
          continue;
        }

        if (credentials && activeFingerprint && session.needsReconnect()) {
          await this.status.update({
            phase: 'reconnecting',
            ready: false,
            connected: false,
          });
          await session.disconnect();
          activeFingerprint = null;
          loginBackoff.reset(credentials.tokenFingerprint);
        }

        if (!credentials) {
          if (activeFingerprint) {
            await session.disconnect();
            activeFingerprint = null;
          }
          loginBackoff.reset();
          await this.status.update({
            phase: 'awaiting_configuration',
            configured: false,
            ready: false,
            connected: false,
          });
        } else if (
          credentials.tokenFingerprint !== activeFingerprint &&
          loginBackoff.canAttempt(credentials.tokenFingerprint)
        ) {
          await session.disconnect();
          activeFingerprint = null;
          try {
            await session.connect(
              credentials.botToken,
              credentials.tokenFingerprint,
            );
            activeFingerprint = credentials.tokenFingerprint;
            loginBackoff.reset(credentials.tokenFingerprint);
          } catch (error) {
            await session.disconnect().catch(() => undefined);
            const failure = loginBackoff.recordFailure(
              credentials.tokenFingerprint,
            );
            await this.status.update({
              phase: 'error',
              configured: true,
              ready: false,
              connected: false,
              lastError: `Discord login failed (attempt ${failure.attempts}); retrying in ${Math.ceil(failure.delayMs / 1_000)}s: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }

        await sleep(this.config.credentialPollMs, this.stopController.signal);
      }
    } finally {
      clearInterval(leaseTimer);
      clearInterval(statusTimer);
      deliveryAbort.abort();
      await deliveryPromise?.catch(() => undefined);
      await session.disconnect();
      this.activeSession = null;
      this.activeDeliveryAbort = null;
    }
  }
}
