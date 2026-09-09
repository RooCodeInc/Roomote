import { z } from 'zod';
import { reconcileSourceControlConnectionRequests } from '@roomote/sdk/server';
import type { UserAuthSuccess } from '@/types';
import { completeConnectionAttempt } from '@/lib/server/source-control-connection-attempt';
import { verifyConnectionState } from '@/lib/server/source-control-connection-state';
import {
  finishCreateGitHubAppManifestCommand,
  finishCreateGitHubInstallationCommand,
  startCreateGitHubInstallationCommand,
  syncGitHubInstallationCommand,
} from '../github/mutations';

export const githubConnectionCallbackInput = z.object({
  state: z.string().min(1).max(10000),
  action: z.enum(['manifest', 'request', 'install']),
  code: z.string().min(1).optional(),
  installationId: z.number().int().positive().optional(),
});

export async function githubConnectionCallbackCommand(
  auth: UserAuthSuccess,
  input: z.infer<typeof githubConnectionCallbackInput>,
) {
  const binding = verifyConnectionState(input.state, auth.userId, 'github');
  if (!binding.requestId)
    throw new Error('A Session connection request is required.');
  if (
    binding.purpose !==
    (input.action === 'manifest' ? 'github-manifest' : 'github-install')
  )
    throw new Error('Invalid connection attempt purpose.');
  const completed = await completeConnectionAttempt(
    auth,
    {
      provider: 'github',
      state: input.state,
      reconcile: input.action === 'install',
    },
    async () => {
      if (input.action === 'install') {
        if (!input.installationId) throw new Error('Missing installation.');
        return syncGitHubInstallationCommand(auth, {
          installationId: input.installationId,
        });
      }
      if (!input.code) throw new Error('Missing authorization code.');
      if (input.action === 'request')
        return finishCreateGitHubInstallationCommand(auth, {
          code: input.code,
        });
      return finishCreateGitHubAppManifestCommand(auth, {
        code: input.code,
        redirect: binding.returnTarget,
      });
    },
  );
  if (!completed.result.success)
    return {
      success: false as const,
      error:
        'Unable to complete the connection. Check the provider configuration and try again.',
    };
  if (input.action === 'request')
    await reconcileSourceControlConnectionRequests(
      { provider: 'github', requestId: binding.requestId },
      { syncState: 'pending' },
    );
  if (input.action === 'manifest') {
    const install = await startCreateGitHubInstallationCommand(auth, {
      mode: 'github-app-install',
      connectionRequestId: binding.requestId,
      redirect: completed.returnTarget,
    });
    if (!install.success) return install;
    return {
      success: true as const,
      installUrl: install.url,
      returnTarget: completed.returnTarget,
    };
  }
  return { success: true as const, returnTarget: completed.returnTarget };
}
