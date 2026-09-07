import { SLACK_MANIFEST_BOT_SCOPES } from './slack-app-manifest';

export function buildSlackInstallUrl({
  clientId,
  state,
  redirectUri,
}: {
  clientId: string;
  state: string;
  redirectUri: string;
}) {
  return `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${SLACK_MANIFEST_BOT_SCOPES.join(',')}&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
}
