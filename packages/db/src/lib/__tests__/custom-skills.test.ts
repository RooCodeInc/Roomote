import { randomUUID } from 'node:crypto';
import { count } from 'drizzle-orm';
import {
  CUSTOM_SKILL_MAX_COUNT,
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
import { instanceSkills } from '../../schema';
import {
  createCustomSkill,
  deleteCustomSkill,
  getCustomSkill,
  listCustomSkills,
  listInstanceSkillDefinitions,
  updateCustomSkill,
} from '../custom-skills';

const userIds: string[] = [];
const environmentIds: string[] = [];
const skillNames: string[] = [];
const skillIds: string[] = [];

function definition() {
  const name = `test-${randomUUID()}`;
  skillNames.push(name);
  return {
    name,
    description: 'Review examples',
    content: 'Read and review.\n',
  };
}

async function user(values: Parameters<typeof userFactory.create>[0] = {}) {
  const created = await userFactory.create({ role: 'member', ...values });
  userIds.push(created.id);
  return created.id;
}

async function create(actorUserId: string, skill = definition()) {
  const result = await createCustomSkill({ ...skill, actorUserId });
  skillIds.push(result.skillId);
  return result;
}

async function read(skillId: string) {
  return (
    await db.select().from(instanceSkills).where(eq(instanceSkills.id, skillId))
  )[0];
}

afterEach(async () => {
  // Track names before requests so even an unexpectedly successful request is cleaned up.
  if (skillNames.length)
    await db
      .delete(instanceSkills)
      .where(inArray(instanceSkills.name, skillNames.splice(0)));
  if (skillIds.length)
    await db
      .delete(instanceSkills)
      .where(inArray(instanceSkills.id, skillIds.splice(0)));
  if (environmentIds.length)
    await db
      .delete(environments)
      .where(inArray(environments.id, environmentIds.splice(0)));
  if (userIds.length)
    await db.delete(users).where(inArray(users.id, userIds.splice(0)));
});

it('lets members create instance skills and exposes full records with actor-specific management rights', async () => {
  const creator = await user();
  const member = await user();
  const admin = await user({ role: 'admin' });
  const skill = definition();
  const result = await create(creator, {
    ...skill,
    description: ` ${skill.description} `,
    content: ' Read and review.\r\n ',
  });
  expect(result).toEqual({
    success: true,
    persisted: true,
    skillId: expect.any(String),
    name: skill.name,
    scope: 'instance',
  });
  const stored = await read(result.skillId);
  expect(stored).toEqual({
    ...skill,
    id: result.skillId,
    createdByUserId: creator,
    createdAt: expect.any(Date),
    updatedAt: expect.any(Date),
  });
  for (const [actor, canManage] of [
    [creator, true],
    [member, false],
    [admin, true],
  ] as const) {
    expect(await getCustomSkill(actor, result.skillId)).toEqual({
      ...stored,
      canManage,
    });
    expect(await listCustomSkills(actor)).toContainEqual({
      ...stored,
      canManage,
    });
  }
  expect(await listInstanceSkillDefinitions()).toContainEqual(skill);
});

it.each(['creator', 'admin'] as const)(
  'allows %s edits and deletion without transferring creator attribution',
  async (manager) => {
    const creator = await user();
    const actorUserId =
      manager === 'creator' ? creator : await user({ role: 'admin' });
    const { skillId } = await create(creator);
    const before = (await read(skillId))!;
    const edited = {
      ...definition(),
      description: 'Updated description',
      content: 'Updated instructions.\n',
    };
    expect(
      await updateCustomSkill({ ...edited, actorUserId, skillId }),
    ).toEqual({
      success: true,
      persisted: true,
      skillId,
      name: edited.name,
      scope: 'instance',
    });
    const after = (await read(skillId))!;
    expect(after).toMatchObject({
      ...edited,
      createdByUserId: creator,
      createdAt: before.createdAt,
    });
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(
      before.updatedAt.getTime(),
    );
    expect(await deleteCustomSkill({ actorUserId, skillId })).toEqual({
      success: true,
    });
    expect(await read(skillId)).toBeUndefined();
  },
);

it('denies noncreator mutations without changing the skill', async () => {
  const { skillId } = await create(await user());
  const actorUserId = await user();
  const before = await read(skillId);
  await expect(
    updateCustomSkill({ ...definition(), actorUserId, skillId }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    deleteCustomSkill({ actorUserId, skillId }),
  ).rejects.toMatchObject({ status: 403 });
  expect(await read(skillId)).toEqual(before);
});

it('denies missing, deleted, and unknown actors at every public helper', async () => {
  const { skillId } = await create(await user());
  const before = await read(skillId);
  for (const actorUserId of [
    '',
    randomUUID(),
    await user({ deletedAt: new Date() }),
    await user({ role: 'admin', deletedAt: new Date() }),
  ]) {
    const skill = definition();
    for (const request of [
      () => createCustomSkill({ ...skill, actorUserId }),
      () => listCustomSkills(actorUserId),
      () => getCustomSkill(actorUserId, skillId),
      () => updateCustomSkill({ ...skill, actorUserId, skillId }),
      () => deleteCustomSkill({ actorUserId, skillId }),
    ])
      await expect(request()).rejects.toMatchObject({ status: 403 });
    expect(
      await db
        .select()
        .from(instanceSkills)
        .where(eq(instanceSkills.name, skill.name)),
    ).toEqual([]);
  }
  expect(await read(skillId)).toEqual(before);
});

it('returns safe 404s for unknown or foreign identifiers without exposing database errors', async () => {
  const actorUserId = await user();
  const environment = await environmentFactory.create({
    createdByUserId: actorUserId,
  });
  environmentIds.push(environment.id);
  for (const skillId of [
    randomUUID(),
    environment.id,
    'manual@legacy#hash',
    '../skill',
    '',
  ]) {
    for (const request of [
      () => getCustomSkill(actorUserId, skillId),
      () => updateCustomSkill({ ...definition(), actorUserId, skillId }),
      () => deleteCustomSkill({ actorUserId, skillId }),
    ])
      await expect(request()).rejects.toMatchObject({
        status: 404,
        message: 'Skill not found',
      });
  }
});

it('persists exactly one concurrent duplicate creation and maps the unique-index error to 409', async () => {
  const actorUserId = await user();
  const skill = definition();
  const results = await Promise.allSettled([
    create(actorUserId, skill),
    create(actorUserId, skill),
  ]);
  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toEqual([
    expect.objectContaining({
      reason: expect.objectContaining({ status: 409 }),
    }),
  ]);
  const stored = await db
    .select()
    .from(instanceSkills)
    .where(eq(instanceSkills.name, skill.name));
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ ...skill, createdByUserId: actorUserId });
});

