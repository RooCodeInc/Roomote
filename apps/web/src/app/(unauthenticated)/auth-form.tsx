'use client';

import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  SETUP_AUTH_PROVIDER_CATALOG,
  type SetupAuthProviderId,
} from '@roomote/types';

import { authClient } from '@/lib/auth-client';
import { getAuthProviderCallbackUrl } from '@/lib/auth-provider-callback';
import { cn } from '@/lib/utils';
import { OriginMismatchAlert } from '@/components/layout';
import { EmailPasswordAuth } from './email-password-auth';
import {
  Alert,
  AlertCircle,
  AlertDescription,
  ArrowRight,
  BrandIcon,
  Button,
  Slack,
  Spinner,
} from '@/components/system';

export type AuthProvider = SetupAuthProviderId;

const SOCIAL_PROVIDERS = SETUP_AUTH_PROVIDER_CATALOG.map((provider) => ({
  id: provider.id,
  label: provider.label,
  icon: provider.id,
}));

function AuthProviderIcon({ provider }: { provider: AuthProvider }) {
  if (provider === 'slack') {
    return <Slack aria-hidden="true" className="size-4" />;
  }

  if (provider === 'microsoft') {
    return <BrandIcon icon="teams" name="" className="size-4" />;
  }

  return <BrandIcon icon={provider} name="" className="size-4" />;
}

function getSafeRedirectUrl(rawRedirectUrl: string | null): string {
  if (!rawRedirectUrl) {
    return '/setup';
  }

  if (!rawRedirectUrl.startsWith('/') || rawRedirectUrl.startsWith('//')) {
    return '/setup';
  }

  return rawRedirectUrl;
}

function getAuthErrorMessage(
  error: { message?: string } | null | undefined,
  fallback: string,
): string {
  return error?.message || fallback;
}

export function AuthForm({
  enabledProviders = SOCIAL_PROVIDERS.map((provider) => provider.id),
  canSignUp = false,
  hideModeSwitchMessage = false,
  noticeMessage = null,
}: {
  enabledProviders?: AuthProvider[];
  /**
   * Whether the visitor is allowed to create an account with email and
   * password (they arrived with a usable invite, or the deployment is
   * bootstrapping). Provider buttons stay available either way so existing
   * users can sign in; the server enforces invite/org-membership checks for
   * new accounts on every method.
   */
  canSignUp?: boolean;
  hideModeSwitchMessage?: boolean;
  /**
   * Server-determined notice shown above the form (e.g. the deployment is at
   * its licensed seat limit). Stays visible across sign-in attempts, unlike
   * the per-attempt error state.
   */
  noticeMessage?: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectUrl = useMemo(
    () => getSafeRedirectUrl(searchParams.get('redirect_url')),
    [searchParams],
  );
  const enabledProviderSet = useMemo(
    () => new Set(enabledProviders),
    [enabledProviders],
  );
  const visibleProviders = SOCIAL_PROVIDERS.filter((provider) =>
    enabledProviderSet.has(provider.id),
  );

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submittingProvider, setSubmittingProvider] =
    useState<AuthProvider | null>(null);

  const handleSocialSignIn = async (provider: AuthProvider) => {
    setErrorMessage(null);
    setSubmittingProvider(provider);

    try {
      const callbackURL = getAuthProviderCallbackUrl(provider, redirectUrl);
      const result = await authClient.signIn.oauth2({
        providerId: provider === 'slack' ? provider : 'microsoft-entra-id',
        callbackURL,
      });

      if (result.error) {
        setErrorMessage(
          getAuthErrorMessage(
            result.error,
            `Unable to continue with ${provider}. Check the Roomote auth provider configuration.`,
          ),
        );
        return;
      }

      if (!result.data?.url) {
        router.replace(callbackURL);
        router.refresh();
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : `Unable to continue with ${provider}. Check the Roomote auth provider configuration.`,
      );
    } finally {
      setSubmittingProvider(null);
    }
  };

  return (
    <main className="flex w-full justify-center md:justify-start">
      <div className="relative w-full max-w-2xl space-y-6 py-2 text-left md:py-0">
        <h1 className="relative text-3xl font-bold tracking-tighter">
          <span className="relative flex items-center gap-3">
            <span className="absolute -left-6 hidden w-3 rounded-lg border border-foreground bg-accent-bright-foreground md:inline-block" />
            Hi there, welcome to Roomote.
          </span>
        </h1>
        <div className="max-w-xl space-y-4">
          <p>
            Sign in with your team&apos;s messaging tool. Email is available
            below.
          </p>

          <div className="space-y-2">
            <OriginMismatchAlert />
            {noticeMessage && (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertDescription>{noticeMessage}</AlertDescription>
              </Alert>
            )}
            {errorMessage && (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertDescription>{errorMessage}</AlertDescription>
              </Alert>
            )}
          </div>

          <div className="max-w-sm space-y-0.5">
            {visibleProviders.map((provider) => {
              const isSubmitting = submittingProvider === provider.id;

              return (
                <Button
                  className={cn(
                    'group flex h-auto w-full py-5',
                    'hover:bg-foreground hover:text-accent-foreground',
                  )}
                  disabled={isSubmitting}
                  key={provider.id}
                  onClick={() => void handleSocialSignIn(provider.id)}
                  type="button"
                >
                  <span className="flex min-w-0 grow items-center gap-2">
                    {isSubmitting ? (
                      <Spinner />
                    ) : (
                      <AuthProviderIcon provider={provider.icon} />
                    )}
                    <span className="grow truncate text-left font-medium">
                      Continue with {provider.label}
                    </span>
                  </span>
                  <ArrowRight />
                </Button>
              );
            })}
          </div>

          {visibleProviders.length > 0 && (
            <div className="flex max-w-sm items-center gap-3 py-1 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>
          )}

          <div className="max-w-sm">
            <EmailPasswordAuth
              redirectUrl={redirectUrl}
              allowSignUp={canSignUp}
              labelsAsPlaceholders={true}
              hideModeSwitchMessage={hideModeSwitchMessage}
              defaultMode={
                canSignUp && searchParams.get('invited') ? 'sign-up' : 'sign-in'
              }
              submitButtonClassName={cn(
                'h-auto w-full justify-between py-5',
                'hover:bg-foreground hover:text-accent-foreground',
              )}
            />
          </div>
        </div>
      </div>
    </main>
  );
}
