import type { UserAuthSuccess } from '@/types';

const {
  mockAuthUserFindFirst,
  mockIsEmailChannelEnabled,
  mockAgentMailGetInbox,
  mockRedisEval,
  mockHeaders,
  mockSendAuthenticatedVerificationEmail,
} = vi.hoisted(() => ({
  mockAuthUserFindFirst: vi.fn(),
  mockIsEmailChannelEnabled: vi.fn(),
  mockAgentMailGetInbox: vi.fn(),
  mockRedisEval: vi.fn(),
  mockHeaders: vi.fn(),
  mockSendAuthenticatedVerificationEmail: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      authUsers: { findFirst: mockAuthUserFindFirst },
    },
  },
  authUsers: { id: 'auth_users.id' },
  eq: vi.fn(),
  resolveAgentMailRuntimeCredentials: vi.fn(async () => ({
    apiKey: 'api-key',
    webhookSecret: 'webhook-secret',
    inboxId: 'roomote@example.com',
  })),
}));

vi.mock('@roomote/communication', () => ({
  AgentMailApiClient: class {
    getInbox = mockAgentMailGetInbox;
  },
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({ eval: mockRedisEval }),
}));

vi.mock('next/headers', () => ({
  headers: mockHeaders,
}));

vi.mock('@/lib/server/auth', () => ({
  sendAuthenticatedVerificationEmail: mockSendAuthenticatedVerificationEmail,
}));

vi.mock('@/lib/server/env', () => ({
  isEmailChannelEnabled: mockIsEmailChannelEnabled,
}));

import {
  getLinkedEmailAccountsCommand,
  resendPrimaryEmailVerificationCommand,
} from './email';

const mockAuth = { userId: 'user-1' } as UserAuthSuccess;

describe('getLinkedEmailAccountsCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsEmailChannelEnabled.mockReturnValue(true);
    mockAuthUserFindFirst.mockResolvedValue({
      email: 'login@example.com',
      emailVerified: false,
    });
    mockAgentMailGetInbox.mockResolvedValue({
      inbox_id: 'routing-id',
      email: 'Deliverable@Example.com',
    });
  });

  it('reports the login email verification status', async () => {
    await expect(
      getLinkedEmailAccountsCommand({
        ...mockAuth,
        isAdmin: true,
      }),
    ).resolves.toEqual({
      emailEnabled: true,
      verificationDeliveryAvailable: true,
      primaryEmail: {
        emailAddress: 'login@example.com',
        verified: false,
      },
      canViewInboxAddress: true,
      inboxEmail: 'deliverable@example.com',
    });
  });

  it('does not expose the deployment inbox address to non-admins', async () => {
    await expect(
      getLinkedEmailAccountsCommand({
        ...mockAuth,
        isAdmin: false,
      }),
    ).resolves.toMatchObject({
      canViewInboxAddress: false,
      inboxEmail: null,
      verificationDeliveryAvailable: true,
    });
  });

  it('reports an email-disabled deployment without inbox information', async () => {
    mockIsEmailChannelEnabled.mockReturnValue(false);

    await expect(
      getLinkedEmailAccountsCommand({
        ...mockAuth,
        isAdmin: true,
      }),
    ).resolves.toMatchObject({
      emailEnabled: false,
      verificationDeliveryAvailable: false,
      canViewInboxAddress: true,
      inboxEmail: null,
    });
  });

  it('omits the inbox address when AgentMail cannot resolve a deliverable email', async () => {
    mockAgentMailGetInbox.mockResolvedValue({ inbox_id: 'routing-id' });

    await expect(
      getLinkedEmailAccountsCommand({
        ...mockAuth,
        isAdmin: true,
      }),
    ).resolves.toMatchObject({
      verificationDeliveryAvailable: true,
      inboxEmail: null,
    });
  });
});

describe('resendPrimaryEmailVerificationCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisEval.mockResolvedValue(1);
    mockHeaders.mockResolvedValue(new Headers({ cookie: 'session=valid' }));
    mockSendAuthenticatedVerificationEmail.mockResolvedValue(undefined);
  });

  it('resends only the authenticated user login email', async () => {
    await expect(
      resendPrimaryEmailVerificationCommand({
        ...mockAuth,
        primaryEmail: 'login@example.com',
      }),
    ).resolves.toBeUndefined();

    expect(mockSendAuthenticatedVerificationEmail).toHaveBeenCalledWith({
      email: 'login@example.com',
      callbackURL: '/settings/personal',
      headers: expect.any(Headers),
    });
  });

  it('limits authenticated resend attempts to three per minute', async () => {
    mockRedisEval.mockResolvedValue(4);

    await expect(
      resendPrimaryEmailVerificationCommand({
        ...mockAuth,
        primaryEmail: 'login@example.com',
      }),
    ).rejects.toThrow('Too many verification requests');
    expect(mockSendAuthenticatedVerificationEmail).not.toHaveBeenCalled();
  });
});
