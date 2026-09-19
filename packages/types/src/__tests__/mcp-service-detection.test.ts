import {
  findSlackMcpSetupServicesInText,
  matchSlackMcpSetupServiceUrl,
} from '../mcp-service-detection';

describe('Slack MCP setup service detection', () => {
  it('matches Cloudflare dashboard URLs from plain and Slack-formatted text', () => {
    expect(
      matchSlackMcpSetupServiceUrl(
        'https://dash.cloudflare.com/example/workers/services/view/api',
      )?.id,
    ).toBe('cloudflare');

    expect(
      findSlackMcpSetupServicesInText(
        'Check <https://dash.cloudflare.com/example/workers|this Worker>!!!!',
      ).map((service) => service.id),
    ).toEqual(['cloudflare']);
  });

  it('does not match unrelated or malformed URLs', () => {
    expect(
      matchSlackMcpSetupServiceUrl('https://developers.cloudflare.com/agents'),
    ).toBeUndefined();
    expect(matchSlackMcpSetupServiceUrl('not a URL')).toBeUndefined();
  });
});
