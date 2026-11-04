import { randomUUID } from 'node:crypto';
import {
  createMcpOAuthCode,
  getMcpOAuthCode,
  exchangeMcpOAuthCode,
  revokeMcpOAuthGrants,
} from '@roomote/redis';

const fixtureUsers = new Set<string>();
afterAll(async () => {
  for (const userId of fixtureUsers) await revokeMcpOAuthGrants(userId);
});

export async function oauthGrantFixture(userId: string, resource: string) {
  fixtureUsers.add(userId);
  const clientId = randomUUID();
  const code = await createMcpOAuthCode({
    userId,
    clientId,
    resource,
    scopes: ['mcp:roomote'],
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'fixture',
  });
  const grant = (await getMcpOAuthCode(code))!;
  await exchangeMcpOAuthCode(code, grant, true);
  return { clientId, grantId: grant.grantId };
}
