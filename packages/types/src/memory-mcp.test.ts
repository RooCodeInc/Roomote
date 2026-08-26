import {
  createMemoryMcpInstructions,
  getMemoryMcpDisplayName,
  isMemoryMcpServer,
} from './memory-mcp';
import { BRAIN_MCP_INSTRUCTIONS } from './brain';

describe('memory MCP task guidance', () => {
  it.each([
    ['gbrain', 'Brain'],
    ['supermemory', 'Supermemory'],
  ])('recognizes %s as memory', (serverId, displayName) => {
    expect(isMemoryMcpServer(serverId)).toBe(true);
    expect(getMemoryMcpDisplayName(serverId)).toBe(displayName);
  });

  it.each([
    'notion',
    'braintrust',
    'team-memory',
    'mem0',
    'in-memory-cache',
    'remember-the-milk',
  ])('does not infer memory behavior for %s', (serverId) => {
    expect(isMemoryMcpServer(serverId)).toBe(false);
  });

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

  it('appends the complete Brain contract when gbrain is primary', () => {
    const instructions = createMemoryMcpInstructions('gbrain');

    expect(instructions).toContain(
      'first normal context or work tool call and remain visible in the session',
    );
    expect(instructions.endsWith(BRAIN_MCP_INSTRUCTIONS)).toBe(true);
  });

  it('keeps provider-neutral instructions for non-Brain memory servers', () => {
    expect(createMemoryMcpInstructions('supermemory')).not.toContain(
      'Treat Brain recall as a sequential preflight',
    );
  });

  it('keeps an additional memory store from competing for the first call', () => {
    const instructions = createMemoryMcpInstructions('supermemory', {
      primary: false,
    });

    expect(instructions).toContain(
      'Another installed memory server owns the required initial recall',
    );
    expect(instructions).not.toContain(
      'first normal context or work tool call',
    );
    expect(instructions).not.toContain(
      'Treat Brain recall as a sequential preflight',
    );
    expect(instructions).toContain(
      'Do not duplicate the same learning across memory stores',
    );
  });
});
