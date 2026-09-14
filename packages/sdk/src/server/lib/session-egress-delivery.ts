import { isSessionEgressDeliveryCurrent } from '@roomote/db/server';
import { decryptJSON, encryptJSON } from '@roomote/db/encryption';
import { getRedis } from '@roomote/redis';
import type {
  AuthTokenContext,
  RunTokenContext,
  SessionEgressWorkloadRegistration,
} from '@roomote/types';
import { isRunToken } from '../trpc';
import { findTaskRunByRunTokenClaims } from './task-runs/find-task-run';

const prefix = 'session-egress:verified-delivery:';
const unavailable = () =>
  new Error('Session egress client configuration unavailable');

interface Delivery {
  workloadId: string;
  generation: number;
  runId: number;
  environment: Record<string, string>;
}

export async function markSessionEgressBootstrapReady(
  auth: AuthTokenContext | RunTokenContext | null,
  nonce: string,
): Promise<void> {
  if (
    !isRunToken(auth) ||
    auth.principal !== 'user' ||
    !auth.userId ||
    !(await findTaskRunByRunTokenClaims(auth))
  )
    throw unavailable();
  await getRedis().set(
    `${prefix}bootstrap:${auth.runId}:${nonce}`,
    '1',
    'EX',
    900,
  );
}

export async function isSessionEgressBootstrapReady(
  runId: number,
  nonce: string,
): Promise<boolean> {
  return (await getRedis().get(`${prefix}bootstrap:${runId}:${nonce}`)) === '1';
}

/** Only controller code calls this after externally applying and verifying the policy. */
export async function publishSessionEgressDelivery(
  runId: number,
  registration: SessionEgressWorkloadRegistration,
  environment: Record<string, string>,
  nonce: string,
): Promise<void> {
  const delivery: Delivery = {
    runId,
    workloadId: registration.workloadId,
    generation: registration.generation,
    environment,
  };
  if (!(await isSessionEgressDeliveryCurrent(delivery))) throw unavailable();
  // This short-lived handoff contains substitutes, never real API keys. Encrypt
  // it nevertheless; the canonical substitute table continues to store hashes only.
  await getRedis().set(
    `${prefix}${runId}:${nonce}`,
    encryptJSON(delivery),
    'EX',
    120,
  );
}

export async function readSessionEgressDelivery(
  auth: AuthTokenContext | RunTokenContext | null,
  nonce: string,
): Promise<Record<string, string> | null> {
  if (
    !isRunToken(auth) ||
    auth.principal !== 'user' ||
    !auth.userId ||
    !(await findTaskRunByRunTokenClaims(auth))
  )
    throw unavailable();
  const encrypted = await getRedis().get(`${prefix}${auth.runId}:${nonce}`);
  if (!encrypted) return null;
  let delivery: Delivery;
  try {
    delivery = decryptJSON<Delivery>(encrypted);
  } catch {
    throw unavailable();
  }
  if (
    delivery.runId !== auth.runId ||
    !(await isSessionEgressDeliveryCurrent({
      ...delivery,
      signedUserId: auth.userId,
    }))
  )
    throw unavailable();
  return delivery.environment;
}
