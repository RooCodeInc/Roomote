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

  it('preserves mixed text and image content when no structured payload exists', () => {
    const content = [
      { type: 'text', text: 'Image fetched successfully' },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
    ];

    expect(parseMcpToolResult({ content })).toMatchObject({
      isError: false,
      errorText: null,
      payload: content,
    });
  });

  it('combines image bytes with structured image metadata', () => {
    const result = {
      structuredContent: {
        kind: 'image',
        url: 'https://example.com/image.png',
      },
      content: [
        { type: 'text', text: 'Image fetched successfully' },
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      ],
    };

    expect(parseMcpToolResult(result)).toMatchObject({
      payload: {
        kind: 'image',
        url: 'https://example.com/image.png',
        data: 'aW1hZ2U=',
        mimeType: 'image/png',
      },
    });
  });

  it('preserves fetched text alongside structured text metadata', () => {
    const result = {
      structuredContent: { kind: 'text', format: 'markdown' },
      content: [{ type: 'text', text: '# Fetched page' }],
    };

    expect(parseMcpToolResult(result)).toMatchObject({
      payload: {
        kind: 'text',
        format: 'markdown',
        text: '# Fetched page',
      },
    });
  });
});
