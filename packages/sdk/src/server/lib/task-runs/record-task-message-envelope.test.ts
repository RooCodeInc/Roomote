import type { AcpPersistedEnvelope } from '@roomote/types';

import { sanitizePrivatePersonalizationEnvelope } from './record-task-message-envelope';

function envelope(payload: Record<string, unknown>): AcpPersistedEnvelope {
  return {
    ts: 1,
    eventType: 'roomote_runtime.tool_call',
    role: 'tool',
    protocol: 'roomote_runtime',
    contentBlocks: [{ type: 'text', text: 'PRIVATE_SENTINEL' }],
    metadata: null,
    payload,
  };
}

describe('personalization transcript privacy', () => {
  it.each([
    { toolName: 'update_personalization' },
    {
      update: {
        mcpToolName: 'roomote_update_personalization',
        rawInput: { arguments: { preference: 'PRIVATE_SENTINEL' } },
      },
    },
  ])('removes private arguments before persistence', (payload) => {
    const sanitized = sanitizePrivatePersonalizationEnvelope(envelope(payload));
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain('PRIVATE_SENTINEL');
    expect(sanitized.metadata).toMatchObject({ visibleInTranscript: false });
    expect(sanitized.payload).toMatchObject({ private: true });
  });

  it('leaves ordinary tool payloads intact', () => {
    const original = envelope({
      toolName: 'read',
      rawInput: { arguments: { path: 'README.md' } },
    });

    expect(sanitizePrivatePersonalizationEnvelope(original).payload).toEqual(
      original.payload,
    );
  });
});
