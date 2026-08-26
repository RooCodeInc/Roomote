import { describe, expect, it } from 'vitest';

import { buildFastSessionReplyFooterText } from '../fast-session-footer';

describe('buildFastSessionReplyFooterText', () => {
  it.each(['slack', 'discord', 'teams', 'telegram'] as const)(
    'builds a provider-attributed Fast session link for %s',
    (provider) => {
      const footer = buildFastSessionReplyFooterText({
        provider,
        sessionId: '11111111-1111-4111-8111-111111111111',
      });

      expect(footer).toContain('Reply or use the');
      expect(footer).toContain(
        '/sessions/11111111-1111-4111-8111-111111111111',
      );
      expect(footer).toContain(`utm_source=${provider}`);
    },
  );
});
