import type { Metadata } from 'next';

import { canVisitorSignUp } from '@/lib/server/access-policy';
import { getSignedInAuthContext } from '@/lib/server/auth-context';
import { resolveAuthProviderConfig } from '@/lib/server/auth-provider-config';
import { PAGE_METADATA } from '@/lib/metadata';

import { type AuthProvider } from '../../auth-form';
import { SignInPageClient } from './page.client';

async function getConfiguredAuthProviders(): Promise<AuthProvider[]> {
  const config = await resolveAuthProviderConfig();
  return config.enabledProviders;
}

function hasInvitedParam(invited: string | string[] | undefined): boolean {
  if (Array.isArray(invited)) {
    return invited.some((value) => value.length > 0);
  }
  return typeof invited === 'string' && invited.length > 0;
}

export async function generateMetadata(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const searchParams = await props.searchParams;
  // Match auth-form defaultMode: any non-empty `invited` query starts sign-up.
  return hasInvitedParam(searchParams.invited)
    ? PAGE_METADATA.signUp
    : PAGE_METADATA.logIn;
}

export default async function Page() {
  // Resolving the provider config first also bootstraps the web runtime env,
  // which canVisitorSignUp() needs before it can query the database.
  const enabledProviders = await getConfiguredAuthProviders();
  // Whether the visitor arrived with a usable invite (the /invite/<token>
  // route stores it in the invite cookie) or bootstrap rights; without one,
  // the form offers sign-in only and account creation stays hidden.
  const canSignUp = await canVisitorSignUp();
  // A visitor bounced here by the seat gate still holds their Better Auth
  // session cookie, so re-running the auth evaluation identifies them and
  // lets the form explain the rejection instead of silently offering
  // sign-in again.
  const authContext = await getSignedInAuthContext();
  const seatLimitBlocked =
    !authContext.success && authContext.reason === 'seat_limit';

  return (
    <SignInPageClient
      enabledProviders={enabledProviders}
      canSignUp={canSignUp}
      seatLimitBlocked={seatLimitBlocked}
    />
  );
}
