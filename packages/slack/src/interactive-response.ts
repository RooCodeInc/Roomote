import { slackFetch } from './slack-api-fetch';

export async function postSlackInteractiveResponse(
  responseUrl: string,
  body: Record<string, unknown>,
) {
  await slackFetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
