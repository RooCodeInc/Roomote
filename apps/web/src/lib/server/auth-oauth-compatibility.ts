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
import { and, authAccounts, authUsers, db, eq } from '@roomote/db/server';

const PROVIDERS = new Set([
  'slack',
  'microsoft-entra-id',
  'gitlab',
  'gitea',
  'bitbucket',
  'ado',
]);
export const EXPLICIT_LINK_PROVIDERS = [
  'gitlab',
  'gitea',
  'bitbucket',
  'ado',
  'slack',
  'microsoft-entra-id',
];

// Keep provider-registered URLs stable, including on dynamically resolved
// preview hosts. Both authorization and token exchange must use this URL.
function legacyCallback(redirectURI: string) {
  const url = new URL(redirectURI);
  url.pathname = url.pathname.replace(
    '/api/auth/callback/',
    '/api/auth/oauth2/callback/',
  );
  return url.toString();
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
          scope: ['openid', 'profile', 'email', 'offline_access'],
          disableProfilePhoto: true,
        });
        providers.push({
          ...provider,
          id: 'microsoft-entra-id',
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
            createAuthorizationURL: async (data) => {
              const url = await provider.createAuthorizationURL({
                ...data,
                redirectURI: legacyCallback(data.redirectURI),
                // The Slack helper uses the authenticated userinfo endpoint,
                // and needs a fresh authorization nonce for every request.
                ...(provider.id === 'slack'
                  ? { idTokenNonce: data.idTokenNonce ?? crypto.randomUUID() }
                  : {}),
              });
              // The built-in Microsoft helper does not yet forward the core
              // nonce argument; bind its verified ID token to this flow too.
              if (provider.id === 'microsoft-entra-id' && data.idTokenNonce) {
                url.searchParams.set('nonce', data.idTokenNonce);
              }
              return url;
            },
            validateAuthorizationCode: (data) =>
              provider.validateAuthorizationCode({
                ...data,
                redirectURI: legacyCallback(data.redirectURI),
              }),
            getUserInfo: async (tokens) => {
              if (
                provider.id === 'microsoft-entra-id' &&
                (!tokens.idToken ||
                  !(await verifyProviderIdToken(
                    provider,
                    tokens.idToken,
                    tokens.expectedIdTokenNonce,
                  )))
              )
                return null;
              let info = await provider.getUserInfo(tokens);
              if (!info) return null;
              if (provider.id === 'microsoft-entra-id') {
                // Preserve the old helper's OIDC userinfo profile (including
                // preferred_username and optional email_verified), but bind it
                // to the subject from the ID token verified above.
                const response = await fetch(
                  'https://graph.microsoft.com/oidc/userinfo',
                  {
                    headers: { Authorization: `Bearer ${tokens.accessToken}` },
                  },
                );
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
                if (!('sub' in info.data) || profile.sub !== info.data.sub)
                  return null;
                info = {
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
              if (EXPLICIT_LINK_PROVIDERS.includes(provider.id)) {
                const state = await getOAuthState();
                // These providers may return placeholder/unverified emails.
                // Trust them only for a session-authorized explicit link,
                // never as evidence for implicit email-based account linking.
                if (state) {
                  const marker = state.serverContext?.roomoteExplicitLink;
                  const explicitLink =
                    marker &&
                    typeof marker === 'object' &&
                    'providerId' in marker &&
                    marker.providerId === provider.id &&
                    'userId' in marker &&
                    marker.userId === state.link?.userId;
                  if (!explicitLink) {
                    if (
                      !state.link &&
                      (provider.id === 'slack' ||
                        provider.id === 'microsoft-entra-id')
                    ) {
                      // Normal sign-up remains available, and verified emails
                      // retain core's implicit-link policy. Unverified emails
                      // may only sign in by an already linked identity.
                      if (info.user.emailVerified) return info;
                      if (
                        info.user.email &&
                        !(await db.query.authUsers.findFirst({
                          where: eq(
                            authUsers.email,
                            info.user.email.toLowerCase(),
                          ),
                        }))
                      )
                        return info;
                    }
                    // Existing provider identities can still sign in, but an
                    // unlinked identity cannot attach itself by email.
                    if (state.link || !provider.accountSubject) return null;
                    const accountId = await provider.accountSubject({
                      tokens,
                      profile: info.data,
                    });
                    if (
                      typeof accountId !== 'string' &&
                      typeof accountId !== 'number'
                    )
                      return null;
                    const account = await db.query.authAccounts.findFirst({
                      where: and(
                        eq(authAccounts.providerId, provider.id),
                        eq(authAccounts.accountId, String(accountId)),
                      ),
                    });
                    if (!account) return null;
                  }
                }
              }
              return info;
            },
          })),
        },
      };
    },
    hooks: {
      before: [
        {
          matcher: (ctx) =>
            ctx.path === '/link-social' &&
            EXPLICIT_LINK_PROVIDERS.includes(ctx.body?.provider),
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

// Internal dispatch only: no browser redirect, so POST callbacks retain their
// form body and all upstream state/nonce validation still runs in core.
export function normalizeLegacyOAuthCallback(request: Request): Request {
  const url = new URL(request.url);
  const match = /^\/api\/auth\/oauth2\/callback\/([^/]+)$/.exec(url.pathname);
  if (!match || !PROVIDERS.has(match[1]!)) return request;
  url.pathname = `/api/auth/callback/${match[1]}`;
  return new Request(url, request);
}
