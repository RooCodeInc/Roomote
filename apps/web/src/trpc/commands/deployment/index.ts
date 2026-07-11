import {
  assessBrowserOrigin,
  type BrowserOriginAssessment,
} from '@/lib/server/browser-origin-trust';
import { Env } from '@/lib/server/env';

/**
 * Public pre-auth diagnostic: tells the browser whether the auth layer will
 * accept requests from its origin, so the setup and sign-in pages can warn
 * about a misconfigured canonical URL before requests fail with 403.
 */
export function assessBrowserOriginCommand(input: {
  browserOrigin: string;
}): BrowserOriginAssessment {
  return assessBrowserOrigin({
    browserOrigin: input.browserOrigin,
    previewDomainsRaw: Env.PREVIEW_DOMAINS,
    roomoteAppUrl: Env.R_APP_URL,
  });
}
