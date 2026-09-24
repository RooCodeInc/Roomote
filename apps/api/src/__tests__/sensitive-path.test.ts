import {
  redactCustomAutomationWebhookPath,
  redactCustomAutomationWebhookUrl,
} from '../sensitive-path';

describe('custom automation webhook secret path redaction', () => {
  it('removes the bearer token from paths and URLs before telemetry or logging', () => {
    const token = 'opaque-token-value';
    const path = `/api/webhooks/custom-automations/automation-id/${token}`;
    const url = `https://roomote.example${path}?debug=1`;

    expect(redactCustomAutomationWebhookPath(path)).toBe(
      '/api/webhooks/custom-automations/automation-id/[redacted]',
    );
    expect(redactCustomAutomationWebhookUrl(url)).toBe(
      'https://roomote.example/api/webhooks/custom-automations/automation-id/[redacted]',
    );
  });
});
