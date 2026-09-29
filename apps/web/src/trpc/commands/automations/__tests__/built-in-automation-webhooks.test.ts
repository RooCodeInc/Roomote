import type { UserAuthSuccess } from '@/types';

import {
  getBuiltInAutomationWebhookCommand,
  rotateBuiltInAutomationWebhookCommand,
  setBuiltInAutomationWebhookEnabledCommand,
} from '../built-in-automations';

const mocks = vi.hoisted(() => ({
  getAutomationByKey: vi.fn(),
  getWebhookState: vi.fn(),
  ensureWebhookToken: vi.fn(),
  setWebhookToken: vi.fn(),
  rotateWebhookToken: vi.fn(),
}));

vi.mock('@roomote/db/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('@roomote/db/server')>();
  return {
    ...original,
    getAutomationByKey: mocks.getAutomationByKey,
    getBackgroundAutomationWebhookState: mocks.getWebhookState,
    ensureBackgroundAutomationWebhookToken: mocks.ensureWebhookToken,
    setBackgroundAutomationWebhookToken: mocks.setWebhookToken,
    rotateBackgroundAutomationWebhookToken: mocks.rotateWebhookToken,
  };
});

vi.mock('@/lib/server/get-public-app-url', () => ({
  getPublicAppUrl: () => 'https://roomote.example',
}));

const adminAuth = {
  success: true,
  userType: 'user',
  userId: 'admin-1',
  name: 'Admin',
  primaryEmail: 'admin@example.com',
  isAdmin: true,
  anonymousAnalyticsEnabled: false,
  cloudEnabled: false,
  cookieConsentedAt: null,
  resource: {
    username: null,
    fullName: null,
    firstName: null,
    lastName: null,
    primaryEmailAddress: null,
    emailAddresses: [],
    imageUrl: '',
    createdAt: null,
  },
} satisfies UserAuthSuccess;

describe('built-in automation webhook settings', () => {
  let activeToken: string | null;

  beforeEach(() => {
    vi.clearAllMocks();
    activeToken = null;
    mocks.getAutomationByKey.mockResolvedValue({ enabled: true });
    mocks.getWebhookState.mockImplementation(async () => ({
      enabled: true,
      token: activeToken,
    }));
    mocks.ensureWebhookToken.mockImplementation(
      async (_key: string, token: string) => {
        activeToken ??= token;
        return activeToken;
      },
    );
    mocks.setWebhookToken.mockImplementation(
      async (_key: string, token: string | null) => {
        activeToken = token;
        return true;
      },
    );
    mocks.rotateWebhookToken.mockImplementation(
      async (_key: string, token: string) => {
        if (!activeToken) return null;
        activeToken = token;
        return token;
      },
    );
  });

  it('enables, rotates, disables, and hides the previous URL', async () => {
    const enabled = await setBuiltInAutomationWebhookEnabledCommand(adminAuth, {
      automationKey: 'suggester',
      enabled: true,
    });
    expect(enabled.url).toMatch(
      /^https:\/\/roomote\.example\/api\/webhooks\/built-in-automations\/suggester\/[A-Za-z0-9_-]{43}$/u,
    );
    const firstUrl = enabled.url;

    const rotated = await rotateBuiltInAutomationWebhookCommand(adminAuth, {
      automationKey: 'suggester',
    });
    expect(rotated.url).not.toBe(firstUrl);

    await setBuiltInAutomationWebhookEnabledCommand(adminAuth, {
      automationKey: 'suggester',
      enabled: false,
    });
    expect(activeToken).toBeNull();
    await expect(
      getBuiltInAutomationWebhookCommand(adminAuth, {
        automationKey: 'suggester',
      }),
    ).resolves.toEqual({ enabled: false, url: null });
  });

  it('rejects disabled and event-driven built-ins', async () => {
    mocks.getAutomationByKey.mockResolvedValueOnce({ enabled: false });
    await expect(
      setBuiltInAutomationWebhookEnabledCommand(adminAuth, {
        automationKey: 'suggester',
        enabled: true,
      }),
    ).rejects.toThrow('Enable the automation before enabling its webhook.');

    await expect(
      setBuiltInAutomationWebhookEnabledCommand(adminAuth, {
        automationKey: 'review_code' as never,
        enabled: true,
      }),
    ).rejects.toThrow('does not support webhooks');
  });
});
