'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { z } from 'zod';
import {
  CircleX,
  CircleCheck,
  AlertCircleIcon,
  Github,
  Home,
} from '@/components/system';

import { decodeRecord } from '@/lib';

function decodeOAuthState(
  encodedState: string | null | undefined,
): Record<string, string> | undefined {
  if (!encodedState) {
    return undefined;
  }

  const fromRecord = decodeRecord<Record<string, string>>(encodedState);
  if (fromRecord) {
    return fromRecord;
  }

  // Signed {payload}.{signature} form used by account-link OAuth.
  const [encodedPayload] = encodedState.split('.');
  if (!encodedPayload) {
    return undefined;
  }

  try {
    const base64 = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(atob(padded)) as Record<string, string>;
  } catch {
    return undefined;
  }
}

import { useUser } from '@/hooks/useUser';
import { useRedirectToSignIn } from '@/hooks/useSignInRedirect';
import {
  useFinishAuthenticateGitHubAccount,
  useFinishCreateGitHubAppManifest,
  useFinishCreateGitHubInstallation,
  useGitHubPendingInstallations,
  useResolvePendingGitHubInstallations,
  useSyncGitHubInstallation,
} from '@/hooks/github';

import { Alert, AlertDescription, Button } from '@/components/system';

export default function Page() {
  const router = useRouter();
  const params = useSearchParams();

  const { authStatus, isSignedIn } = useUser();

  const [isLoading, setIsLoading] = useState(true);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isInstallRequested, setIsInstallRequested] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [manualCheckMessage, setManualCheckMessage] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  useRedirectToSignIn(authStatus === 'signed-out');

  const encodedCallbackState = params.get('state');
  const decodedCallbackState = decodeOAuthState(encodedCallbackState);
  // Failures here are usually bad saved GitHub App credentials, so route the
  // user back to where those can be fixed instead of dead-ending on the error.
  const cameFromSetup =
    decodedCallbackState?.redirect?.startsWith('/setup') === true;
  const errorReturnTarget = cameFromSetup
    ? '/setup?step=source-control-config'
    : '/settings';

  const navigateFromState = useCallback(() => {
    const encodedState = params.get('state');
    const decodedState = decodeOAuthState(encodedState);

    const redirect = decodedState?.redirect;

    const isValidRedirect =
      redirect &&
      redirect.startsWith('/') &&
      !redirect.startsWith('//') &&
      !redirect.includes('://');

    router.push(isValidRedirect ? redirect : '/settings');
  }, [params, router]);

  const finishAuthentication = useFinishAuthenticateGitHubAccount({
    onSuccess: (result) => {
      setIsLoading(false);

      if (result.success) {
        setIsAuthenticated(true);
        navigateFromState();
      } else {
        setError(result.error);
      }
    },
    onError: (error) => {
      setIsLoading(false);
      setError(error.message);
    },
  });

  const finishInstall = useFinishCreateGitHubInstallation({
    onSuccess: (result) => {
      setIsLoading(false);

      if (result.success) {
        setIsInstallRequested(true);
      } else {
        setError(result.error);
      }
    },
    onError: (error) => {
      setIsLoading(false);
      setError(error.message);
    },
  });

  const finishAppManifest = useFinishCreateGitHubAppManifest({
    onSuccess: (result) => {
      if (result.success) {
        window.location.href = result.installUrl;
      } else {
        setIsLoading(false);
        setError(result.error);
      }
    },
    onError: (error) => {
      setIsLoading(false);
      setError(error.message);
    },
  });

  const syncInstall = useSyncGitHubInstallation({
    onSuccess: (result) => {
      setIsLoading(false);

      if (result.success) {
        setIsInstalled(true);
        navigateFromState();
      } else {
        setError(result.error);
      }
    },
    onError: (error) => {
      setIsLoading(false);
      setError(error.message);
    },
  });

  // While the install request awaits an org owner's approval, poll for the
  // webhook-driven completion (which deletes the pending row) so the user can
  // continue without manually revisiting setup.
  const pendingInstallations = useGitHubPendingInstallations({
    enabled: isInstallRequested,
    refetchInterval: 10_000,
  });

  const resolvePendingInstallations = useResolvePendingGitHubInstallations({
    onSuccess: (result) => {
      if (result.success && result.completed > 0) {
        setIsInstallRequested(false);
        setIsInstalled(true);
        navigateFromState();
      } else if (result.success) {
        setManualCheckMessage(
          'Not approved yet. Hang tight, this page keeps checking on its own.',
        );
      } else {
        setManualCheckMessage(result.error);
      }
    },
    onError: (error) => {
      setManualCheckMessage(error.message);
    },
  });

  const isInstallRequestApproved =
    isInstallRequested && pendingInstallations.data?.pending === false;

  useEffect(() => {
    if (isInstallRequestApproved) {
      setIsInstallRequested(false);
      setIsInstalled(true);
      navigateFromState();
    }
  }, [isInstallRequestApproved, navigateFromState]);

  const hasHandledCallback = useRef(false);

  useEffect(() => {
    if (hasHandledCallback.current || authStatus !== 'signed-in') {
      return;
    }

    hasHandledCallback.current = true;

    const error = params.get('error');
    const setupAction = params.get('setup_action');
    const code = params.get('code');
    const encodedState = params.get('state');
    const decodedState = decodeOAuthState(encodedState);

    const isAuthenticationFlow = decodedState?.mode === 'auth';
    const isAppManifestFlow = decodedState?.mode === 'github-app-manifest';

    if (error) {
      setIsLoading(false);
      setError(error);
    } else if (isAppManifestFlow) {
      if (!code) {
        setIsLoading(false);
        setError('Missing manifest code. Please try again.');
      } else {
        finishAppManifest.mutate({
          code,
          redirect: decodedState?.redirect,
        });
      }
    } else if (setupAction === 'request') {
      if (!code) {
        setIsLoading(false);
        setError('Missing OAuth code. Please try again.');
      } else {
        finishInstall.mutate(code);
      }
    } else if (isAuthenticationFlow) {
      if (!code || !encodedState) {
        setIsLoading(false);
        setError('Missing OAuth code. Please try again.');
      } else {
        finishAuthentication.mutate({ code, state: encodedState });
      }
    } else {
      // TODO: This path works for both `install` and `update` setup actions,
      // but we always show "GitHub Linking..."; we might want to differentiate
      // the UI based on the setup action.
      if (!isSignedIn) {
        return;
      }

      const installationId = z.coerce
        .number()
        .min(1)
        .safeParse(params.get('installation_id'));

      if (!installationId.success) {
        setIsLoading(false);
        setError('Invalid installation id. Please try again.');
      } else {
        syncInstall.mutate(installationId.data);
      }
    }
  }, [
    authStatus,
    finishAuthentication,
    finishAppManifest,
    finishInstall,
    isSignedIn,
    params,
    syncInstall,
  ]);

  return (
    <div className="flex flex-col items-center justify-center gap-2">
      <div className="flex items-center justify-center gap-2">
        {isLoading ? (
          <Github className="animate-pulse" />
        ) : isInstallRequested || isInstalled || isAuthenticated ? (
          <CircleCheck className="text-green-500" />
        ) : (
          <CircleX className="text-rose-500" />
        )}
        <div className="text-sm">
          {isInstallRequested
            ? 'GitHub Link Requested'
            : isAuthenticated
              ? 'GitHub Account Linked'
              : isInstalled
                ? 'GitHub Linked'
                : error
                  ? 'Error'
                  : 'GitHub Linking...'}
        </div>
      </div>
      {error && (
        <>
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertDescription className="max-w-sm line-clamp-5">
              {error}
            </AlertDescription>
          </Alert>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              // Full document navigation: the setup wizard consumes its
              // ?step= deep link from window.location during the initial
              // render, which a client-side router.push can race past.
              window.location.assign(errorReturnTarget);
            }}
          >
            {cameFromSetup ? 'Review GitHub configuration' : 'Open settings'}
          </Button>
        </>
      )}
      {isInstallRequested && (
        <Alert className="w-sm">
          <AlertDescription>
            <div className="flex flex-col gap-4">
              <div>
                Your request is pending approval from a GitHub organization
                owner. You can wait here and we&apos;ll continue automatically
                once it&apos;s approved.
              </div>
              {manualCheckMessage && (
                <div className="text-muted-foreground">
                  {manualCheckMessage}
                </div>
              )}
              <div className="flex items-center gap-2 self-center">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={resolvePendingInstallations.isPending}
                  onClick={() => {
                    setManualCheckMessage(null);
                    resolvePendingInstallations.mutate();
                  }}
                >
                  {resolvePendingInstallations.isPending
                    ? 'Checking...'
                    : 'Check now'}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => router.push('/')}
                >
                  <Home />
                </Button>
              </div>
            </div>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
