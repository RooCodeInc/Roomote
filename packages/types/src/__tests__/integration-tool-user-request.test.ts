import {
  INTEGRATION_TOOL_USER_REQUEST_MAX_CHARS,
  toIntegrationToolUserRequest,
} from '../integration-tool-approvals';

describe('toIntegrationToolUserRequest', () => {
  it('unwraps the task request envelope', () => {
    expect(
      toIntegrationToolUserRequest('<request>File the bug.</request>'),
    ).toBe('File the bug.');
    expect(
      toIntegrationToolUserRequest(
        '$triage\n<request>\nFile the bug.\n</request>',
      ),
    ).toBe('$triage\n\nFile the bug.');
  });

  it("strips Roomote's injected blocks", () => {
    expect(
      toIntegrationToolUserRequest(
        '<environment-instructions>Use pnpm.</environment-instructions>\n<workflow>Plan first.</workflow>\n<request>File the bug.</request>',
      ),
    ).toBe('File the bug.');
  });

  it('keeps a plain follow-up as written', () => {
    expect(toIntegrationToolUserRequest('  Now close it.  ')).toBe(
      'Now close it.',
    );
  });

  it('handles an unclosed run of request tags in linear time', () => {
    const started = performance.now();
    const request = toIntegrationToolUserRequest('<request>'.repeat(20_000));
    expect(performance.now() - started).toBeLessThan(200);
    expect(request?.startsWith('<request>')).toBe(true);
  });

  it('bounds the request and drops an empty one', () => {
    expect(toIntegrationToolUserRequest('x'.repeat(25_000))?.length).toBe(
      INTEGRATION_TOOL_USER_REQUEST_MAX_CHARS,
    );
    expect(
      toIntegrationToolUserRequest('<request> </request>'),
    ).toBeUndefined();
    expect(toIntegrationToolUserRequest(null)).toBeUndefined();
  });
});
