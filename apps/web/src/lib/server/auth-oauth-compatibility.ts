import type { BetterAuthPlugin } from 'better-auth';
import {
  addOAuthServerContext,
  createAuthMiddleware,
  getOAuthState,
  getSessionFromCtx,
} from 'better-auth/api';
import type { OAuthProvider } from 'better-auth/oauth2';
import { verifyProviderIdToken } from 'better-auth/oauth2';
import { microsoft } from 'better-auth/social-providers';

export const MICROSOFT_ENTRA_PROVIDER_ID = 'microsoft-entra-id';

// Providers registered with the legacy generic-OAuth callback URL whose
// profiles may carry placeholder or unverified emails.
const PROVIDER_IDS = new Set([
  'slack',
  MICROSOFT_ENTRA_PROVIDER_ID,
  'gitlab',
  'gitea',
  'bitbucket',
  'ado',
]);

type ProviderTokens = Parameters<OAuthProvider['getUserInfo']>[0];
type ProviderUserInfo = NonNullable<
  Awaited<ReturnType<OAuthProvider['getUserInfo']>>
>;

// The built-in Microsoft helper decodes the ID token without verifying it.
// Verify it first (signature, issuer, audience, expiry, tenant, nonce), then
// bind the old helper's OIDC userinfo profile (name, preferred_username and
// optional email_verified) to the verified subject.
async function verifyMicrosoftProfile(
  provider: OAuthProvider,
  tokens: ProviderTokens,
): Promise<ProviderUserInfo | null> {
  if (
    !tokens.idToken ||
    !(await verifyProviderIdToken(
      provider,
      tokens.idToken,
      tokens.expectedIdTokenNonce,
    ))
  )
    return null;
  const info = await provider.getUserInfo(tokens);
  if (!info) return null;
  const response = await fetch('https://graph.microsoft.com/oidc/userinfo', {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  if (!response.ok) return null;
  const profile = (await response.json()) as {
    sub?: string;
    name?: string;
    given_name?: string;
    family_name?: string;
    email?: string;
    preferred_username?: string;
    picture?: string;
    email_verified?: boolean;
  };
  if (!('sub' in info.data) || profile.sub !== info.data.sub) return null;
  return {
    data: info.data,
    user: {
      name:
        profile.name ??
        (`${profile.given_name ?? ''} ${profile.family_name ?? ''}`.trim() ||
          undefined),
      email: profile.email ?? profile.preferred_username,
      image: profile.picture,
      emailVerified: profile.email_verified ?? false,
    },
  };
}

// Explicit linking is the only flow allowed to accept these providers'
// unverified or placeholder emails. Core's link flow only checks
// userInfo.emailVerified and never persists it, so marking the profile
// verified for a server-stamped explicit link lets that link proceed while
// sign-in keeps core's default policy: an unverified email can neither
// create a user implicitly linked by email nor attach itself to an existing
// user, and returning users still sign in by their linked identity.
async function applyExplicitLinkTrust(
  providerId: string,
  info: ProviderUserInfo,
): Promise<ProviderUserInfo> {
  const state = await getOAuthState();
  const marker = state?.serverContext?.roomoteExplicitLink;
  const explicitLink =
    !!state?.link &&
    !!marker &&
    typeof marker === 'object' &&
    'providerId' in marker &&
    marker.providerId === providerId &&
    'userId' in marker &&
    marker.userId === state.link.userId;
  return explicitLink
    ? { ...info, user: { ...info.user, emailVerified: true } }
    : info;
}

export function oauthCompatibilityPlugin(options?: {
  clientId: string;
  clientSecret: string;
  tenantId: string;
}): BetterAuthPlugin {
  return {
    id: 'roomote-oauth-compatibility',
    init(ctx) {
      const providers: OAuthProvider[] = [...ctx.socialProviders];
      if (options) {
        const provider = microsoft({
          ...options,
          disableDefaultScope: true,
          // offline_access stores an Entra refresh token so delegated
          // Microsoft Graph tokens (Teams history reads) can be minted later.
          scope: ['openid', 'profile', 'email', 'offline_access'],
          disableProfilePhoto: true,
        });
        providers.push({
          ...provider,
          id: MICROSOFT_ENTRA_PROVIDER_ID,
          requiresIdTokenNonce: true,
          // Existing accounts use the app-scoped OIDC subject, not Graph oid.
          // Keep all upstream signature, issuer, audience and tenant checks.
          accountSubject: ({ profile }) =>
            'sub' in profile && typeof profile.sub === 'string'
              ? profile.sub
              : '',
        });
      }
      return {
        context: {
          socialProviders: providers.map((provider) => ({
            ...provider,
            // Keep provider-registered URLs stable, including on dynamically
            // resolved preview hosts. Core composes the redirect URI for both
            // authorization and token exchange as baseURL + callbackPath.
            callbackPath: `/oauth2/callback/${provider.id}`,
            createAuthorizationURL: async (data) => {
              const url = await provider.createAuthorizationURL({
                ...data,
                // The Slack helper uses the authenticated userinfo endpoint,
                // and needs a fresh authorization nonce for every request.
                ...(provider.id === 'slack'
                  ? { idTokenNonce: data.idTokenNonce ?? crypto.randomUUID() }
                  : {}),
              });
              // The built-in Microsoft helper does not yet forward the core
              // nonce argument; bind its verified ID token to this flow too.
              if (
                provider.id === MICROSOFT_ENTRA_PROVIDER_ID &&
                data.idTokenNonce
              ) {
                url.searchParams.set('nonce', data.idTokenNonce);
              }
              return url;
            },
            getUserInfo: async (tokens) => {
              const info =
                provider.id === MICROSOFT_ENTRA_PROVIDER_ID
                  ? await verifyMicrosoftProfile(provider, tokens)
                  : await provider.getUserInfo(tokens);
              if (!info || !PROVIDER_IDS.has(provider.id)) return info;
              return applyExplicitLinkTrust(provider.id, info);
            },
          })),
        },
      };
    },
    hooks: {
      before: [
        {
          matcher: (ctx) =>
            ctx.path === '/link-social' && PROVIDER_IDS.has(ctx.body?.provider),
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if (session)
              await addOAuthServerContext({
                roomoteExplicitLink: {
                  providerId: ctx.body.provider,
                  userId: session.user.id,
                },
              });
          }),
        },
      ],
    },
  };
}

// Rewrites the registered legacy callback URL onto core's /callback/:id route
// before dispatch, so state and nonce validation still run in core. Core
// answers a form POST callback with a 302 to its own /api/auth/callback/:id,
// so that path is browser-visible and must stay reachable as well.
export function normalizeLegacyOAuthCallback(request: Request): Request {
  const url = new URL(request.url);
  const match = /^\/api\/auth\/oauth2\/callback\/([^/]+)$/.exec(url.pathname);
  if (!match || !PROVIDER_IDS.has(match[1]!)) return request;
  url.pathname = `/api/auth/callback/${match[1]}`;
  return new Request(url, request);
}
