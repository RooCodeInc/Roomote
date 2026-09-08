import { randomUUID } from 'node:crypto';
import {
  createCustomSkill,
  db,
  environmentFactory,
  environments,
  eq,
  inArray,
  instanceSkills,
  userFactory,
  users,
} from '@roomote/db/server';
import { renderManualSkillMarkdown } from '@roomote/types';
import { RemoteFastAgentInstanceSkillSource } from '../fast-agent-instance-skill-source';
import { RemoteFastAgentSettingsSkillSource } from '../fast-agent-settings-skill-source';
import { FastAgentSkillStore } from '../fast-agent-skill-store';

const userIds: string[] = [];
const environmentIds: string[] = [];
const skillIds: string[] = [];
const stores: FastAgentSkillStore[] = [];

async function member() {
  const user = await userFactory.create({ role: 'member' });
  userIds.push(user.id);
  return user;
}

function storeFor(actorUserId: string, allowedEnvironmentIds?: string[]) {
  const store = new FastAgentSkillStore(
    undefined,
    undefined,
    allowedEnvironmentIds
      ? new RemoteFastAgentSettingsSkillSource({ allowedEnvironmentIds })
      : undefined,
    new RemoteFastAgentInstanceSkillSource(actorUserId),
  );
  stores.push(store);
  return store;
}

async function persist(actorUserId: string, name = `example-${randomUUID()}`) {
  const skill = {
    name,
    description: 'Use when reviewing an example release.',
    content: 'Check tests and report risks.\n',
  };
  const result = await createCustomSkill({ actorUserId, ...skill });
  skillIds.push(result.skillId);
  expect(result).toMatchObject({
    success: true,
    persisted: true,
    name,
    scope: 'instance',
  });
  expect(result.skillId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
  );
  return { skill, skillId: result.skillId };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.dispose()));
  if (skillIds.length) {
    await db.delete(instanceSkills).where(inArray(instanceSkills.id, skillIds));
    skillIds.length = 0;
  }
  if (environmentIds.length) {
    await db
      .delete(environments)
      .where(inArray(environments.id, environmentIds));
    environmentIds.length = 0;
  }
  if (userIds.length) {
    await db.delete(users).where(inArray(users.id, userIds));
    userIds.length = 0;
  }
});

it('refreshes global skills after create, edit and delete in the same store without environments', async () => {
  const actor = await member();
  const otherMember = await member();
  const store = storeFor(actor.id);
  const name = `example-${randomUUID()}`;
  expect((await store.list({ name })).skills).toEqual([]);

  const { skill, skillId } = await persist(actor.id, name);
  const { skills, counts } = await store.list({ name });
  expect(counts).toEqual({
    instance: 1,
    packaged: 0,
    settings: 0,
    repository: 0,
    total: 1,
  });
  expect(skills).toEqual([
    expect.objectContaining({ name, invocation: name, source: 'instance' }),
  ]);
  const id = skills[0]!.id;
  expect(skills[0]!.environmentIds).toBeUndefined();
  await expect(store.read(id)).resolves.toMatchObject({
    content: renderManualSkillMarkdown(skill),
    source: 'instance',
  });

  // A different active member can load by ID without first listing the skill.
  const otherStore = storeFor(otherMember.id);
  await expect(otherStore.read(id)).resolves.toMatchObject({
    content: renderManualSkillMarkdown(skill),
  });
  expect((await otherStore.list({ name })).skills).toEqual(skills);
  for (const scope of [
    { environmentId: randomUUID() },
    { repositoryId: randomUUID() },
  ]) {
    expect((await store.list({ ...scope, name })).skills).toEqual(skills);
  }

  const edited = {
    ...skill,
    name: `${name}-edited`,
    description: 'Use when reviewing an updated release.',
    content: 'Check the updated tests and deployment risks.\n',
  };
  await db
    .update(instanceSkills)
    .set(edited)
    .where(eq(instanceSkills.id, skillId));
  // Read before relisting to prove loading does not reuse the old document.
  await expect(store.read(id)).resolves.toMatchObject({
    id,
    name: edited.name,
    content: renderManualSkillMarkdown(edited),
  });
  expect((await store.list({ name })).skills).toEqual([]);
  expect((await store.list({ name: edited.name })).skills).toEqual([
    expect.objectContaining({
      id,
      name: edited.name,
      description: edited.description,
    }),
  ]);

  await db.delete(instanceSkills).where(eq(instanceSkills.id, skillId));
  await expect(store.read(id)).rejects.toThrow();
  expect((await store.list({ name: edited.name })).skills).toEqual([]);
  await expect(otherStore.read(id)).rejects.toThrow();
  await expect(store.read(`instance:${randomUUID()}`)).rejects.toThrow();
});

it('keeps packaged skills above globals and globals above legacy environment skills', async () => {
  const actor = await member();
  const { skill, skillId } = await persist(actor.id);
  await persist(actor.id, 'review-code');
  const legacyOnly = { ...skill, name: `${skill.name}-legacy` };
  const environment = await environmentFactory.create({
    createdByUserId: actor.id,
    config: {
      name: 'Legacy skill collision',
      repositories: [{ repository: 'example/repo' }],
      manualSkills: [
        { ...skill, content: 'Legacy instructions must not win.\n' },
        legacyOnly,
        { ...skill, name: 'review-code' },
      ],
    },
  });
  environmentIds.push(environment.id);
  const store = storeFor(actor.id, [environment.id]);
  const catalog = await store.list({ environmentId: environment.id });
  const globals = catalog.skills.filter((entry) => entry.name === skill.name);
  expect(globals).toEqual([
    expect.objectContaining({ source: 'instance', invocation: skill.name }),
  ]);
  await expect(store.read(globals[0]!.id)).resolves.toMatchObject({
    content: renderManualSkillMarkdown(skill),
  });
  expect(
    catalog.skills.filter((entry) => entry.name === 'review-code'),
  ).toEqual([
    expect.objectContaining({ id: 'packaged:review-code', source: 'packaged' }),
  ]);
  expect((await store.list({ name: 'review-code' })).skills).toEqual([
    expect.objectContaining({ id: 'packaged:review-code', source: 'packaged' }),
  ]);
  expect(
    catalog.skills.filter((entry) => entry.name === legacyOnly.name),
  ).toEqual([
    expect.objectContaining({
      source: 'settings',
      environmentIds: [environment.id],
    }),
  ]);

  await db.delete(instanceSkills).where(eq(instanceSkills.id, skillId));
  expect((await store.list({ name: skill.name })).skills).toEqual([
    expect.objectContaining({ source: 'settings' }),
  ]);
});

it('rejects absent, nonexistent and deleted actors, including an already-used store', async () => {
  const actor = await member();
  const { skill } = await persist(actor.id);
  const store = storeFor(actor.id);
  const id = (await store.list({ name: skill.name })).skills[0]!.id;
  await expect(store.read(id)).resolves.toMatchObject({ source: 'instance' });
  await db
    .update(users)
    .set({ deletedAt: new Date() })
    .where(eq(users.id, actor.id));

  for (const unauthorizedStore of [
    store,
    storeFor(''),
    storeFor(randomUUID()),
  ]) {
    await expect(
      unauthorizedStore.list({ name: skill.name }),
    ).rejects.toThrow();
    await expect(unauthorizedStore.read(id)).rejects.toThrow();
  }
});
