import { type NextRequest, NextResponse } from 'next/server';
import { resolveDeploymentEnvVar } from '@roomote/db/server';
import * as GitLab from '@roomote/gitlab';
import * as Gitea from '@roomote/gitea';
import * as Bitbucket from '@roomote/bitbucket';
import { authorize } from './auth-context';
import { completeConnectionAttempt } from './source-control-connection-attempt';
import { verifyConnectionState } from './source-control-connection-state';
import {
  addSourceControlOAuthResult,
  isSetupOAuthReturnTarget,
  resolveSourceControlOAuthReturnTarget,
} from './source-control-oauth-redirect';
import { getSetupBootstrapState } from './setup-bootstrap-state';
import { syncRepositoriesCommand } from '@/trpc/commands/source-control';
import { notifySetupSourceControlSynchronized } from '@/trpc/commands/setup/setup-session';

export async function connectionOAuthCallback(
  request: NextRequest,
  provider: 'gitlab' | 'gitea' | 'bitbucket',
  origin: string,
) {
  const auth = await authorize();
  if (!auth.success || !auth.isAdmin)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let target = '/settings/source-control';
  try {
    const state = request.nextUrl.searchParams.get('state') ?? '';
    const binding = verifyConnectionState(state, auth.userId, provider);
    target = resolveSourceControlOAuthReturnTarget({
      requestedTarget: binding.returnTarget,
      ...(await getSetupBootstrapState()),
    });
    const completed = await completeConnectionAttempt(
      auth,
      { provider, state },
      async () => {
        const code = request.nextUrl.searchParams.get('code');
        if (!code || request.nextUrl.searchParams.has('error'))
          return { success: false as const };
        const prefix = provider.toUpperCase();
        const [clientId, clientSecret] = await Promise.all([
          resolveDeploymentEnvVar(`${prefix}_CLIENT_ID`),
          resolveDeploymentEnvVar(`${prefix}_CLIENT_SECRET`),
        ]);
        if (!clientId || !clientSecret)
          throw new Error('Provider credentials unavailable.');
        if (provider === 'gitlab')
          await GitLab.exchangeGitLabOAuthCode({
            clientId,
            clientSecret,
            code,
            baseUrl: await GitLab.resolveGitLabBaseUrl(),
            redirectUri: GitLab.buildGitLabOAuthRedirectUri(origin),
          });
        else if (provider === 'gitea') {
          const baseUrl = await Gitea.resolveGiteaBaseUrl();
          if (!baseUrl) throw new Error('Provider unavailable.');
          await Gitea.exchangeGiteaOAuthCode({
            clientId,
            clientSecret,
            code,
            baseUrl,
            redirectUri: Gitea.buildGiteaOAuthRedirectUri(origin),
          });
        } else
          await Bitbucket.exchangeBitbucketOAuthCode({
            clientId,
            clientSecret,
            code,
            redirectUri: Bitbucket.buildBitbucketOAuthRedirectUri(origin),
          });
        return syncRepositoriesCommand(auth, { provider });
      },
    );
    if (completed.result.success && isSetupOAuthReturnTarget(target))
      await notifySetupSourceControlSynchronized(auth);
    return NextResponse.redirect(
      new URL(
        addSourceControlOAuthResult(
          target,
          provider,
          completed.result.success ? 'connected' : 'error',
        ),
        origin,
      ),
    );
  } catch {
    // Provider errors and callback/state material must not enter navigation or transcript output.
    return NextResponse.redirect(
      new URL(addSourceControlOAuthResult(target, provider, 'error'), origin),
    );
  }
}
