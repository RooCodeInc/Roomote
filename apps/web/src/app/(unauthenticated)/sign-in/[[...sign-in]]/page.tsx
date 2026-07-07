import { canVisitorSignUp } from '@/lib/server/access-policy';
import { getSignedInAuthContext } from '@/lib/server/auth-context';
import { resolveAuthProviderConfig } from '@/lib/server/auth-provider-config';

import { type AuthProvider } from '../../auth-form';
import { SignInPageClient } from './page.client';

async function getConfiguredAuthProviders(): Promise<AuthProvider[]> {
  const config = await resolveAuthProviderConfig();
  return config.enabledProviders;
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
