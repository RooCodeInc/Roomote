import { render, waitFor } from '@testing-library/react';

const { useUserMock, setUserMock } = vi.hoisted(() => ({
  useUserMock: vi.fn(),
  setUserMock: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({
  setUser: (...args: unknown[]) => setUserMock(...args),
}));

vi.mock('@/hooks/useUser', () => ({
  useUser: () => useUserMock(),
}));

import { UserAnalyticsContext } from './UserAnalyticsContext';

describe('UserAnalyticsContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    useUserMock.mockReturnValue({
      authStatus: 'signed-in',
      isSignedIn: true,
      user: {
        userId: 'user-123',
        name: 'Test User',
        primaryEmail: 'test@example.com',
        isAdmin: true,
        featureFlags: {},
        resource: {
          username: 'test-user',
          fullName: 'Test User',
          firstName: 'Test',
          lastName: 'User',
          primaryEmailAddress: {
            id: 'email-1',
            emailAddress: 'test@example.com',
          },
          emailAddresses: [
            {
              id: 'email-1',
              emailAddress: 'test@example.com',
            },
          ],
          imageUrl: 'https://example.com/avatar.png',
          createdAt: new Date('2026-06-19T00:00:00.000Z'),
        },
      },
    });
  });

  it('sets the user in Sentry', async () => {
    render(<UserAnalyticsContext />);

    await waitFor(() =>
      expect(setUserMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'user-123',
        }),
      ),
    );
  });
});
