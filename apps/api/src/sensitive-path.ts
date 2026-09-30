const AUTOMATION_WEBHOOK_PATH =
  /^\/api\/webhooks\/(custom-automations|built-in-automations)\/([^/]+)\/[^/]+$/u;

export function redactCustomAutomationWebhookPath(path: string): string {
  return path.replace(
    AUTOMATION_WEBHOOK_PATH,
    '/api/webhooks/$1/$2/[redacted]',
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
