import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import {
  BOT_FRAMEWORK_EXPECTED_ISSUER,
  verifyBotFrameworkJwt,
} from '../bot-framework-auth';

const SERVICE_URL = 'https://smba.trafficmanager.net/amer/';
const METADATA_URL = 'https://login.example.test/openid';
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

async function createSigningFixture(options: {
  kid: string;
  endorsements?: string[];
}) {
  const { publicKey, privateKey } = await generateKeyPair('RS256', {
    extractable: true,
  });
  const publicJwk = (await exportJWK(publicKey)) as JWK & {
    endorsements?: string[];
    kid?: string;
  };

  publicJwk.kid = options.kid;
  publicJwk.use = 'sig';
  publicJwk.alg = 'RS256';

  if (options.endorsements) {
    publicJwk.endorsements = options.endorsements;
  }

  return { privateKey, publicJwk };
}

async function signBotFrameworkJwt(input: {
  privateKey: SigningKey;
  kid: string;
  audience?: string;
  serviceUrl?: string;
  serviceUrlClaimName?: 'serviceUrl' | 'serviceurl';
}) {
  return new SignJWT({
    [input.serviceUrlClaimName ?? 'serviceUrl']:
      input.serviceUrl ?? SERVICE_URL,
  })
    .setProtectedHeader({ alg: 'RS256', kid: input.kid })
    .setIssuer(BOT_FRAMEWORK_EXPECTED_ISSUER)
    .setAudience(input.audience ?? 'bot-app-id')
    .setIssuedAt()
    .setNotBefore('-1 minute')
    .setExpirationTime('5 minutes')
    .sign(input.privateKey);
}

function createFetchMock(publicJwk: JWK, metadataUrl = METADATA_URL) {
  const jwksUrl = `${metadataUrl}/keys`;

  return vi.fn(async (input: string | URL) => {
    const url = input.toString();

    if (url === metadataUrl) {
      return new Response(
        JSON.stringify({
          issuer: BOT_FRAMEWORK_EXPECTED_ISSUER,
          jwks_uri: jwksUrl,
        }),
      );
    }

    if (url === jwksUrl) {
      return new Response(
        JSON.stringify({
          keys: [publicJwk],
        }),
      );
    }

    return new Response('not found', { status: 404 });
  });
}

describe('verifyBotFrameworkJwt', () => {
  it('verifies a Bot Framework JWT against OpenID metadata and serviceUrl', async () => {
    const fixture = await createSigningFixture({
      kid: 'teams-key-1',
      endorsements: ['msteams'],
    });
    const token = await signBotFrameworkJwt({
      privateKey: fixture.privateKey,
      kid: 'teams-key-1',
    });
    const fetchImpl = createFetchMock(fixture.publicJwk);

    await expect(
      verifyBotFrameworkJwt({
        authorizationHeader: `Bearer ${token}`,
        botAppId: 'bot-app-id',
        activityServiceUrl: SERVICE_URL,
        activityChannelId: 'msteams',
        metadataUrl: METADATA_URL,
        fetchImpl,
      }),
    ).resolves.toEqual({
      payload: expect.objectContaining({
        aud: 'bot-app-id',
        iss: BOT_FRAMEWORK_EXPECTED_ISSUER,
        serviceUrl: SERVICE_URL,
      }),
    });
  });

  it('rejects tokens with the wrong audience', async () => {
    const fixture = await createSigningFixture({ kid: 'teams-key-2' });
    const token = await signBotFrameworkJwt({
      privateKey: fixture.privateKey,
      kid: 'teams-key-2',
      audience: 'other-bot-app-id',
    });

    await expect(
      verifyBotFrameworkJwt({
        authorizationHeader: `Bearer ${token}`,
        botAppId: 'bot-app-id',
        activityServiceUrl: SERVICE_URL,
        activityChannelId: 'msteams',
        metadataUrl: `${METADATA_URL}/wrong-audience`,
        fetchImpl: createFetchMock(
          fixture.publicJwk,
          `${METADATA_URL}/wrong-audience`,
        ),
      }),
    ).rejects.toThrow();
  });

  it('accepts the lower-case serviceurl claim used by Bot Framework SDK constants', async () => {
    const fixture = await createSigningFixture({
      kid: 'teams-key-serviceurl',
      endorsements: ['msteams'],
    });
    const token = await signBotFrameworkJwt({
      privateKey: fixture.privateKey,
      kid: 'teams-key-serviceurl',
      serviceUrlClaimName: 'serviceurl',
    });

    await expect(
      verifyBotFrameworkJwt({
        authorizationHeader: `Bearer ${token}`,
        botAppId: 'bot-app-id',
        activityServiceUrl: SERVICE_URL,
        activityChannelId: 'msteams',
        metadataUrl: `${METADATA_URL}/lower-serviceurl`,
        fetchImpl: createFetchMock(
          fixture.publicJwk,
          `${METADATA_URL}/lower-serviceurl`,
        ),
      }),
    ).resolves.toEqual({
      payload: expect.objectContaining({
        aud: 'bot-app-id',
        iss: BOT_FRAMEWORK_EXPECTED_ISSUER,
        serviceurl: SERVICE_URL,
      }),
    });
  });

  it('rejects tokens whose serviceUrl claim does not match the activity', async () => {
    const fixture = await createSigningFixture({ kid: 'teams-key-3' });
    const token = await signBotFrameworkJwt({
      privateKey: fixture.privateKey,
      kid: 'teams-key-3',
      serviceUrl: 'https://smba.trafficmanager.net/emea/',
    });

    await expect(
      verifyBotFrameworkJwt({
        authorizationHeader: `Bearer ${token}`,
        botAppId: 'bot-app-id',
        activityServiceUrl: SERVICE_URL,
        activityChannelId: 'msteams',
        metadataUrl: `${METADATA_URL}/service-url`,
        fetchImpl: createFetchMock(
          fixture.publicJwk,
          `${METADATA_URL}/service-url`,
        ),
      }),
    ).rejects.toThrow(/serviceUrl/);
  });

  it('rejects keys that are not endorsed for the activity channel', async () => {
    const fixture = await createSigningFixture({
      kid: 'teams-key-4',
      endorsements: ['webchat'],
    });
    const token = await signBotFrameworkJwt({
      privateKey: fixture.privateKey,
      kid: 'teams-key-4',
    });

    await expect(
      verifyBotFrameworkJwt({
        authorizationHeader: `Bearer ${token}`,
        botAppId: 'bot-app-id',
        activityServiceUrl: SERVICE_URL,
        activityChannelId: 'msteams',
        metadataUrl: `${METADATA_URL}/endorsement`,
        fetchImpl: createFetchMock(
          fixture.publicJwk,
          `${METADATA_URL}/endorsement`,
        ),
      }),
    ).rejects.toThrow(/endorsed/);
  });
});
