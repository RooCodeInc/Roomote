const CUSTOM_AUTOMATION_WEBHOOK_PATH =
  /^\/api\/webhooks\/custom-automations\/([^/]+)\/[^/]+$/u;

export function redactCustomAutomationWebhookPath(path: string): string {
  return path.replace(
    CUSTOM_AUTOMATION_WEBHOOK_PATH,
    '/api/webhooks/custom-automations/$1/[redacted]',
  );
}

export function redactCustomAutomationWebhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return redactCustomAutomationWebhookPath(value);
  }

  const redactedPath = redactCustomAutomationWebhookPath(url.pathname);
  if (redactedPath !== url.pathname) {
    url.pathname = redactedPath;
    url.search = '';
    url.hash = '';
  }
  return url.toString();
}
