const { authorizeMock, notFoundMock } = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  notFoundMock: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/navigation', () => ({ notFound: notFoundMock }));
vi.mock('@/lib/server/auth-context', () => ({ authorize: authorizeMock }));
vi.mock('@/components/settings/pages/NightlyExperimentsPage', () => ({
  NightlyExperimentsPage: () => <div>nightly settings</div>,
}));

import Page from './page';

describe('Nightly Experiments route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['signed out', { success: false, error: 'Unauthenticated' }],
    [
      'not an admin',
      { success: true, isAdmin: false, nightlyExperimentsEnabled: true },
    ],
    [
      'not opted in by the deployment',
      { success: true, isAdmin: true, nightlyExperimentsEnabled: false },
    ],
  ])('returns not found when the requester is %s', async (_reason, auth) => {
    authorizeMock.mockResolvedValue(auth);

    await expect(Page()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundMock).toHaveBeenCalledOnce();
  });

  it('renders the settings page only for opted-in admins', async () => {
    authorizeMock.mockResolvedValue({
      success: true,
      isAdmin: true,
      nightlyExperimentsEnabled: true,
    });

    const page = await Page();

    expect(page).toBeDefined();
    expect(notFoundMock).not.toHaveBeenCalled();
  });
});
