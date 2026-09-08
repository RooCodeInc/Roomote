import { randomUUID, createHash } from 'node:crypto';
import {
  CUSTOM_SKILL_MAX_DOCUMENT_BYTES,
  renderManualSkillMarkdown,
} from '@roomote/types';
import {
  db,
  environments,
  users,
  environmentFactory,
  userFactory,
  eq,
  inArray,
} from '../../server';
import { createCustomSkill } from '../custom-skills';

const skill = {
  name: 'review-example',
  description: 'Review examples',
  content: 'Read and review.\n',
};
const environmentIds: string[] = [];
const userIds: string[] = [];
async function user(values = {}) {
  const created = await userFactory.create({ role: 'admin', ...values });
  userIds.push(created.id);
  return created.id;
}
async function environment(values = {}) {
  const created = await environmentFactory.create({
    createdByUserId: userIds[0] ?? (await user()),
    config: {
      name: 'Test',
      repositories: [{ repository: 'example/repo' }],
      description: 'Preserved',
    },
    ...values,
  });
  environmentIds.push(created.id);
  return created.id;
}
async function read(id: string) {
  return (
    await db.select().from(environments).where(eq(environments.id, id))
  )[0]!;
}
afterEach(async () => {
  if (environmentIds.length)
    await db
      .delete(environments)
      .where(inArray(environments.id, environmentIds.splice(0)));
  if (userIds.length)
    await db.delete(users).where(inArray(users.id, userIds.splice(0)));
});

it('persists selected environments, preserves config and invalidates verification through the shared helper', async () => {
  const actorUserId = await user();
  const first = await environment({ isVerified: true });
  const second = await environment();
  const untouched = await environment();
  const before = await read(untouched);
  const result = await createCustomSkill({
    ...skill,
    description: ` ${skill.description} `,
    actorUserId,
    environmentIds: [second, first, first],
  });
  expect(result).toEqual({
    success: true,
    persisted: true,
    name: skill.name,
    environmentIds: [first, second].sort(),
    scope: 'selected_environments',
    skillId: `manual@${skill.name}#${createHash('sha256').update(renderManualSkillMarkdown(skill)).digest('hex').slice(0, 12)}`,
  });
  for (const id of [first, second]) {
    expect((await read(id)).config).toMatchObject({
      name: 'Test',
      description: 'Preserved',
      repositories: [{ repository: 'example/repo' }],
      manualSkills: [skill],
    });
  }
  expect((await read(first)).isVerified).toBe(false);
  expect(await read(untouched)).toEqual(before);
});

it('rejects duplicates across the whole selection without partial writes', async () => {
  const actorUserId = await user();
  const first = await environment();
  const second = await environment();
  await createCustomSkill({ ...skill, actorUserId, environmentIds: [second] });
  const before = await read(first);
  await expect(
    createCustomSkill({
      ...skill,
      actorUserId,
      environmentIds: [first, second],
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(await read(first)).toEqual(before);
});

it('serializes reversed concurrent selections and rejects one duplicate atomically', async () => {
  const actorUserId = await user();
  const first = await environment();
  const second = await environment();
  const results = await Promise.allSettled([
    createCustomSkill({
      ...skill,
      actorUserId,
      environmentIds: [first, second],
    }),
    createCustomSkill({
      ...skill,
      actorUserId,
      environmentIds: [second, first],
    }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({
    reason: { status: 409 },
  });
  expect((await read(first)).config.manualSkills).toEqual([skill]);
  expect((await read(second)).config.manualSkills).toEqual([skill]);
});

it('does not lose distinct concurrent skill additions', async () => {
  const actorUserId = await user();
  const id = await environment();
  await Promise.all(
    ['first-skill', 'second-skill'].map((name) =>
      createCustomSkill({ ...skill, name, actorUserId, environmentIds: [id] }),
    ),
  );
  expect((await read(id)).config.manualSkills?.map((s) => s.name)).toEqual([
    'first-skill',
    'second-skill',
  ]);
});

it('denies member, deleted admin, nonexistent admin and absent identity', async () => {
  const id = await environment();
  for (const actorUserId of [
    await user({ role: 'member' }),
    await user({ deletedAt: new Date() }),
    randomUUID(),
    '',
  ]) {
    await expect(
      createCustomSkill({ ...skill, actorUserId, environmentIds: [id] }),
    ).rejects.toMatchObject({ status: 403 });
  }
  expect((await read(id)).config.manualSkills).toBeUndefined();
});

it('rejects private, eval and unknown selections without affecting valid environments', async () => {
  const actorUserId = await user();
  const valid = await environment();
  const privateId = await environment({ userId: actorUserId });
  const evalId = await environment({ isEval: true });
  for (const invalid of [privateId, evalId, randomUUID()]) {
    await expect(
      createCustomSkill({
        ...skill,
        actorUserId,
        environmentIds: [valid, invalid],
      }),
    ).rejects.toMatchObject({ status: 400 });
  }
  for (const id of [valid, privateId, evalId])
    expect((await read(id)).config.manualSkills).toBeUndefined();
});

it('validates scope, slug, empty instructions and rendered UTF-8 byte bound', async () => {
  const actorUserId = await user();
  const id = await environment();
  for (const override of [
    { environmentIds: [] },
    { environmentIds: ['__all_repositories__'] },
    { name: '../bad' },
    { content: ' ' },
    { description: '' },
    { content: 'é'.repeat(CUSTOM_SKILL_MAX_DOCUMENT_BYTES / 2) },
  ]) {
    await expect(
      createCustomSkill({
        ...skill,
        actorUserId,
        environmentIds: [id],
        ...override,
      }),
    ).rejects.toThrow();
  }
  expect((await read(id)).config.manualSkills).toBeUndefined();
});
