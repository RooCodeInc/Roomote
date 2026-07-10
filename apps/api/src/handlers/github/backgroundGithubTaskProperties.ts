import type { WebhookTaskProperties } from './types';

export function getBackgroundGithubTaskProperties(
  properties: WebhookTaskProperties,
): Omit<WebhookTaskProperties, 'userId'> {
  const { userId: _linkedUserId, ...backgroundTaskProperties } = properties;
  return backgroundTaskProperties;
}
