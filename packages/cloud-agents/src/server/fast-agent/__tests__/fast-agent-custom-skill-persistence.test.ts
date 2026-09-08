import {
  createCustomSkill,
  db,
  environmentFactory,
  environments,
  eq,
  inArray,
  userFactory,
  users,
} from '@roomote/db/server';
import { renderManualSkillMarkdown } from '@roomote/types';
import { RemoteFastAgentSettingsSkillSource } from '../fast-agent-settings-skill-source';
import { FastAgentSkillStore } from '../fast-agent-skill-store';

it('discovers a persisted custom skill on a repeated list in the same Fast store and keeps scope and precedence', async () => {
  const admin = await userFactory.create({ role: 'admin' });
  const environmentIds: string[] = [];
  let store: FastAgentSkillStore | undefined;
  let isolatedStore: FastAgentSkillStore | undefined;
  try {
    for (let index = 0; index < 3; index++) {
      const environment = await environmentFactory.create({
        createdByUserId: admin.id,
        config: {
          name: `Skill persistence ${index}`,
          repositories: [{ repository: 'example/repo' }],
        },
      });
      environmentIds.push(environment.id);
    }
    const selected = environmentIds.slice(0, 2);
    store = new FastAgentSkillStore(
      undefined,
      undefined,
      new RemoteFastAgentSettingsSkillSource({
        allowedEnvironmentIds: selected,
      }),
    );
    isolatedStore = new FastAgentSkillStore(
      undefined,
      undefined,
      new RemoteFastAgentSettingsSkillSource({
        allowedEnvironmentIds: [environmentIds[2]!],
      }),
    );
    const skill = {
      name: 'example-release-checklist',
      description: 'Use when reviewing an example release.',
      content: 'Check tests and report risks.\n',
    };
    expect((await store.list({ name: skill.name })).skills).toEqual([]);
    const result = await createCustomSkill({
      actorUserId: admin.id,
      ...skill,
      environmentIds: selected,
    });
    expect(result.persisted).toBe(true);
    const catalog = await store.list();
    const matches = catalog.skills.filter((entry) => entry.name === skill.name);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      source: 'settings',
      invocation: skill.name,
      environmentIds: [...selected].sort(),
    });
    expect(matches[0]!.id).not.toBe(result.skillId);
    await expect(store.read(matches[0]!.id)).resolves.toMatchObject({
      content: renderManualSkillMarkdown(skill),
      source: 'settings',
    });
    expect((await isolatedStore.list({ name: skill.name })).skills).toEqual([]);
    await expect(isolatedStore.read(matches[0]!.id)).rejects.toThrow();

    await createCustomSkill({
      actorUserId: admin.id,
      ...skill,
      name: 'review-code',
      environmentIds: selected,
    });
    expect((await store.list({ name: 'review-code' })).skills).toEqual([
      expect.objectContaining({
        id: 'packaged:review-code',
        source: 'packaged',
      }),
    ]);
  } finally {
    await store?.dispose();
    await isolatedStore?.dispose();
    if (environmentIds.length) {
      await db
        .delete(environments)
        .where(inArray(environments.id, environmentIds));
    }
    await db.delete(users).where(eq(users.id, admin.id));
  }
});
