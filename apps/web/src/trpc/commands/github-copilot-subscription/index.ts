import {
  disconnectGitHubCopilotSubscription,
  getGitHubCopilotSubscriptionStatus,
  isGitHubCopilotSubscriptionConnected,
  pollGitHubCopilotDeviceAuth,
  startGitHubCopilotDeviceAuth,
  type GitHubCopilotSubscriptionPublicStatus,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';
import { autoAddConnectedSubscriptionTaskModels } from '../task-models';

function assertAdmin(auth: UserAuthSuccess): void {
  if (!auth.isAdmin) throw new Error('Unauthorized');
}

export async function getGitHubCopilotSubscriptionStatusCommand(
  auth: UserAuthSuccess,
): Promise<GitHubCopilotSubscriptionPublicStatus> {
  assertAdmin(auth);
  return getGitHubCopilotSubscriptionStatus();
}

export async function isGitHubCopilotSubscriptionConnectedCommand(
  auth: UserAuthSuccess,
): Promise<boolean> {
  assertAdmin(auth);
  return isGitHubCopilotSubscriptionConnected();
}

export async function startGitHubCopilotDeviceAuthCommand(
  auth: UserAuthSuccess,
) {
  assertAdmin(auth);
  return startGitHubCopilotDeviceAuth();
}

export async function pollGitHubCopilotDeviceAuthCommand(
  auth: UserAuthSuccess,
  input: { deviceCode: string },
) {
  assertAdmin(auth);
  const result = await pollGitHubCopilotDeviceAuth(input);

  if (result.status === 'success') {
    await autoAddConnectedSubscriptionTaskModels('github-copilot');
  }

  return result;
}

export async function disconnectGitHubCopilotSubscriptionCommand(
  auth: UserAuthSuccess,
): Promise<{ success: true }> {
  assertAdmin(auth);
  await disconnectGitHubCopilotSubscription();
  return { success: true };
}
