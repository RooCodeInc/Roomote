const DEPLOYMENT_APP_NAME_MAX_LENGTH = 34;
const DEPLOYMENT_APP_NAME_PREFIX = 'roomote-';

export const DEPLOYMENT_APP_DESCRIPTION = 'Cloud coding agents for all';

/**
 * Build the shared default name used for deployment-owned provider apps.
 * GitHub's 34-character limit is the strictest supported limit, so keeping
 * the shared name within it produces the same name across providers.
 */
export function buildDeploymentAppName(publicOrigin: string): string {
  const host = new URL(publicOrigin).hostname
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!host) {
    return 'roomote';
  }

  const candidate = host.startsWith('roomote')
    ? host
    : `${DEPLOYMENT_APP_NAME_PREFIX}${host}`;

  return candidate.slice(0, DEPLOYMENT_APP_NAME_MAX_LENGTH).replace(/-+$/g, '');
}
