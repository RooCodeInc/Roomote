import { parseMcpToolResult } from './mcp-tool-result';

describe('parseMcpToolResult', () => {
  it('classifies an error before considering structured content', () => {
    const result = {
      isError: true,
      structuredContent: {
        created_at: '',
        external_id: 0,
        id: '',
        mode: '',
        name: '',
        permalink: '',
        reference: '',
        reported_at: '',
        status: '',
      },
      content: [
        {
          type: 'text',
          text: 'missing_required_fields: severity_id is required because manual triage is disabled',
        },
      ],
    };

    expect(parseMcpToolResult(result)).toEqual({
      result,
      isError: true,
      errorText:
        'missing_required_fields: severity_id is required because manual triage is disabled',
      payload: null,
    });
  });

  it('prefers structured content for successful results', () => {
    const result = {
      structuredContent: { id: 'incident-1' },
      content: [{ type: 'text', text: 'ignored' }],
    };

    expect(parseMcpToolResult(result)).toMatchObject({
      isError: false,
      errorText: null,
      payload: { id: 'incident-1' },
    });
  });
});
