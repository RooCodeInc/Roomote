import {
  acquireRedisLock,
  type Redis,
  type RedisLockRenewResult,
} from '@roomote/redis';

import { DiscordApiForwarder } from './api-forwarder';
import { DiscordAutoStartChannelTracker } from './auto-start-channels';
import type { DiscordGatewayConfig } from './config';
import {
  resolveDiscordGatewayApiSecret,
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
    const autoStartChannels = new DiscordAutoStartChannelTracker({
      onError: (error) => {
        void this.status.update({
          lastError: `Discord auto-start channel lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      },
    });
    autoStartChannels.start();
    const session = new DiscordGatewaySession(queue, this.status, {
      isAutoStartChannel: (channelId) =>
        autoStartChannels.isAutoStartChannel(channelId),
    });
    this.activeSession = session;

    let leaseValid = true;
    let activeFingerprint: string | null = null;
    const delivery: {
      promise: Promise<void> | null;
      abort: AbortController;
      secret: string | null;
    } = {
      promise: null,
      abort: new AbortController(),
      secret: null,
    };
    this.activeDeliveryAbort = delivery.abort;
    const loginBackoff = new DiscordLoginBackoff(
      this.config.loginRetryBaseMs,
      this.config.loginRetryMaxMs,
    );
    const abortDelivery = () => {
      delivery.abort.abort();
      this.activeDeliveryAbort = delivery.abort;
    };

    // The lease TTL (30s) leaves room for two renew intervals (10s), so a
    // single transient Redis error must not tear down a healthy Gateway
    // connection; only a definitive ownership loss or a second consecutive
    // failure (past which the lease may genuinely have expired) does.
    let renewErrorStreak = 0;
    const abandonLeadership = () => {
      leaseValid = false;
      abortDelivery();
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
      void Promise.all([
        queue.depth(),
        queue.deadLetterDepth(),
        queue.pruneOrphanedAttempts(),
      ])
        .then(([queueDepth, deadLetterDepth]) =>
          this.status.update({
            queueDepth,
            deadLetterDepth,
            // Surface capacity pressure before the approximate MAXLEN cap
            // starts shedding the oldest undelivered events. This is a
            // dedicated field with this timer as its only writer, so a
            // successful delivery clearing lastError cannot erase it while
            // the backlog is still high.
            capacityWarning:
              queueDepth >= queue.capacity * 0.9
                ? `Inbound event stream is at ${queueDepth}/${queue.capacity} entries; oldest undelivered events will be shed at capacity.`
                : undefined,
          }),
        )
        .catch((error) =>
          this.status.update({
            lastError: error instanceof Error ? error.message : String(error),
          }),
        );
    }, this.config.statusRefreshMs);

    const ensureDeliveryLoop = async (apiSecret: string | null) => {
      // Leadership can be lost while we resolve secrets or wait for an old
      // delivery worker to unwind. Never start a new forwarder unless we still
      // own the lease.
      const canLead = () => leaseValid && !this.stopped;

      if (apiSecret && apiSecret === delivery.secret && delivery.promise) {
        return;
      }

      if (delivery.promise) {
        abortDelivery();
        await delivery.promise.catch(() => undefined);
        delivery.promise = null;
      }

      if (!canLead()) {
        delivery.secret = null;
        return;
      }

      if (!apiSecret) {
        delivery.secret = null;
        await this.status.update({
          forwardingReady: false,
          lastError:
            'R_DISCORD_GATEWAY_SECRET is required to forward Discord events',
        });
        return;
      }

      if (!canLead()) {
        delivery.secret = null;
        return;
      }

      delivery.abort = new AbortController();
      this.activeDeliveryAbort = delivery.abort;
      const forwarder = new DiscordApiForwarder(
        this.config.apiEventsUrl,
        apiSecret,
        this.config.apiTimeoutMs,
      );
      delivery.promise = runSupervisedDeliveryLoop({
        queue,
        forwarder,
        status: this.status,
        signal: delivery.abort.signal,
        pollMs: this.config.deliveryPollMs,
        maxAttempts: this.config.deliveryMaxAttempts,
        maxBackoffMs: this.config.deliveryMaxBackoffMs,
        restartMaxBackoffMs: this.config.deliveryMaxBackoffMs,
      });
      delivery.secret = apiSecret;
      await this.status.update({
        forwardingReady: true,
      });
    };

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

      while (!this.stopped && leaseValid) {
        try {
          const apiSecret = await resolveDiscordGatewayApiSecret(
            this.config.processEnv,
          );
          // Secret lookup is async; re-check leadership in ensureDeliveryLoop.
          if (leaseValid && !this.stopped) {
            await ensureDeliveryLoop(apiSecret);
          }
        } catch (error) {
          await this.status.update({
            lastError: `Discord gateway secret lookup failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }

        if (!leaseValid || this.stopped) {
          break;
        }

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
      autoStartChannels.stop();
      abortDelivery();
      if (delivery.promise) {
        await delivery.promise.catch(() => undefined);
      }
      await session.disconnect();
      this.activeSession = null;
      this.activeDeliveryAbort = null;
    }
  }
}
