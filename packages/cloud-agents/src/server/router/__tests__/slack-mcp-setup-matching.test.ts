vi.mock('@roomote/db/server', () => ({
  and: vi.fn(),
  db: {},
  eq: vi.fn(),
  isNull: vi.fn(),
  mcpConnections: {},
  deploymentMcpEnablements: {},
}));

import {
  extractUrlsFromSlackText,
  matchSlackMcpSetupService,
} from '../slack-mcp-setup';

function matchServiceIdForUrl(url: string): string | null {
  const [extracted] = extractUrlsFromSlackText(url);

  if (!extracted) {
    return null;
  }

  return matchSlackMcpSetupService(extracted)?.id ?? null;
}

describe('matchSlackMcpSetupService', () => {
  describe('zero', () => {
    it.each([
      'https://zero.xyz/c/stablephone-call-9dc16e0e',
      'https://www.zero.xyz/c/some-capability',
      'https://zero.xyz/browse',
      'https://zero.xyz/browse/audio',
      'https://www.zero.xyz/profile',
      'https://zero.xyz/profile/wallet',
      'https://mcp.zero.xyz',
      'https://mcp.zero.xyz/anything',
      'https://www.zero.xyz/',
      'https://zero.xyz',
      'https://withzero.ai/',
    ])('matches the Zero product surface or homepage %s', (url) => {
      expect(matchServiceIdForUrl(url)).toBe('zero');
    });

    it.each([
      'https://zero.xyz/faq',
      'https://zero.xyz/security',
      'https://zero.xyz/getlisted',
      'https://zero.xyz/terms-of-service',
      'https://zero.xyz/SKILL.md',
      'https://zero.xyz/browsers',
      'https://zero.xyz/customers',
      'https://withzero.ai/pricing',
    ])('does not match the deep marketing page %s', (url) => {
      expect(matchServiceIdForUrl(url)).toBeNull();
    });
  });

  describe('other services stay unaffected', () => {
    it.each([
      ['https://linear.app/acme/issue/OPS-123', 'linear'],
      ['https://acme.monday.com/boards/1234567890', 'monday'],
      ['https://acme.monday.com/boards/1234567890/pulses/9876543210', 'monday'],
      ['https://www.notion.so/acme/spec-123', 'notion'],
      ['https://acme.atlassian.net/browse/OPS-1', 'jira'],
      ['https://my-app.vercel.app/anything', 'vercel'],
      ['https://vercel.com/acme-team/my-app', 'vercel'],
      ['https://resend.com/emails/123', 'resend'],
      ['https://resend.com/domains/example.com', 'resend'],
      ['https://notes.granola.ai/d/meeting-id', 'granola'],
    ])('matches %s to %s', (url, serviceId) => {
      expect(matchServiceIdForUrl(url)).toBe(serviceId);
    });

    it.each([
      'https://vercel.com/pricing',
      'https://example.com/zero.xyz',
      'https://monday.com/pricing',
      'https://developer.monday.com/apps/docs/intro',
      'https://developer.monday.com/boards/1234567890',
      'https://mcp.monday.com/boards/1234567890',
      'https://resend.com/docs/mcp-server',
      'https://resend.com/pricing',
    ])('does not match %s', (url) => {
      expect(matchServiceIdForUrl(url)).toBeNull();
    });
  });
});

describe('extractUrlsFromSlackText', () => {
  it('extracts plain and Slack-formatted URLs with normalized host and path', () => {
    const urls = extractUrlsFromSlackText(
      'grab the favicon from https://www.zero.xyz/ and check [Zero](https://zero.xyz/c/ABC).',
    );

    expect(urls).toEqual([
      expect.objectContaining({ hostname: 'www.zero.xyz', pathname: '/' }),
      expect.objectContaining({ hostname: 'zero.xyz', pathname: '/c/abc' }),
    ]);
  });
});
