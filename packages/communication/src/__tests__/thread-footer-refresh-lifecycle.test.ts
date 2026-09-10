import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  db,
  eq,
  inArray,
  runFactory,
  sessionFactory,
  sessionTasks,
  sessions,
  taskFactory,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import { RunStatus } from '@roomote/types';

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    zadd: async () => 1,
    zrem: async () => 1,
    eval: async (
      script: string,
      count: number,
      key: string,
      ...args: string[]
    ) => {
      const owner = args[count - 1];
      if (store.get(key) !== owner) return 0;
      if (count === 2) {
        const [pointerKey, , value, ttl] = args;
        if (ttl !== 'keepTtl' || store.has(pointerKey!))
          store.set(pointerKey!, value!);
        return 1;
      }
      if (script.includes("'del'")) store.delete(key);
      return 1;
    },
  }),
}));
import { buildThreadReplyFooterText } from '../chat-messages';
import { setThreadReplyFooterRecord } from '../thread-reply-footer-state';
import { refreshManagedThreadReplyFooter } from '../thread-reply-footer-delivery';

describe('persisted latest-run lifecycle reaches the current carrier without another reply', () => {
  const taskIds: string[] = [];
  const sessionIds: string[] = [];
  afterEach(async () => {
    if (taskIds.length) {
      await db.delete(taskRuns).where(inArray(taskRuns.taskId, taskIds));
      await db
        .delete(sessionTasks)
        .where(inArray(sessionTasks.taskId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
      taskIds.length = 0;
    }
    if (sessionIds.length) {
      await db.delete(sessions).where(inArray(sessions.id, sessionIds));
      sessionIds.length = 0;
    }
    store.clear();
  });

  it.each(['task', 'sessions'])(
    'refreshes %s navigation through start, finish, fail, cancel, wait and a superseding run',
    async (navigation) => {
      const session = await sessionFactory.create();
      sessionIds.push(session.id);
      const task = await taskFactory.create({ state: 'active' });
      taskIds.push(task.id);
      await db.insert(sessionTasks).values({
        sessionId: session.id,
        taskId: task.id,
        origin: 'direct_launch',
      });
      await runFactory.create({ taskId: task.id, status: RunStatus.Running });
      const latest = await runFactory.create({
        taskId: task.id,
        status: RunStatus.Idle,
        taskPhase: 'waiting_for_prompt',
      });
      await setThreadReplyFooterRecord('discord', 'C', 'T', {
        messageId: 'current',
        textWithoutFooter: '> Quote\n\nOriginal body',
        refresh: {
          channelId: 'T',
          footerText: buildThreadReplyFooterText({
            taskUrl: new URL(
              `/${navigation}/${navigation === 'task' ? task.id : session.id}`,
              Env.R_APP_URL,
            ).toString(),
          }),
        },
      });
      const edit = vi.fn().mockResolvedValue(undefined);
      const tick = () =>
        refreshManagedThreadReplyFooter({
          provider: 'discord',
          channelId: 'C',
          threadId: 'T',
          edit,
        });
      await tick();
      expect(edit.mock.calls.at(-1)?.[1]).toContain('[No running tasks]');
      for (const status of [
        RunStatus.Running,
        RunStatus.Completed,
        RunStatus.Running,
        RunStatus.Failed,
        RunStatus.Running,
        RunStatus.Canceled,
        RunStatus.Running,
        RunStatus.Idle,
      ]) {
        await db
          .update(taskRuns)
          .set({
            status,
            taskPhase:
              status === RunStatus.Idle ? 'waiting_for_prompt' : 'running',
          })
          .where(eq(taskRuns.id, latest.id));
        await tick();
        expect(edit.mock.calls.at(-1)?.[1]).toContain(
          status === RunStatus.Running
            ? '[1 running task]'
            : '[No running tasks]',
        );
        expect(edit.mock.calls.at(-1)?.[0].messageId).toBe('current');
        expect(edit.mock.calls.at(-1)?.[1]).toContain(
          '> Quote\n\nOriginal body',
        );
      }
      await db
        .update(taskRuns)
        .set({ status: RunStatus.Running, taskPhase: 'running' })
        .where(eq(taskRuns.id, latest.id));
      await tick();
      await runFactory.create({
        taskId: task.id,
        status: RunStatus.Idle,
        taskPhase: 'waiting_for_prompt',
      });
      await tick();
      expect(edit.mock.calls.at(-1)?.[1]).toContain('[No running tasks]');
      const count = edit.mock.calls.length;
      await tick();
      expect(edit).toHaveBeenCalledTimes(count);
    },
  );
});
