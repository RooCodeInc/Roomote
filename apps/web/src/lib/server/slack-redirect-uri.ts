import { Env } from '@/lib/server';
import { SLACK_APP_INSTALL_CALLBACK_PATH } from '@/lib/slack-callback-paths';

export function getSlackRedirectUri(): string {
  const configuredUri = Env.R_SLACK_REDIRECT_URI.trim();

  if (configuredUri) {
    return configuredUri;
  }

  return new URL(SLACK_APP_INSTALL_CALLBACK_PATH, Env.R_APP_URL).toString();
}