it('maps concurrent renames onto the same unique name to one success and one 409', async () => {
  const actorUserId = await user();
  const first = await create(actorUserId);
  const second = await create(actorUserId);
  const before = await Promise.all([read(first.skillId), read(second.skillId)]);
  const edited = definition();
  const results = await Promise.allSettled(
    [first, second].map(({ skillId }) =>
      updateCustomSkill({ ...edited, actorUserId, skillId }),
    ),
  );
  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toEqual([
    expect.objectContaining({
      reason: expect.objectContaining({ status: 409 }),
    }),
  ]);
  for (const [index, result] of results.entries()) {
    const stored = await read([first, second][index]!.skillId);
    if (result.status === 'rejected') expect(stored).toEqual(before[index]);
    else
      expect(stored).toMatchObject({ ...edited, createdByUserId: actorUserId });
  }
});

it('accepts exactly 64 KiB of rendered UTF-8 and rejects one byte more on create and update', async () => {
  const actorUserId = await user();
  const skill = definition();
  const overhead =
    Buffer.byteLength(
      renderManualSkillMarkdown({ ...skill, content: 'x' }),
      'utf8',
    ) - 1;
  const available = CUSTOM_SKILL_MAX_DOCUMENT_BYTES - overhead;
  const content =
    '\u00e9'.repeat(Math.floor(available / 2)) + 'x'.repeat(available % 2);
  expect(
    Buffer.byteLength(renderManualSkillMarkdown({ ...skill, content }), 'utf8'),
  ).toBe(CUSTOM_SKILL_MAX_DOCUMENT_BYTES);
  const { skillId } = await create(actorUserId, { ...skill, content });
  expect((await read(skillId))!.content).toBe(`${content}\n`);
  await expect(
    updateCustomSkill({ ...skill, content, actorUserId, skillId }),
  ).resolves.toMatchObject({ success: true });
  const before = await read(skillId);
  await expect(
    updateCustomSkill({
      ...skill,
      content: `${content}x`,
      actorUserId,
      skillId,
    }),
  ).rejects.toThrow('64 KiB');
  await expect(
    createCustomSkill({ ...definition(), content: `${content}x`, actorUserId }),
  ).rejects.toThrow('64 KiB');
  expect(await read(skillId)).toEqual(before);
});

