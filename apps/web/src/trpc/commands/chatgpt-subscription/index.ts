import {
  disconnectChatGptSubscription,
  getChatGptSubscriptionStatus,
  isChatGptSubscriptionConnected,
  pollChatGptDeviceAuth,
  startChatGptDeviceAuth,
  updateChatGptSubscriptionFastMode,
  type ChatGptDevicePollFailureReason,
  type ChatGptSubscriptionPublicStatus,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';
import { autoAddConnectedSubscriptionTaskModels } from '../task-models';

function assertAdmin(auth: UserAuthSuccess): asserts auth is UserAuthSuccess {
  if (!auth.isAdmin) {
    throw new Error('Unauthorized');
  }
}

export async function getChatGptSubscriptionStatusCommand(
  auth: UserAuthSuccess,
): Promise<ChatGptSubscriptionPublicStatus> {
  assertAdmin(auth);
  return getChatGptSubscriptionStatus();
}

export async function isChatGptSubscriptionConnectedCommand(
  auth: UserAuthSuccess,
): Promise<boolean> {
  assertAdmin(auth);
  return isChatGptSubscriptionConnected();
}

export async function startChatGptDeviceAuthCommand(
  auth: UserAuthSuccess,
): Promise<Awaited<ReturnType<typeof startChatGptDeviceAuth>>> {
  assertAdmin(auth);
  return startChatGptDeviceAuth();
}

type PollChatGptDeviceAuthResult =
  | { status: 'pending'; intervalMs?: number }
  | { status: 'success' }
  | {
      status: 'failed';
      error: string;
      reason?: ChatGptDevicePollFailureReason;
    };

export async function pollChatGptDeviceAuthCommand(
  auth: UserAuthSuccess,
  input: { deviceAuthId: string; userCode: string },
): Promise<PollChatGptDeviceAuthResult> {
  assertAdmin(auth);
  const result = await pollChatGptDeviceAuth(input);

  // Never surface the stored OAuth record (which contains refresh/access
  // tokens) to the client. Return a token-free status shape only.
  if (result.status === 'success') {
    await autoAddConnectedSubscriptionTaskModels('chatgpt');
    return { status: 'success' };
  }

  if (result.status === 'failed') {
    return {
      status: 'failed',
      error: result.error,
      ...(result.reason && { reason: result.reason }),
    };
  }

  return {
    status: 'pending',
    ...(result.intervalMs && { intervalMs: result.intervalMs }),
  };
}

export async function disconnectChatGptSubscriptionCommand(
  auth: UserAuthSuccess,
): Promise<{ success: true }> {
  assertAdmin(auth);
  await disconnectChatGptSubscription();
  return { success: true };
}

export async function updateChatGptSubscriptionFastModeCommand(
  auth: UserAuthSuccess,
  input: { fastMode: boolean },
): Promise<{ success: true }> {
  assertAdmin(auth);
  await updateChatGptSubscriptionFastMode(input.fastMode);
  return { success: true };
}
