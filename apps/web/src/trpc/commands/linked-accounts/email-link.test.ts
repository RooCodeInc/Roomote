import type { UserAuthSuccess } from '@/types';

const {
  mockVerifyAgentMailEmailLinkToken,
  mockRedispatchAgentMailEventsForSender,
  mockFindFirst,
  mockFindMany,
  mockAuthUserFindFirst,
  mockIsEmailChannelEnabled,
  mockAgentMailGetInbox,
  mockInsert,
  mockValues,
  mockOnConflictDoNothing,
  mockReturning,
} = vi.hoisted(() => {
  const mockReturning = vi.fn();
  const mockOnConflictDoNothing = vi.fn(() => ({ returning: mockReturning }));
  const mockValues = vi.fn(() => ({
    onConflictDoNothing: mockOnConflictDoNothing,
  }));
  const mockInsert = vi.fn(() => ({ values: mockValues }));

  return {
    mockVerifyAgentMailEmailLinkToken: vi.fn(),
    mockRedispatchAgentMailEventsForSender: vi.fn(),
    mockFindFirst: vi.fn(),
    mockFindMany: vi.fn(),
    mockAuthUserFindFirst: vi.fn(),
    mockIsEmailChannelEnabled: vi.fn(),
    mockAgentMailGetInbox: vi.fn(),
    mockInsert,
    mockValues,
    mockOnConflictDoNothing,
    mockReturning,
  };
});

vi.mock('@roomote/db/server', () => ({
  db: {
    insert: mockInsert,
    query: {
      agentmailUserMappings: {
        findFirst: mockFindFirst,
        findMany: mockFindMany,
      },
      authUsers: { findFirst: mockAuthUserFindFirst },
    },
  },
  agentmailUserMappings: {
    id: 'agentmail_user_mappings.id',
    emailAddress: 'agentmail_user_mappings.email_address',
    userId: 'agentmail_user_mappings.user_id',
    source: 'agentmail_user_mappings.source',
    createdAt: 'agentmail_user_mappings.created_at',
  },
  authUsers: { id: 'auth_users.id' },
  and: vi.fn((...conditions) => conditions),
  asc: vi.fn((column) => column),
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

vi.mock('@/lib/server/env', () => ({
  isEmailChannelEnabled: mockIsEmailChannelEnabled,
}));

vi.mock('@roomote/sdk/server', () => ({
  verifyAgentMailEmailLinkToken: mockVerifyAgentMailEmailLinkToken,
  redispatchAgentMailEventsForSender: mockRedispatchAgentMailEventsForSender,
}));

import {
  getLinkedEmailAccountsCommand,
  linkEmailAddressCommand,
  previewEmailLinkCommand,
} from './email-link';

const mockAuth = { userId: 'user-1' } as UserAuthSuccess;

describe('getLinkedEmailAccountsCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsEmailChannelEnabled.mockReturnValue(true);
    mockAuthUserFindFirst.mockResolvedValue({
      email: 'login@example.com',
      emailVerified: false,
    });
    mockFindMany.mockResolvedValue([{ emailAddress: 'sender@example.com' }]);
    mockAgentMailGetInbox.mockResolvedValue({
      inbox_id: 'routing-id',
      email: 'Deliverable@Example.com',
    });
  });

  it('keeps login verification and explicit sender links distinct', async () => {
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
      senderAddresses: ['sender@example.com'],
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

describe('previewEmailLinkCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the email address for a valid token', async () => {
    mockVerifyAgentMailEmailLinkToken.mockReturnValue({
      emailAddress: 'sender@example.com',
    });

    await expect(
      previewEmailLinkCommand(mockAuth, 'valid-token'),
    ).resolves.toEqual({ emailAddress: 'sender@example.com' });
  });

  it('rejects an invalid or expired token with a clear message', async () => {
    mockVerifyAgentMailEmailLinkToken.mockReturnValue(null);

    await expect(
      previewEmailLinkCommand(mockAuth, 'bad-token'),
    ).rejects.toThrow(
      'This link is invalid or has expired. Send another email to get a fresh link.',
    );
  });
});

describe('linkEmailAddressCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyAgentMailEmailLinkToken.mockReturnValue({
      emailAddress: 'sender@example.com',
    });
    mockReturning.mockResolvedValue([{ id: 'mapping-1' }]);
    mockRedispatchAgentMailEventsForSender.mockResolvedValue(2);
  });

  it('links the address and redispatches the refused emails', async () => {
    await expect(
      linkEmailAddressCommand(mockAuth, 'valid-token'),
    ).resolves.toEqual({
      emailAddress: 'sender@example.com',
      redispatchedCount: 2,
    });

    expect(mockValues).toHaveBeenCalledWith({
      emailAddress: 'sender@example.com',
      userId: 'user-1',
      source: 'link_code',
    });
    expect(mockOnConflictDoNothing).toHaveBeenCalledWith({
      target: 'agentmail_user_mappings.email_address',
    });
    expect(mockRedispatchAgentMailEventsForSender).toHaveBeenCalledWith(
      'sender@example.com',
    );
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it('treats relinking by the same user as success', async () => {
    mockReturning.mockResolvedValue([]);
    mockFindFirst.mockResolvedValue({ userId: 'user-1' });
    mockRedispatchAgentMailEventsForSender.mockResolvedValue(0);

    await expect(
      linkEmailAddressCommand(mockAuth, 'valid-token'),
    ).resolves.toEqual({
      emailAddress: 'sender@example.com',
      redispatchedCount: 0,
    });

    expect(mockRedispatchAgentMailEventsForSender).toHaveBeenCalledWith(
      'sender@example.com',
    );
  });

  it('rejects when the address is already linked to a different account', async () => {
    mockReturning.mockResolvedValue([]);
    mockFindFirst.mockResolvedValue({ userId: 'user-2' });

    await expect(
      linkEmailAddressCommand(mockAuth, 'valid-token'),
    ).rejects.toThrow(
      'This email address is already linked to a different Roomote account.',
    );

    expect(mockRedispatchAgentMailEventsForSender).not.toHaveBeenCalled();
  });

  it('rejects an invalid token without touching the database', async () => {
    mockVerifyAgentMailEmailLinkToken.mockReturnValue(null);

    await expect(
      linkEmailAddressCommand(mockAuth, 'bad-token'),
    ).rejects.toThrow(
      'This link is invalid or has expired. Send another email to get a fresh link.',
    );

    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockRedispatchAgentMailEventsForSender).not.toHaveBeenCalled();
  });
});
