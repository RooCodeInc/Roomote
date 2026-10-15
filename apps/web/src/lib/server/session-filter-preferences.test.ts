import { db, eq, userFactory, users } from '@roomote/db/server';

const { authorizeMock, revalidateMock } = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  revalidateMock: vi.fn(),
}));
vi.mock('@/lib/server/auth-context', () => ({ authorize: authorizeMock }));
vi.mock('next/cache', () => ({ revalidatePath: revalidateMock }));

import { saveSessionFilterPreferences } from '@/app/(authenticated)/sessions/filter-preference-actions';
import { getSessionFilterPreferences } from './session-filter-preferences';

describe('session list filter preferences', () => {
  it('restores selections for only their signed-in account and retains a reset across visits', async () => {
    const [first, second] = await Promise.all([
      userFactory.create({ metadata: { color_theme: 'dark' } }),
      userFactory.create(),
    ]);
    authorizeMock.mockResolvedValue({ success: true, userId: first.id });
    await saveSessionFilterPreferences(first.id, {
      scope: 'tasks',
      repository: 'env:fixture',
      pullRequest: '__has_pr__',
      before: 'stale',
      view: 'board',
    });
    expect(await getSessionFilterPreferences(first.id)).toEqual({
      scope: 'tasks',
      repository: 'env:fixture',
      pullRequest: '__has_pr__',
    });
    expect(await getSessionFilterPreferences(second.id)).toEqual({});
    expect(
      (await db.query.users.findFirst({ where: eq(users.id, first.id) }))
        ?.metadata,
    ).toEqual({
      color_theme: 'dark',
      session_list_filters_v1: {
        scope: 'tasks',
        repository: 'env:fixture',
        pullRequest: '__has_pr__',
      },
    });

    authorizeMock.mockResolvedValue({ success: true, userId: second.id });
    await saveSessionFilterPreferences(first.id, {
      q: 'delayed old account write',
    });
    expect(await getSessionFilterPreferences(second.id)).toEqual({});
    expect((await getSessionFilterPreferences(first.id)).scope).toBe('tasks');

    authorizeMock.mockResolvedValue({ success: true, userId: first.id });
    await saveSessionFilterPreferences(first.id, { scope: 'all' });
    expect(await getSessionFilterPreferences(first.id)).toEqual({});
    expect(revalidateMock).toHaveBeenCalledWith('/sessions', 'page');
  });

  it('rejects unauthenticated writes and ignores malformed or obsolete stored values', async () => {
    const user = await userFactory.create({
      metadata: {
        session_list_filters_v1: {
          status: 'invalid',
          scope: 'invalid',
          period: 'forever',
          archive: 'invalid',
          q: ['bad'],
          before: 'stale',
          source: 'web',
        },
      },
    });
    expect(await getSessionFilterPreferences(user.id)).toEqual({
      source: 'web',
    });
    authorizeMock.mockResolvedValue({ success: false });
    await saveSessionFilterPreferences(user.id, { scope: 'tasks' });
    expect(await getSessionFilterPreferences(user.id)).toEqual({
      source: 'web',
    });
  });
});