it('strictly rejects scope and creator injection on create, update, and delete', async () => {
  const actorUserId = await user();
  const { skillId } = await create(actorUserId);
  const before = await read(skillId);
  for (const extra of [
    { environmentIds: [randomUUID()] },
    { environmentId: randomUUID() },
    { workspaceId: randomUUID() },
    { createdByUserId: await user() },
    { scope: 'environment' },
  ]) {
    await expect(
      createCustomSkill({ ...definition(), actorUserId, ...extra }),
    ).rejects.toThrow();
    await expect(
      updateCustomSkill({ ...definition(), actorUserId, skillId, ...extra }),
    ).rejects.toThrow();
    await expect(
      deleteCustomSkill({ actorUserId, skillId, ...extra }),
    ).rejects.toThrow();
  }
  expect(await read(skillId)).toEqual(before);
});

it.each([
  '.',
  '..',
  '.hidden',
  'has.dot',
  '../bad',
  'path/name',
  'path\\name',
  'Uppercase',
  'under_score',
  '-leading',
  'trailing-',
  'double--dash',
])('rejects unsafe or non-slug name %s', async (name) => {
  const actorUserId = await user();
  await expect(
    createCustomSkill({ ...definition(), name, actorUserId }),
  ).rejects.toThrow();
});

it('serializes concurrent distinct creates at 127 and never exceeds the instance cap', async (context) => {
  const actorUserId = await user();
  const [initial] = await db.select({ value: count() }).from(instanceSkills);
  const initialCount = initial!.value;
  if (initialCount >= CUSTOM_SKILL_MAX_COUNT) {
    context.skip();
    return;
  }
  const fillers = Array.from(
    { length: CUSTOM_SKILL_MAX_COUNT - 1 - initialCount },
    () => ({ ...definition(), createdByUserId: actorUserId }),
  );
  if (fillers.length) await db.insert(instanceSkills).values(fillers);
  const results = await Promise.allSettled([
    create(actorUserId),
    create(actorUserId),
  ]);
  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toEqual([
    expect.objectContaining({
      reason: expect.objectContaining({
        status: 409,
        message: expect.stringContaining('limit'),
      }),
    }),
  ]);
  expect(
    (await db.select({ value: count() }).from(instanceSkills))[0]!.value,
  ).toBe(CUSTOM_SKILL_MAX_COUNT);
  await expect(create(actorUserId)).rejects.toMatchObject({ status: 409 });
  expect(
    (await db.select({ value: count() }).from(instanceSkills))[0]!.value,
  ).toBe(CUSTOM_SKILL_MAX_COUNT);
});

it('leaves legacy environment configurations and verification untouched through instance CRUD', async () => {
  const actorUserId = await user();
  const skill = definition();
  const environment = await environmentFactory.create({
    createdByUserId: actorUserId,
    isVerified: true,
    config: {
      name: 'Legacy environment',
      repositories: [{ repository: 'example/repo' }],
      manualSkills: [skill],
      description: 'Preserve this configuration',
    },
  });
  environmentIds.push(environment.id);
  const before = (
    await db
      .select()
      .from(environments)
      .where(eq(environments.id, environment.id))
  )[0];
  const { skillId } = await create(actorUserId, skill);
  await updateCustomSkill({ ...definition(), actorUserId, skillId });
  await deleteCustomSkill({ actorUserId, skillId });
  expect(
    (
      await db
        .select()
        .from(environments)
        .where(eq(environments.id, environment.id))
    )[0],
  ).toEqual(before);
});

it('sets creator attribution to null on hard deletion and retains admin management', async () => {
  const creator = await user();
  const admin = await user({ role: 'admin' });
  const member = await user();
  const { skillId } = await create(creator);
  await db.delete(users).where(eq(users.id, creator));
  expect(await read(skillId)).toMatchObject({ createdByUserId: null });
  expect(await getCustomSkill(member, skillId)).toMatchObject({
    createdByUserId: null,
    canManage: false,
  });
  expect(await getCustomSkill(admin, skillId)).toMatchObject({
    createdByUserId: null,
    canManage: true,
  });
  await expect(
    updateCustomSkill({ ...definition(), actorUserId: member, skillId }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    deleteCustomSkill({ actorUserId: member, skillId }),
  ).rejects.toMatchObject({ status: 403 });
  await updateCustomSkill({ ...definition(), actorUserId: admin, skillId });
  expect(await read(skillId)).toMatchObject({ createdByUserId: null });
  await deleteCustomSkill({ actorUserId: admin, skillId });
  expect(await read(skillId)).toBeUndefined();
});
