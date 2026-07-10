import { Env } from '@roomote/env';

type UtmParams = {
  source: string;
  medium?: string;
  campaign: string;
};

function buildAppUrl(
  path: string,
  { source, medium = 'link', campaign }: UtmParams,
): string {
  return `${Env.ROOMOTE_APP_URL}${path}?utm_source=${source}&utm_medium=${medium}&utm_campaign=${encodeURIComponent(campaign)}`;
}

export function getTaskUrl({
  taskId,
  utm: { source, medium = 'link', campaign },
}: {
  taskId: string;
  utm: UtmParams;
}): string {
  return buildAppUrl(`/task/${taskId}`, { source, medium, campaign });
}
