import crypto from 'node:crypto';

type DiscordCredentialsResolver = () => Promise<{
  botToken?: string | null;
  token?: string | null;
}>;

export type DiscordGatewayCredentials = {
  botToken: string;
  tokenFingerprint: string;
};

function normalizeBotToken(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value
    .trim()
    .replace(/^Bot\s+/iu, '')
    .replace(/\s+/gu, '');
  return normalized || null;
}

export async function resolveDiscordGatewayCredentials(): Promise<DiscordGatewayCredentials | null> {
  const environmentToken = normalizeBotToken(process.env.R_DISCORD_BOT_TOKEN);
  let botToken = environmentToken;

  if (!botToken) {
    // The server export is the credential boundary shared with API/web. Keep
    // the import tolerant during rolling deploys where the gateway image can
    // be newer than the database package loaded by another control-plane app.
    const dbServer = (await import('@roomote/db/server')) as unknown as {
      resolveDiscordRuntimeCredentials?: DiscordCredentialsResolver;
    };
    const resolver = dbServer.resolveDiscordRuntimeCredentials;

    if (resolver) {
      const credentials = await resolver();
      botToken = normalizeBotToken(
        credentials.botToken ?? credentials.token ?? null,
      );
    }
  }

  if (!botToken) {
    return null;
  }

  return {
    botToken,
    tokenFingerprint: crypto
      .createHash('sha256')
      .update(botToken)
      .digest('hex'),
  };
}
