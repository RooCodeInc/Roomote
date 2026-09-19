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
        'Check <https://buildkite.com/acme/pipelines/api|this pipeline>!!!!',
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
});
