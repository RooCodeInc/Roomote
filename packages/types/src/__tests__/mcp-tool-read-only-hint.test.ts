import { readMcpToolReadOnlyHint } from '../mcp-response-parsing';

describe('readMcpToolReadOnlyHint', () => {
  it('returns the boolean hint the server declared', () => {
    expect(
      readMcpToolReadOnlyHint({
        name: 'search',
        annotations: { readOnlyHint: true },
      }),
    ).toBe(true);
    expect(
      readMcpToolReadOnlyHint({
        name: 'delete',
        annotations: { readOnlyHint: false, destructiveHint: true },
      }),
    ).toBe(false);
  });

  it('returns null when the server does not say, rather than guessing', () => {
    expect(readMcpToolReadOnlyHint({ name: 'search' })).toBeNull();
    expect(
      readMcpToolReadOnlyHint({ name: 'search', annotations: {} }),
    ).toBeNull();
    expect(
      readMcpToolReadOnlyHint({
        name: 'search',
        annotations: { readOnlyHint: 'yes' },
      }),
    ).toBeNull();
    expect(readMcpToolReadOnlyHint(null)).toBeNull();
  });
});
