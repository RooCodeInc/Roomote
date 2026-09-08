import {
  configureAutomationWebhook,
  getAutomationWebhook,
  removeAutomationWebhook,
  retryAutomationWebhookDelivery,
} from '@roomote/sdk/server';
import { automationWebhookConfigSchema } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

import {
  configureAutomationWebhookCommand,
  getAutomationWebhookCommand,
  removeAutomationWebhookCommand,
  retryAutomationWebhookDeliveryCommand,
} from '../webhooks';

vi.mock('@roomote/sdk/server', () => ({
  configureAutomationWebhook: vi.fn(),
  getAutomationWebhook: vi.fn(),
  removeAutomationWebhook: vi.fn(),
  retryAutomationWebhookDelivery: vi.fn(),
}));

const auth: UserAuthSuccess = {
  success: true,
  userType: 'user',
  userId: 'authenticated-user',
  name: 'Member',
  primaryEmail: 'member@example.com',
  isAdmin: false,
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
};

const input = {
  automationId: '00000000-0000-4000-8000-000000000001',
  deliveryId: '00000000-0000-4000-8000-000000000002',
  config: automationWebhookConfigSchema.parse({}),
  userId: 'untrusted-user',
};

describe('automation webhook commands', () => {
  beforeEach(() => vi.resetAllMocks());
  it.each([undefined, false, true])(
    'forwards explicit removal opt-in %s',
    async (forceLocalRemoval) => {
      await removeAutomationWebhookCommand(auth, {
        automationId: input.automationId,
        forceLocalRemoval,
      });
      expect(removeAutomationWebhook).toHaveBeenCalledExactlyOnceWith(
        auth.userId,
        input.automationId,
        forceLocalRemoval,
      );
    },
  );

  it.each([
    [getAutomationWebhookCommand, getAutomationWebhook, [input.automationId]],
    [
      configureAutomationWebhookCommand,
      configureAutomationWebhook,
      [input.automationId, input.config],
    ],
    [
      removeAutomationWebhookCommand,
      removeAutomationWebhook,
      [input.automationId, undefined],
    ],
    [
      retryAutomationWebhookDeliveryCommand,
      retryAutomationWebhookDelivery,
      [input.automationId, input.deliveryId],
    ],
  ] as const)(
    'forwards authenticated identity and preserves service authorization for %s',
    async (command, service, expected) => {
      const denied = new Error('Unauthorized');
      vi.mocked(service).mockRejectedValueOnce(denied);

      await expect(command(auth, input)).rejects.toBe(denied);
      expect(service).toHaveBeenCalledExactlyOnceWith(auth.userId, ...expected);
    },
  );
});
