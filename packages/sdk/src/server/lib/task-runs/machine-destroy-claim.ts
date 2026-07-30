import { randomUUID } from 'node:crypto';

import type { ComputeProvider } from '@roomote/types';
import { getRedis, REDIS_KEYS } from '@roomote/redis';

/**
 * Lease for one teardown attempt. Renewed while the provider call is in
 * flight, so it only has to outlive a crashed claim holder, not a slow
 * provider delete.
 */
const MACHINE_DESTROY_CLAIM_TTL_SECONDS = 15 * 60;

/** Renew well inside the TTL so one missed tick cannot lose the lease. */
const MACHINE_DESTROY_CLAIM_RENEW_INTERVAL_MS = 5 * 60 * 1_000;

/** Delete the claim only when the caller's token still owns it. */
const RELEASE_IF_OWNED_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/** Extend the lease only when the caller's token still owns it. */
const RENEW_IF_OWNED_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("expire", KEYS[1], ARGV[2]) else return 0 end`;

type MachineDestroyClaim =
  /** Another caller is already destroying this machine — do not delete. */
  | { outcome: 'held' }
  | {
      /**
       * `claimed`: this caller owns the teardown and must issue the provider
       * delete. `unavailable`: redis is unreachable — proceed unserialized
       * rather than leak the machine (release/finish are no-ops).
       */
      outcome: 'claimed' | 'unavailable';
      /**
       * Call when the provider delete failed: stops lease renewal and deletes
       * the key only if this caller's token still owns it, so a retry (or a
       * concurrent caller that took over after lease expiry) is unaffected.
       */
      release: () => Promise<void>;
      /**
       * Call when the provider delete succeeded: stops lease renewal and
       * leaves the key to expire (destroys are permanent, so the residual
       * TTL keeps guarding against a duplicate delete from a lagging path).
       */
      finish: () => void;
    };

function buildMachineDestroyClaimKey(
  provider: ComputeProvider,
  machineId: string,
): string {
  return `${REDIS_KEYS.MACHINE_DESTROY_CLAIM}:${provider}:${machineId}`;
}

const NOOP_CLAIM_HANDLE = {
  release: async () => {},
  finish: () => {},
};

/**
 * Atomically claim the teardown of one provider machine before calling
 * destroyInstance. Cancel finalization and sleep-check can race on the same
 * machine; the final `compute_provider_usage` record alone cannot arbitrate
 * because both writers record it only after the provider call returns.
 *
 * Ownership is a unique token: release and renewal are conditional on the
 * token so a caller whose lease lapsed can never delete a successor's claim,
 * and the lease is renewed in the background until the caller settles it via
 * `finish()` (success) or `release()` (failure).
 */
export async function claimMachineDestroy(params: {
  provider: ComputeProvider;
  machineId: string;
  /** Caller tag embedded in the claim token for debugging. */
  owner: string;
}): Promise<MachineDestroyClaim> {
  const key = buildMachineDestroyClaimKey(params.provider, params.machineId);
  const token = `${params.owner}:${randomUUID()}`;

  try {
    const claim = await getRedis().set(
      key,
      token,
      'EX',
      MACHINE_DESTROY_CLAIM_TTL_SECONDS,
      'NX',
    );

    if (claim !== 'OK') {
      return { outcome: 'held' };
    }
  } catch (error) {
    console.warn(
      `[claimMachineDestroy] Redis unavailable while claiming ${params.provider} machine ${params.machineId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { outcome: 'unavailable', ...NOOP_CLAIM_HANDLE };
  }

  const renewTimer = setInterval(() => {
    getRedis()
      .eval(
        RENEW_IF_OWNED_SCRIPT,
        1,
        key,
        token,
        String(MACHINE_DESTROY_CLAIM_TTL_SECONDS),
      )
      .catch((error: unknown) => {
        console.warn(
          `[claimMachineDestroy] Failed to renew teardown lease for ${params.provider} machine ${params.machineId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }, MACHINE_DESTROY_CLAIM_RENEW_INTERVAL_MS);

  // Never keep the process alive just to renew a teardown lease.
  renewTimer.unref?.();

  return {
    outcome: 'claimed',
    finish: () => {
      clearInterval(renewTimer);
    },
    release: async () => {
      clearInterval(renewTimer);
      try {
        await getRedis().eval(RELEASE_IF_OWNED_SCRIPT, 1, key, token);
      } catch (error) {
        console.warn(
          `[claimMachineDestroy] Failed to release teardown claim for ${params.provider} machine ${params.machineId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  };
}
