import { Env } from '@roomote/env';
import { isObservedTimeoutError } from '@roomote/types';

const { apiCallMock, WebClientMock } = vi.hoisted(() => ({
  apiCallMock: vi.fn(),
  WebClientMock: vi.fn().mockImplementation(function () {
    return {
      apiCall: apiCallMock,
    };
  }),
}));

vi.mock('@slack/web-api', () => ({
  WebClient: WebClientMock,
}));

import { createSlackWebClient } from '../web-client';

describe('createSlackWebClient', () => {
  const originalBaseUrl = process.env.R_SLACK_API_BASE_URL;

  beforeEach(() => {
    process.env.R_SLACK_API_BASE_URL = 'https://slack.com/api/';
    apiCallMock.mockReset();
    WebClientMock.mockClear();
  });

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env.R_SLACK_API_BASE_URL;
    } else {
      process.env.R_SLACK_API_BASE_URL = originalBaseUrl;
    }
    vi.restoreAllMocks();
  });

  it('wraps Slack Web API timeouts with source-rich errors', async () => {
    apiCallMock.mockRejectedValue(
      Object.assign(
        new Error('A request error occurred: timeout of 10000ms exceeded'),
        {
          code: 'slack_webapi_request_error',
          original: {
            code: 'ECONNABORTED',
            message: 'timeout of 10000ms exceeded',
            config: {
              url: 'https://slack.com/api/chat.postMessage?token=secret',
            },
          },
        },
      ),
    );
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const client = createSlackWebClient('xoxb-test');
    const caughtError = await client
      .apiCall('chat.postMessage')
      .catch((error: unknown) => error);

    expect(caughtError).toMatchObject({
      name: 'ObservedTimeoutError',
      source: 'slack-web-api',
      operation: 'apiCall(chat.postMessage)',
      method: 'POST',
      url: 'https://slack.com/api/chat.postMessage',
      timeoutMs: Env.R_SLACK_API_TIMEOUT_MS,
    });
    expect(isObservedTimeoutError(caughtError)).toBe(true);

    expect(WebClientMock).toHaveBeenCalledWith('xoxb-test', {
      slackApiUrl: 'https://slack.com/api/',
      timeout: Env.R_SLACK_API_TIMEOUT_MS,
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[Slack Web API Timeout]',
      expect.objectContaining({
        source: 'slack-web-api',
        operation: 'apiCall(chat.postMessage)',
        method: 'POST',
        url: 'https://slack.com/api/chat.postMessage',
        timeoutMs: Env.R_SLACK_API_TIMEOUT_MS,
      }),
    );
  });

  it('rethrows non-timeout Slack Web API errors unchanged', async () => {
    const error = new Error('invalid_auth');
    apiCallMock.mockRejectedValue(error);
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const client = createSlackWebClient('xoxb-test');

    await expect(client.apiCall('chat.postMessage')).rejects.toBe(error);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
