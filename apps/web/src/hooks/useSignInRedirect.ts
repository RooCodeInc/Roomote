'use client';

import { useEffect, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { useSetupBootstrapOpen } from './useUser';

function buildSignInRedirectUrl(relativePath: string): string {
  const params = new URLSearchParams({
    redirect_url: relativePath || '/',
  });

  return `/sign-in?${params.toString()}`;
}

function useSignInRedirectUrl(): string {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams?.toString();

  return useMemo(() => {
    const relativePath = `${pathname || '/'}${search ? `?${search}` : ''}`;

    return buildSignInRedirectUrl(relativePath);
  }, [pathname, search]);
}

export function useRedirectToSignIn(enabled: boolean): string {
  const router = useRouter();
  const signInUrl = useSignInRedirectUrl();
  const setupBootstrapOpen = useSetupBootstrapOpen();
  const redirectTarget = setupBootstrapOpen ? '/setup' : signInUrl;

  useEffect(() => {
    if (!enabled) {
      return;
    }

    router.replace(redirectTarget);
  }, [enabled, redirectTarget, router]);

  return redirectTarget;
}
