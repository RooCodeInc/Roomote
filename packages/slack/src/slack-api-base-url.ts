import { Env } from '@roomote/env';

const DEFAULT_SLACK_API_BASE_URL = 'https://slack.com/api/';

export function getSlackApiBaseUrl(): string {
  const configuredUrl = (
    process.env.SLACK_API_BASE_URL ??
    Env.SLACK_API_BASE_URL ??
    DEFAULT_SLACK_API_BASE_URL
  ).trim();

  return configuredUrl.endsWith('/') ? configuredUrl : `${configuredUrl}/`;
}

export function buildSlackApiUrl(path: string): string {
  return new URL(path, getSlackApiBaseUrl()).toString();
}
