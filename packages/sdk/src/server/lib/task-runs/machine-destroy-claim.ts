import type { ComputeProvider } from '@roomote/types';
import { getRedis, REDIS_KEYS } from '@roomote/redis';

/**
 * Long enough to outlive any realistic provider destroy call, short enough
 * that a crashed claim holder does not block teardown retries for long.
 */
const MACHINE_DESTROY_CLAIM_TTL_SECONDS = 15 * 60;

export type MachineDestroyClaimOutcome =
  /** This caller owns the teardown and must issue the provider delete. */
  | 'claimed'
  /** Another caller is already destroying this machine — do not delete. */
  | 'held'
  /** Redis is unreachable; proceed unserialized rather than leak the machine. */
  | 'unavailable';

function buildMachineDestroyClaimKey(
  provider: ComputeProvider,
  machineId: string,
): string {
  return `${REDIS_KEYS.MACHINE_DESTROY_CLAIM}:${provider}:${machineId}`;
}

/**
 * Atomically claim the teardown of one provider machine before calling
 * destroyInstance. Cancel finalization and sleep-check can race on the same
 * machine; the final `compute_provider_usage` record alone cannot arbitrate
 * because both writers record it only after the provider call returns.
 *
 * The claim is left to expire after a successful destroy (destroys are
 * permanent) and must be released via releaseMachineDestroyClaim when the
 * provider call fails, so a later attempt can retry.
 */
export async function claimMachineDestroy(params: {
  provider: ComputeProvider;
  machineId: string;
  /** Caller tag stored as the claim value for debugging. */
  owner: string;
}): Promise<MachineDestroyClaimOutcome> {
  try {
    const claim = await getRedis().set(
      buildMachineDestroyClaimKey(params.provider, params.machineId),
      params.owner,
      'EX',
      MACHINE_DESTROY_CLAIM_TTL_SECONDS,
      'NX',
    );

    return claim === 'OK' ? 'claimed' : 'held';
  } catch (error) {
    console.warn(
      `[claimMachineDestroy] Redis unavailable while claiming ${params.provider} machine ${params.machineId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 'unavailable';
  }
}

/** Best-effort release after a failed destroy so retries can re-claim. */
export async function releaseMachineDestroyClaim(params: {
  provider: ComputeProvider;
  machineId: string;
}): Promise<void> {
  try {
    await getRedis().del(
      buildMachineDestroyClaimKey(params.provider, params.machineId),
    );
  } catch (error) {
    console.warn(
      `[releaseMachineDestroyClaim] Failed to release claim for ${params.provider} machine ${params.machineId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
