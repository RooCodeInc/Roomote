import crypto from 'node:crypto';

import { resolveDiscordGatewayCredentials } from './credentials';

describe('resolveDiscordGatewayCredentials', () => {
  const originalToken = process.env.R_DISCORD_BOT_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.R_DISCORD_BOT_TOKEN;
    } else {
      process.env.R_DISCORD_BOT_TOKEN = originalToken;
    }
  });

  it('normalizes an optional Bot prefix and uses a stable full fingerprint', async () => {
    process.env.R_DISCORD_BOT_TOKEN = ' Bot abc.def.ghi\n';

    await expect(resolveDiscordGatewayCredentials()).resolves.toEqual({
      botToken: 'abc.def.ghi',
      tokenFingerprint: crypto
        .createHash('sha256')
        .update('abc.def.ghi')
        .digest('hex'),
    });
  });
});
