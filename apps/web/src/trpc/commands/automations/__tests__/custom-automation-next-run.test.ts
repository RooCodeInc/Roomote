import {
  createCustomAutomation,
  customAutomations,
  db,
  eq,
  userFactory,
  users,
} from '@roomote/db/server';
import { NO_REPOSITORIES } from '@roomote/types';
import type { UserAuthSuccess } from '@/types';
import { listCustomAutomationsCommand } from '../custom-automations';

const timezone = vi.hoisted(() => vi.fn());
vi.mock('@roomote/sdk/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/sdk/server')>()),
  resolveDeploymentTimeZone: timezone,
}));

it.each([
  [
    'America/New_York',
    '2026-10-01T05:00:00Z',
    '2026-10-08T06:15:00Z',
    '2026-10-08T07:00:00Z',
  ],
  [
    'Europe/Berlin',
    '2026-10-20T01:00:00Z',
    '2026-10-27T01:30:00Z',
    '2026-10-27T02:00:00Z',
  ],
])(
  'lists the first eligible weekly run in %s without changing its run history',
  async (timeZone, baseline, now, expected) => {
    timezone.mockClear();
    timezone.mockResolvedValue({
      timeZone,
      source: 'explicit',
      updatedAt: null,
    });
    const owner = await userFactory.create();
    let id: string | undefined;
    try {
      const row = await createCustomAutomation({
        name: `Next-run proof ${owner.id}`,
        prompt: 'Disposable scheduling fixture',
        enabled: true,
        scheduleMode: 'weekly',
        environmentId: NO_REPOSITORIES,
        target: {},
        createdByUserId: owner.id,
      });
      id = row.id;
      await db
        .update(customAutomations)
        .set({ lastRunAt: new Date(baseline) })
        .where(eq(customAutomations.id, id));
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(now));
      const rows = await listCustomAutomationsCommand({
        userId: owner.id,
        isAdmin: false,
      } as UserAuthSuccess);
      expect(timezone).toHaveBeenCalled();
      expect(
        rows.find((item) => item.id === id)?.nextRunAt?.toISOString(),
      ).toBe(new Date(expected).toISOString());
      const persisted = await db.query.customAutomations.findFirst({
        where: eq(customAutomations.id, id),
        columns: { lastRunAt: true, enabled: true, scheduleMode: true },
      });
      expect(persisted).toEqual({
        lastRunAt: new Date(baseline),
        enabled: true,
        scheduleMode: 'weekly',
      });
    } finally {
      vi.useRealTimers();
      if (id)
        await db.delete(customAutomations).where(eq(customAutomations.id, id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  },
);
