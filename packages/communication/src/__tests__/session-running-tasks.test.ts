import { afterEach, describe, expect, it } from 'vitest';
import {
  db,
  eq,
  inArray,
  runFactory,
  sessionFactory,
  sessions,
  sessionTasks,
  taskFactory,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import { RunStatus } from '@roomote/types';

import { buildThreadReplyFooterText } from '../chat-messages';
import {
  resolveSessionRunningTasks,
  resolveThreadReplyFooterContext,
} from '../thread-reply-footer-context';

describe('Session running-task resolution with persisted runs', () => {
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
  });

  it('uses only this Session and each task latest run, retaining zero after history', async () => {
    const session = await sessionFactory.create();
    sessionIds.push(session.id);
    expect(await resolveSessionRunningTasks(session.id)).toBeNull();

    const first = await taskFactory.create({ state: 'active' });
    const second = await taskFactory.create({ state: 'active' });
    const unrelated = await taskFactory.create({ state: 'active' });
    taskIds.push(first.id, second.id, unrelated.id);
    await db.insert(sessionTasks).values([
      { sessionId: session.id, taskId: first.id, origin: 'direct_launch' },
      { sessionId: session.id, taskId: second.id, origin: 'fast_delegation' },
    ]);
    await runFactory.create({
      taskId: unrelated.id,
      status: RunStatus.Running,
    });
    await runFactory.create({
      taskId: first.id,
      status: RunStatus.Running,
    });
    // A newer waiting run supersedes the old running one even though task.state is active.
    const latest = await runFactory.create({
      taskId: first.id,
      status: RunStatus.Idle,
      taskPhase: 'waiting_for_prompt',
    });
    const listUrl = new URL('/tasks', Env.R_APP_URL).toString();
    expect(await resolveSessionRunningTasks(session.id)).toEqual({
      count: 0,
      url: listUrl,
    });

    await db
      .update(taskRuns)
      .set({ taskPhase: 'running' })
      .where(eq(taskRuns.id, latest.id));
    const selected = new URL(`/sessions/${session.id}`, Env.R_APP_URL);
    selected.searchParams.set('task', first.id);
    const context = await resolveThreadReplyFooterContext({
      taskId: second.id,
      prRepo: null,
      prNumber: null,
    });
    expect(context.runningTasks).toEqual({
      count: 1,
      url: selected.toString(),
    });
    expect(context.webAppUrl).toBe(
      new URL(`/sessions/${session.id}`, Env.R_APP_URL).toString(),
    );
    const taskUrl = new URL(`/task/${second.id}`, Env.R_APP_URL);
    taskUrl.search =
      'utm_source=slack&utm_medium=link&utm_campaign=slack.thread_reply';
    expect(
      buildThreadReplyFooterText({ taskUrl: taskUrl.toString(), ...context }),
    ).toBe(
      `_[1 running task](${selected}) · [Web app](${context.webAppUrl}${taskUrl.search}&task=${second.id})_`,
    );
    expect(
      (
        await resolveThreadReplyFooterContext({
          taskId: unrelated.id,
          prRepo: null,
          prNumber: null,
        })
      ).webAppUrl,
    ).toBeUndefined();

    await runFactory.create({ taskId: second.id, status: RunStatus.Running });
    expect(await resolveSessionRunningTasks(session.id)).toEqual({
      count: 2,
      url: listUrl,
    });
    await db
      .update(tasks)
      .set({ deletedAt: new Date() })
      .where(eq(tasks.id, second.id));
    expect(await resolveSessionRunningTasks(session.id)).toEqual({
      count: 1,
      url: selected.toString(),
    });
    await db
      .update(taskRuns)
      .set({ status: RunStatus.Completed })
      .where(eq(taskRuns.id, latest.id));
    expect(await resolveSessionRunningTasks(session.id)).toEqual({
      count: 0,
      url: listUrl,
    });
  });
});
