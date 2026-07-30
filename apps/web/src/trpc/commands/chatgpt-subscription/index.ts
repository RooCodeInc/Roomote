import {
  disconnectChatGptSubscription,
  getChatGptSubscriptionStatus,
  isChatGptSubscriptionConnected,
  pollChatGptDeviceAuth,
  startChatGptDeviceAuth,
  updateChatGptSubscriptionFastMode,
  type ChatGptSubscriptionPublicStatus,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

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
  | { status: 'pending' }
  | { status: 'success' }
  | { status: 'failed'; error: string };

export async function pollChatGptDeviceAuthCommand(
  auth: UserAuthSuccess,
  input: { deviceAuthId: string; userCode: string },
): Promise<PollChatGptDeviceAuthResult> {
  assertAdmin(auth);
  const result = await pollChatGptDeviceAuth(input);

  // Never surface the stored OAuth record (which contains refresh/access
  // tokens) to the client. Return a token-free status shape only.
  if (result.status === 'success') {
    return { status: 'success' };
  }

  if (result.status === 'failed') {
    return { status: 'failed', error: result.error };
  }

  return { status: 'pending' };
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
