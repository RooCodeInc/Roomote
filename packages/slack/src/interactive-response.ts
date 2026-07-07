export async function postSlackInteractiveResponse(
  responseUrl: string,
  body: Record<string, unknown>,
) {
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
