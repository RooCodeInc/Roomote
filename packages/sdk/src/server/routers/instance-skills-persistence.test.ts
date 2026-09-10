import { randomUUID } from 'node:crypto';
import {
  createCustomSkill,
  deleteCustomSkill,
  updateCustomSkill,
  db,
  eq,
  instanceSkills,
  runFactory,
  taskFactory,
  tasks,
  userFactory,
  users,
} from '@roomote/db/server';
import { RunStatus, TaskPayloadKind } from '@roomote/types';
import { instanceSkillsRouter } from './instance-skills';

it('refreshes actual member-created instance definitions for coding runs without any environment', async () => {
  const member = await userFactory.create({ role: 'member' });
  const task = await taskFactory.create({ initiatorUserId: member.id });
  const run = await runFactory.create({
    taskId: task.id,
    status: RunStatus.Running,
    payloadKind: TaskPayloadKind.StandardTask,
    actingUserId: null,
    payload: { description: 'Instance skill persistence test' },
  });
  let skillId: string | undefined;
  try {
    const caller = instanceSkillsRouter.createCaller({
      auth: {
        runId: run.id,
        userId: null,
        principal: 'deployment',
        tokenType: 'run',
        version: 1,
      },
    });
    const definition = {
      name: `runtime-${randomUUID()}`,
      description: 'Use for runtime persistence testing.',
      content: 'Initial instructions.\n',
    };
    expect(
      (await caller.listForRuntime()).find(
        (skill) => skill.name === definition.name,
      ),
    ).toBeUndefined();
    const created = await createCustomSkill({
      actorUserId: member.id,
      ...definition,
    });
    skillId = created.skillId;
    expect(await caller.listForRuntime()).toContainEqual(definition);
    const updated = { ...definition, content: 'Updated instructions.\n' };
    await updateCustomSkill({ actorUserId: member.id, skillId, ...updated });
    expect(await caller.listForRuntime()).toContainEqual(updated);
    await deleteCustomSkill({ actorUserId: member.id, skillId });
    expect(
      (await caller.listForRuntime()).find(
        (skill) => skill.name === definition.name,
      ),
    ).toBeUndefined();
  } finally {
    if (skillId)
      await db.delete(instanceSkills).where(eq(instanceSkills.id, skillId));
    await db.delete(tasks).where(eq(tasks.id, task.id));
    await db.delete(users).where(eq(users.id, member.id));
  }
});
