const { authorizeMock, notFoundMock } = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  notFoundMock: vi.fn(() => {
    throw new Error('Not found');
  }),
}));

vi.mock('@/lib/server/auth-context', () => ({ authorize: authorizeMock }));
vi.mock('next/navigation', () => ({ notFound: notFoundMock }));
vi.mock('@/components/settings/pages/SkillsSettingsPage', () => ({
  SkillsSettingsPage: () => null,
}));

import Page from './page';
import { SkillsSettingsPage } from '@/components/settings/pages/SkillsSettingsPage';

beforeEach(() => vi.clearAllMocks());

it.each([false, true])(
  'renders Skills for an authenticated user with isAdmin=%s',
  async (isAdmin) => {
    authorizeMock.mockResolvedValue({ success: true, isAdmin });
    expect(await Page()).toMatchObject({ type: SkillsSettingsPage });
    expect(notFoundMock).not.toHaveBeenCalled();
  },
);

it('denies unauthenticated access', async () => {
  authorizeMock.mockResolvedValue({ success: false });
  await expect(Page()).rejects.toThrow('Not found');
});
