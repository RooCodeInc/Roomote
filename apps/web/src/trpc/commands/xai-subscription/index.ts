import {
  disconnectXaiSubscription,
  getXaiSubscriptionStatus,
  isXaiSubscriptionConnected,
  pollXaiDeviceAuth,
  startXaiDeviceAuth,
  type XaiSubscriptionPublicStatus,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

function assertAdmin(auth: UserAuthSuccess): void {
  if (!auth.isAdmin) {
    throw new Error('Unauthorized');
  }
}

export async function getXaiSubscriptionStatusCommand(
  auth: UserAuthSuccess,
): Promise<XaiSubscriptionPublicStatus> {
  assertAdmin(auth);
  return getXaiSubscriptionStatus();
}

export async function isXaiSubscriptionConnectedCommand(
  auth: UserAuthSuccess,
): Promise<boolean> {
  assertAdmin(auth);
  return isXaiSubscriptionConnected();
}

export async function startXaiDeviceAuthCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);
  return startXaiDeviceAuth();
}

type PollXaiDeviceAuthResult =
  | { status: 'pending'; intervalMs?: number }
  | { status: 'success' }
  | { status: 'failed'; error: string };

export async function pollXaiDeviceAuthCommand(
  auth: UserAuthSuccess,
  input: { deviceCode: string },
): Promise<PollXaiDeviceAuthResult> {
  assertAdmin(auth);
  const result = await pollXaiDeviceAuth(input);

  // Never surface the stored OAuth record (which contains refresh/access
  // tokens) to the client. Return a token-free status shape only.
  if (result.status === 'success') {
    return { status: 'success' };
  }

  if (result.status === 'failed') {
    return { status: 'failed', error: result.error };
  }

  return {
    status: 'pending',
    ...(result.intervalMs !== undefined && { intervalMs: result.intervalMs }),
  };
}

export async function disconnectXaiSubscriptionCommand(
  auth: UserAuthSuccess,
): Promise<{ success: true }> {
  assertAdmin(auth);
  await disconnectXaiSubscription();
  return { success: true };
}
