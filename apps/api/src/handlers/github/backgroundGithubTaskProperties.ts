import type { WebhookCloudTaskProperties } from './types';

export function getBackgroundGithubTaskProperties(
  properties: WebhookCloudTaskProperties,
): Omit<WebhookCloudTaskProperties, 'userId'> {
  const { userId: _linkedUserId, ...backgroundTaskProperties } = properties;
  return backgroundTaskProperties;
}
