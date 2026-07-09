'use client';

import { useEffect, useRef, useState } from 'react';
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

import { useUser } from '@/hooks/useUser';
import { useRedirectToSignIn } from '@/hooks/useSignInRedirect';
import {
  useFinishAuthenticateGitHubAccount,
  useFinishCreateGitHubAppManifest,
  useFinishCreateGitHubInstallation,
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
  const [error, setError] = useState<string | null>(null);
  useRedirectToSignIn(authStatus === 'signed-out');

  const encodedCallbackState = params.get('state');
  const decodedCallbackState = encodedCallbackState
    ? decodeRecord<Record<string, string>>(encodedCallbackState)
    : undefined;
  // Failures here are usually bad saved GitHub App credentials, so route the
  // user back to where those can be fixed instead of dead-ending on the error.
  const cameFromSetup =
    decodedCallbackState?.redirect?.startsWith('/setup') === true;
  const errorReturnTarget = cameFromSetup
    ? '/setup?step=source-control-config'
    : '/settings';

  const navigateFromState = () => {
    const encodedState = params.get('state');

    const decodedState = encodedState
      ? decodeRecord<Record<string, string>>(encodedState)
      : undefined;

    const redirect = decodedState?.redirect;

    const isValidRedirect =
      redirect &&
      redirect.startsWith('/') &&
      !redirect.startsWith('//') &&
      !redirect.includes('://');

    router.push(isValidRedirect ? redirect : '/settings');
  };

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

    const decodedState = encodedState
      ? decodeRecord<Record<string, string>>(encodedState)
      : undefined;

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
      if (!code) {
        setIsLoading(false);
        setError('Missing OAuth code. Please try again.');
      } else {
        finishAuthentication.mutate(code);
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
                Your request is pending admin approval. Upon approval
                you&apos;ll be able to continue.
              </div>
              <div className="self-center">
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
