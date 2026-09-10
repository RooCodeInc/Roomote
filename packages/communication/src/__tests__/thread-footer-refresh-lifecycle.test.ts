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
import { resolveCurrentThreadFooter } from '../thread-footer-refresh';

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

  it('keeps a recent idle Session registered when a task starts after the first refresh', async () => {
    const session = await sessionFactory.create();
    sessionIds.push(session.id);
    const sessionUrl = new URL(
      `/sessions/${session.id}`,
      Env.R_APP_URL,
    ).toString();
    const footerText = buildThreadReplyFooterText({ taskUrl: sessionUrl });
    await setThreadReplyFooterRecord('discord', 'C', 'T', {
      messageId: 'current',
      textWithoutFooter: 'Original body',
      refresh: {
        channelId: 'T',
        footerText,
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

    await expect(tick()).resolves.toBe('idle');

    const task = await taskFactory.create({ state: 'active' });
    taskIds.push(task.id);
    await db.insert(sessionTasks).values({
      sessionId: session.id,
      taskId: task.id,
      origin: 'fast_delegation',
    });
    const run = await runFactory.create({
      taskId: task.id,
      status: RunStatus.Running,
      taskPhase: 'running',
    });

    await expect(tick()).resolves.toBe('active');
    expect(edit.mock.calls.at(-1)?.[1]).toContain('1 task running');
    await expect(
      resolveCurrentThreadFooter('slack', footerText),
    ).resolves.toEqual(
      expect.objectContaining({
        active: true,
        text: `Reply anytime · 1 task running · <${sessionUrl}|Open in Roomote>`,
      }),
    );

    await db
      .update(taskRuns)
      .set({ status: RunStatus.Completed })
      .where(eq(taskRuns.id, run.id));
    await expect(tick()).resolves.toBe('idle');
    expect(edit.mock.calls.at(-1)?.[1]).not.toContain('task running');
    await expect(
      resolveCurrentThreadFooter('slack', footerText),
    ).resolves.toEqual(
      expect.objectContaining({
        active: false,
        settled: false,
        text: `Reply anytime · <${sessionUrl}|Open in Roomote>`,
      }),
    );
  });

  it.each(['task', 'sessions'])(
    'refreshes %s navigation through lifecycle states and 2 -> 1 -> 0 running tasks',
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
      await expect(tick()).resolves.toBe('idle');
      expect(edit.mock.calls.at(-1)?.[1]).toContain(
        '-# Reply anytime · [Open in Roomote]',
      );
      expect(edit.mock.calls.at(-1)?.[1]).not.toContain('tasks running');
      expect(edit.mock.calls.at(-1)?.[1]).toContain('> Quote\n\nOriginal body');
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
        await expect(tick()).resolves.toBe(
          status === RunStatus.Running ? 'active' : 'idle',
        );
        if (status === RunStatus.Running) {
          expect(edit.mock.calls.at(-1)?.[1]).toContain('1 task running');
        } else {
          expect(edit.mock.calls.at(-1)?.[1]).not.toContain('task running');
        }
        expect(edit.mock.calls.at(-1)?.[1]).toContain(
          '> Quote\n\nOriginal body',
        );
      }
      await db
        .update(taskRuns)
        .set({ status: RunStatus.Running, taskPhase: 'running' })
        .where(eq(taskRuns.id, latest.id));
      await tick();
      const superseding = await runFactory.create({
        taskId: task.id,
        status: RunStatus.Idle,
        taskPhase: 'waiting_for_prompt',
      });
      await expect(tick()).resolves.toBe('idle');

      const secondTask = await taskFactory.create({ state: 'active' });
      taskIds.push(secondTask.id);
      await db.insert(sessionTasks).values({
        sessionId: session.id,
        taskId: secondTask.id,
        origin: 'fast_delegation',
      });
      const secondRun = await runFactory.create({
        taskId: secondTask.id,
        status: RunStatus.Running,
      });
      await db
        .update(taskRuns)
        .set({ status: RunStatus.Running, taskPhase: 'running' })
        .where(eq(taskRuns.id, superseding.id));

      await expect(tick()).resolves.toBe('active');
      expect(edit.mock.calls.at(-1)?.[1]).toContain('2 tasks running');
      expect(edit.mock.calls.at(-1)?.[1]).toContain('> Quote\n\nOriginal body');

      await db
        .update(taskRuns)
        .set({ status: RunStatus.Completed })
        .where(eq(taskRuns.id, superseding.id));
      await expect(tick()).resolves.toBe('active');
      expect(edit.mock.calls.at(-1)?.[1]).toContain('1 task running');
      expect(edit.mock.calls.at(-1)?.[0].messageId).toBe('current');

      await db
        .update(taskRuns)
        .set({ status: RunStatus.Completed })
        .where(eq(taskRuns.id, secondRun.id));
      await expect(tick()).resolves.toBe('idle');
      expect(edit.mock.calls.at(-1)?.[1]).not.toContain('task running');
      expect(edit.mock.calls.at(-1)?.[1]).toContain('> Quote\n\nOriginal body');
    },
  );
});
