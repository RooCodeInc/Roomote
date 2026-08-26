import {
  createMemoryMcpInstructions,
  getMemoryMcpDisplayName,
  isMemoryMcpServer,
} from './memory-mcp';

describe('memory MCP task guidance', () => {
  it.each([
    ['gbrain', 'Brain'],
    ['supermemory', 'Supermemory'],
    ['team-memory', 'team-memory'],
    ['mem0', 'mem0'],
  ])('recognizes %s as memory', (serverId, displayName) => {
    expect(isMemoryMcpServer(serverId)).toBe(true);
    expect(getMemoryMcpDisplayName(serverId)).toBe(displayName);
  });

  it.each(['notion', 'braintrust', 'in-memory-cache', 'remember-the-milk'])(
    'does not infer memory behavior for %s',
    (serverId) => {
      expect(isMemoryMcpServer(serverId)).toBe(false);
    },
  );

  it('requires visible recall first and a durable write at completion', () => {
    const instructions = createMemoryMcpInstructions('supermemory');

    expect(instructions).toContain(
      'make one normal Supermemory tool call before any other context or work tool call',
    );
    expect(instructions).toContain(
      'first normal context or work tool call and remain visible in the session',
    );
    expect(instructions).toContain(
      'At task completion, proactively save concise durable learnings',
    );
    expect(instructions).toContain('If no memory-writing tool is available');
  });

  it('keeps an additional memory store from competing for the first call', () => {
    const instructions = createMemoryMcpInstructions('team-memory', {
      primary: false,
    });

    expect(instructions).toContain(
      'Another installed memory server owns the required initial recall',
    );
    expect(instructions).not.toContain(
      'first normal context or work tool call',
    );
    expect(instructions).toContain(
      'Do not duplicate the same learning across memory stores',
    );
  });
});
