import {
  findSlackMcpSetupServicesInText,
  matchSlackMcpSetupServiceUrl,
} from '../mcp-service-detection';

describe('Slack MCP setup service detection', () => {
  it('matches Buildkite organization URLs from plain and Slack-formatted text', () => {
    expect(
      matchSlackMcpSetupServiceUrl(
        'https://buildkite.com/acme/pipelines/api/builds/42',
      )?.id,
    ).toBe('buildkite');

    expect(
      findSlackMcpSetupServicesInText(
        'Check <https://buildkite.com/acme/pipelines/api|this pipeline>.',
      ).map((service) => service.id),
    ).toEqual(['buildkite']);
    expect(
      findSlackMcpSetupServicesInText(
        'Check https://buildkite.com/acme/pipelines/api!!!!',
      ).map((service) => service.id),
    ).toEqual(['buildkite']);
  });

  it('does not match Buildkite public, API, or MCP URLs', () => {
    expect(
      matchSlackMcpSetupServiceUrl('https://buildkite.com/docs/pipelines'),
    ).toBeUndefined();
    expect(
      matchSlackMcpSetupServiceUrl('https://api.buildkite.com/v2/builds'),
    ).toBeUndefined();
    expect(
      matchSlackMcpSetupServiceUrl('https://mcp.buildkite.com/mcp/readonly'),
    ).toBeUndefined();
  });

  it('matches Cloudflare dashboard URLs from plain and Slack-formatted text', () => {
    expect(
      matchSlackMcpSetupServiceUrl(
        'https://dash.cloudflare.com/example/workers/services/view/api',
      )?.id,
    ).toBe('cloudflare');

    expect(
      findSlackMcpSetupServicesInText(
        'Check <https://dash.cloudflare.com/example/workers|this Worker>.',
      ).map((service) => service.id),
    ).toEqual(['cloudflare']);
    expect(
      findSlackMcpSetupServicesInText(
        'Check https://dash.cloudflare.com/example/workers!!!!',
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
