import { buildSlackApiUrl, getSlackApiBaseUrl } from '../slack-api-base-url';

describe('slack API base URL helpers', () => {
  const originalBaseUrl = process.env.R_SLACK_API_BASE_URL;

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env.R_SLACK_API_BASE_URL;
      return;
    }

    process.env.R_SLACK_API_BASE_URL = originalBaseUrl;
  });

  it('uses the configured base URL and normalizes the trailing slash', () => {
    process.env.R_SLACK_API_BASE_URL = 'http://127.0.0.1:3012/api';

    expect(getSlackApiBaseUrl()).toBe('http://127.0.0.1:3012/api/');
    expect(buildSlackApiUrl('chat.postMessage')).toBe(
      'http://127.0.0.1:3012/api/chat.postMessage',
    );
  });

  it('falls back to the default Slack API base URL when process.env is unset', () => {
    delete process.env.R_SLACK_API_BASE_URL;

    expect(getSlackApiBaseUrl()).toBe('https://slack.com/api/');
  });
});
