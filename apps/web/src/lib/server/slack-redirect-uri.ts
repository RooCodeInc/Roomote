import { SLACK_APP_INSTALL_CALLBACK_PATH } from '@/lib/slack-callback-paths';

import { Env } from './env';
import { getPublicAppUrl } from './get-public-app-url';

export function getSlackRedirectUri(): string {
  const configuredUri = Env.SLACK_REDIRECT_URI.trim();

  if (configuredUri) {
    return configuredUri;
  }

  return new URL(
    SLACK_APP_INSTALL_CALLBACK_PATH,
    getPublicAppUrl(Env),
  ).toString();
}
