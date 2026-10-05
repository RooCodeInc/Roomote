import type { UserAuthSuccess } from '@/types';

import {
  getCustomAutomationWebhookCommand,
  rotateCustomAutomationWebhookCommand,
  setCustomAutomationWebhookEnabledCommand,
} from '../custom-automations';

const mocks = vi.hoisted(() => ({
  getCustomAutomationById: vi.fn(),
  getWebhookState: vi.fn(),
  ensureWebhookToken: vi.fn(),
  setWebhookToken: vi.fn(),
  rotateWebhookToken: vi.fn(),
  findOwner: vi.fn(),
}));

vi.mock('@roomote/db/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('@roomote/db/server')>();
  return {
    ...original,
    db: {
      ...original.db,
      query: {
        ...original.db.query,
        users: { findFirst: mocks.findOwner },
      },
    },
    getCustomAutomationById: mocks.getCustomAutomationById,
    getCustomAutomationWebhookState: mocks.getWebhookState,
    ensureCustomAutomationWebhookToken: mocks.ensureWebhookToken,
    rotateCustomAutomationWebhookToken: mocks.rotateWebhookToken,
    setCustomAutomationWebhookToken: mocks.setWebhookToken,
  };
});

vi.mock('@/lib/server/get-public-app-url', () => ({
  getPublicAppUrl: () => 'https://roomote.example',
}));

const adminAuth = {
  success: true,
  userType: 'user',
  userId: 'owner-1',
  name: 'Owner',
  primaryEmail: 'owner@example.com',
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

const automation = {
  id: '11111111-1111-4111-8111-111111111111',
  enabled: true,
  createdByUserId: 'owner-1',
};

describe('custom automation webhook settings', () => {
  let activeToken: string | null;

  beforeEach(() => {
    vi.clearAllMocks();
    activeToken = null;
    mocks.getCustomAutomationById.mockResolvedValue(automation);
    mocks.findOwner.mockResolvedValue({ id: 'owner-1' });
    mocks.getWebhookState.mockImplementation(async () => ({
      enabled: true,
      createdByUserId: automation.createdByUserId,
      token: activeToken,
    }));
    mocks.ensureWebhookToken.mockImplementation(
      async (_id: string, token: string) => {
        activeToken ??= token;
        return activeToken;
      },
    );
    mocks.setWebhookToken.mockImplementation(
      async (_id: string, token: string | null) => {
        activeToken = token;
        return true;
      },
    );
    mocks.rotateWebhookToken.mockImplementation(
      async (_id: string, token: string) => {
        if (!activeToken) return null;
        activeToken = token;
        return token;
      },
    );
  });

  it('enables, rotates, disables, and stops revealing the previous URL', async () => {
    const enabled = await setCustomAutomationWebhookEnabledCommand(adminAuth, {
      id: automation.id,
      enabled: true,
    });
    expect(enabled.enabled).toBe(true);
    expect(enabled.url).toMatch(
      /^https:\/\/roomote\.example\/api\/webhooks\/custom-automations\/[^/]+\/[A-Za-z0-9_-]{43}$/u,
    );
    const firstToken = activeToken;

    const rotated = await rotateCustomAutomationWebhookCommand(adminAuth, {
      id: automation.id,
    });
    expect(rotated.url).not.toBe(enabled.url);
    expect(activeToken).not.toBe(firstToken);
    expect(rotated.url).toContain(activeToken);

    await setCustomAutomationWebhookEnabledCommand(adminAuth, {
      id: automation.id,
      enabled: false,
    });
    expect(mocks.setWebhookToken).toHaveBeenLastCalledWith(automation.id, null);
    expect(activeToken).toBeNull();
    await expect(
      getCustomAutomationWebhookCommand(adminAuth, { id: automation.id }),
    ).resolves.toEqual({ enabled: false, url: null });
  });

  it('refuses to enable webhooks for disabled or ownerless automations', async () => {
    mocks.getCustomAutomationById.mockResolvedValueOnce({
      ...automation,
      enabled: false,
    });
    await expect(
      setCustomAutomationWebhookEnabledCommand(adminAuth, {
        id: automation.id,
        enabled: true,
      }),
    ).rejects.toThrow('Enable the automation before enabling its webhook.');

    mocks.getCustomAutomationById.mockResolvedValueOnce({
      ...automation,
      createdByUserId: null,
    });
    await expect(
      setCustomAutomationWebhookEnabledCommand(adminAuth, {
        id: automation.id,
        enabled: true,
      }),
    ).rejects.toThrow('Automation owner is not configured.');
  });

  it('does not return a new URL if disable wins the concurrent rotation race', async () => {
    activeToken = null;

    await expect(
      rotateCustomAutomationWebhookCommand(adminAuth, { id: automation.id }),
    ).rejects.toThrow(
      'Webhook is no longer enabled. Refresh settings and try again.',
    );
  });
});
